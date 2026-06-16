/* ============================================================
   AG Lex — HelpTip: training-mode tooltip primitive.

   Wraps a single child. When `training` mode is OFF, renders the child
   unmodified with ZERO listeners attached — true no-op so we can sprinkle
   <HelpTip> across the app without paying the runtime cost when the user
   hasn't opted in.

   When ON:
   - Hover → after `delayMs` shows a positioned bubble.
   - DEFAULT placement="cursor" — bubble follows the mouse pointer with
     a small offset. Re-aimed on every mouse move so the explanation
     stays right where the user is looking instead of pinned to a corner.
   - placement="below"/"above" anchors the bubble to the FIRST CHILD
     element's bounding rect — used for keyboard focus and for layouts
     where cursor-following would feel jittery (e.g. dense nav items).
   - Auto-flips top↔bottom + clamps to the viewport on both axes so the
     bubble never goes off-screen.

   Why measure firstElementChild and not the wrap span:
   - The wrap uses `display: contents` so its own bounding rect is
     effectively zero (the spec leaves the value implementation-defined
     but every major engine returns ~0 here). Reading the wrap's rect
     was the original "tooltip flies to the corner" bug. The actual
     visible element is `wrapRef.current.firstElementChild`.

   Reads `t.training` via a shared cache + a `tweakchange` window event
   the TweaksPanel hook dispatches when setTweak fires — so the toggle
   takes effect instantly without prop-drilling through every screen.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';

// Local cache of the training setting. Updated via a 'tweakchange' window
// CustomEvent the TweaksPanel dispatches when useTweaks.setTweak fires.
let _trainingCached = false;
const _subscribers = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('tweakchange', (e) => {
    const edits = e && e.detail;
    if (!edits || !Object.prototype.hasOwnProperty.call(edits, 'training')) return;
    _trainingCached = !!edits.training;
    _subscribers.forEach((fn) => { try { fn(_trainingCached); } catch (_) {} });
  });
}

function useTrainingMode() {
  const [on, setOn] = useState(_trainingCached);
  useEffect(() => {
    _subscribers.add(setOn);
    // Sync once on mount in case the cache changed before this component
    // subscribed (e.g. App.jsx called seedTrainingMode before this mounts).
    setOn(_trainingCached);
    return () => { _subscribers.delete(setOn); };
  }, []);
  return on;
}

/** Public helper for parents that want to seed the training state at
 *  startup (e.g. App.jsx hydrating from persisted TWEAK_DEFAULTS).
 *  Idempotent; subscribers re-render with the new value. */
export function seedTrainingMode(value) {
  if (_trainingCached === !!value) return;
  _trainingCached = !!value;
  _subscribers.forEach((fn) => { try { fn(_trainingCached); } catch (_) {} });
}

// Bubble sizing for clamping math. Approximate; the actual rect is
// measured post-render via offsetWidth/Height in reposition().
const VIEWPORT_PAD = 12;        // keep this far from edges
const CURSOR_OFFSET_X = 14;
const CURSOR_OFFSET_Y = 18;     // below cursor by default
const CURSOR_OFFSET_Y_ABOVE = 14;
const ELEMENT_GAP = 10;         // gap between element and bubble in below/above modes

export function HelpTip({ text, placement = 'cursor', delayMs = 220, children }) {
  const training = useTrainingMode();
  const wrapRef = useRef(null);
  const bubbleRef = useRef(null);
  const timerRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, valid: false });
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, placement: 'below' });

  /** Resolve the actual visible bounding rect. Falls back through:
   *  1. firstElementChild's rect (works with display:contents wrap)
   *  2. wrap's own rect (in case child is a text node)
   *  3. null (caller falls back to cursor) */
  const childRect = () => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const child = wrap.firstElementChild;
    if (child) return child.getBoundingClientRect();
    const r = wrap.getBoundingClientRect();
    return (r.width || r.height) ? r : null;
  };

  const reposition = useCallback(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top, left, pl;

    if (placement === 'cursor' && mouseRef.current.valid) {
      // Default: bubble follows the cursor. Below-right by default,
      // flip vertical when near bottom edge, horizontal when near right edge.
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;
      const wantsAbove = my + CURSOR_OFFSET_Y + bh + VIEWPORT_PAD > vh;
      top = wantsAbove ? my - CURSOR_OFFSET_Y_ABOVE - bh : my + CURSOR_OFFSET_Y;
      pl = wantsAbove ? 'above' : 'below';
      left = mx + CURSOR_OFFSET_X;
      if (left + bw + VIEWPORT_PAD > vw) left = mx - CURSOR_OFFSET_X - bw;
    } else {
      // Element-anchored: place above (default) or below the child rect.
      const rect = childRect();
      if (!rect) return;
      const wantsAbove = placement === 'above' || placement === 'top';
      const fitsAbove = rect.top - bh - ELEMENT_GAP > VIEWPORT_PAD;
      const fitsBelow = rect.bottom + bh + ELEMENT_GAP < vh - VIEWPORT_PAD;
      pl = wantsAbove && fitsAbove ? 'above' : fitsBelow ? 'below' : 'above';
      top = pl === 'above'
        ? rect.top - bh - ELEMENT_GAP
        : rect.bottom + ELEMENT_GAP;
      left = rect.left + (rect.width - bw) / 2;
    }

    // Final clamp on both axes — never let the bubble escape the viewport.
    left = Math.max(VIEWPORT_PAD, Math.min(vw - bw - VIEWPORT_PAD, left));
    top = Math.max(VIEWPORT_PAD, Math.min(vh - bh - VIEWPORT_PAD, top));

    setPos({ top, left, placement: pl });
  }, [placement]);

  // Reposition while open: on resize, on scroll (capture so we catch
  // nested scrollers too), and on every mouse move when in cursor mode.
  useEffect(() => {
    if (!open) return;
    reposition();
    const onResize = () => reposition();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, reposition]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!training || !text) return children;

  const onEnter = (e) => {
    mouseRef.current = { x: e.clientX, y: e.clientY, valid: true };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), delayMs);
  };
  const onMove = (e) => {
    mouseRef.current = { x: e.clientX, y: e.clientY, valid: true };
    if (open && placement === 'cursor') reposition();
  };
  const onLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
  };
  const onFocus = () => {
    // Keyboard focus → can't follow cursor, anchor to element instead.
    mouseRef.current = { x: 0, y: 0, valid: false };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), delayMs);
  };

  return (
    <>
      <span
        ref={wrapRef}
        className="helptip-wrap"
        onMouseEnter={onEnter}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onFocusCapture={onFocus}
        onBlurCapture={onLeave}
      >
        {children}
      </span>
      {open ? (
        <span
          ref={bubbleRef}
          role="tooltip"
          className={'helptip-bubble helptip-' + pos.placement}
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </span>
      ) : null}
    </>
  );
}
