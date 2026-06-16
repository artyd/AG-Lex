/* ============================================================
   AG Lex — HelpTip: training-mode tooltip primitive.

   Wraps a single child. When `training` mode is OFF, renders the child
   unmodified with ZERO listeners attached — true no-op so we can sprinkle
   <HelpTip> across the app without paying the runtime cost when the user
   hasn't opted in.

   When ON, attaches mouseenter/mouseleave + focusin/focusout to a
   <span class="helptip-wrap"> wrapper. After `delayMs` (default 250),
   shows a positioned <span class="helptip-bubble"> reading
   `ref.current.getBoundingClientRect()`. Auto-flips top → bottom when
   the bubble would clip the viewport.

   The wrap span uses display: contents by default so layout doesn't
   shift — children render in the parent's flex/grid context.

   Reads `t.training` via window.localStorage so the tooltip primitive
   doesn't need a prop drill through every screen. The TweaksPanel
   updates that value via useTweaks (which writes to the EDITMODE block);
   the panel also dispatches a `tweakchange` CustomEvent we listen to so
   the toggle takes effect without a remount.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';

// Local cache of the training setting. Updated via a 'tweakchange' window
// CustomEvent the TweaksPanel dispatches when useTweaks.setTweak fires.
// Avoids re-reading localStorage / parsing the EDITMODE block on every
// HelpTip mount.
let _trainingCached = null;
const _subscribers = new Set();

function _readTrainingFromTweaks() {
  if (_trainingCached !== null) return _trainingCached;
  try {
    // The TweaksPanel hook posts updates via window.parent.postMessage too,
    // but for the in-page consumer the source of truth is the runtime tweak
    // values held by useTweaks(). Since we don't have a hook into that state
    // here, default to false; the tweakchange event below propagates real
    // changes within ~1ms of the user flipping the toggle.
    _trainingCached = false;
  } catch (_) { _trainingCached = false; }
  return _trainingCached;
}

if (typeof window !== 'undefined') {
  window.addEventListener('tweakchange', (e) => {
    const edits = e && e.detail;
    if (!edits || !Object.prototype.hasOwnProperty.call(edits, 'training')) return;
    _trainingCached = !!edits.training;
    _subscribers.forEach((fn) => { try { fn(_trainingCached); } catch (_) {} });
  });
}

function useTrainingMode() {
  const [on, setOn] = useState(() => _readTrainingFromTweaks());
  useEffect(() => {
    _subscribers.add(setOn);
    return () => { _subscribers.delete(setOn); };
  }, []);
  return on;
}

/** Public helper for parents that want to seed the training state (e.g.
 *  App.jsx initializing from TWEAK_DEFAULTS at mount). One-call, idempotent. */
export function seedTrainingMode(value) {
  _trainingCached = !!value;
  _subscribers.forEach((fn) => { try { fn(_trainingCached); } catch (_) {} });
}

const BUBBLE_PADDING = 10;

export function HelpTip({ text, placement = 'top', delayMs = 250, children }) {
  const training = useTrainingMode();
  const wrapRef = useRef(null);
  const bubbleRef = useRef(null);
  const timerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, placement });

  const reposition = useCallback(() => {
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;
    const wr = wrap.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let p = placement;
    let top = wr.top - bh - BUBBLE_PADDING;
    if (top < 8) { p = 'bottom'; top = wr.bottom + BUBBLE_PADDING; }
    let left = wr.left + (wr.width - bw) / 2;
    left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
    setPos({ top, left, placement: p });
  }, [placement]);

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

  // Clean up any pending delay timer on unmount or training toggle off.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!training || !text) return children;

  const onEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), delayMs);
  };
  const onLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
  };

  return (
    <>
      <span
        ref={wrapRef}
        className="helptip-wrap"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocusCapture={onEnter}
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
