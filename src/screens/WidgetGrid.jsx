/* ============================================================
   AG Lex — Dashboard widget grid (full-area canvas)
   Cell size is large and fixed (~110–130px). Cols/rows = however
   many large square cells fit into the dashboard content area.
   The grid fills the entire stage — no empty fields on the right
   or bottom. Widgets can be dragged by the body to move, and by
   corners/edges to resize. Both snap to the grid.
   ============================================================ */
import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { Icon } from '../ui/Icon';
import { Modal, toast } from '../ui/components';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';

const GAP = 4;
const CELL_TARGET = 120;
const CELL_MIN = 110;
const CELL_MAX = 130;
const DRAG_THRESHOLD = 5; // pixels before a body-click becomes a body-drag
const STORAGE_KEY = 'aglex_dashboard_widgets';
const NOTES_KEY = 'aglex_dashboard_widget_notes';

const WIDGETS = [
  { type: 'court_calendar', icon: 'calendar', tone: 'high', route: 'calendar' },
  { type: 'tasks',          icon: 'check',    tone: 'med',  route: 'calendar' },
  { type: 'matters',        icon: 'folder',   tone: 'info', route: 'matters' },
  { type: 'statutes',       icon: 'alert',    tone: 'high', route: 'litigation' },
  { type: 'docs',           icon: 'doc',      tone: 'accent', route: 'library' },
  { type: 'clients',        icon: 'clients',  tone: 'info', route: 'clients' },
  { type: 'notes',          icon: 'pen',      tone: 'accent', route: null },
  { type: 'legal_search',   icon: 'scales',   tone: 'info', route: 'legal' },
  { type: 'templates',      icon: 'templates', tone: 'accent', route: 'templates' },
  { type: 'meetings',       icon: 'chat',     tone: 'info', route: 'calendar' },
  { type: 'analytics',      icon: 'sparkle',  tone: 'accent', route: 'matters' },
  { type: 'reminders',      icon: 'bell',     tone: 'med',  route: 'calendar' },
  { type: 'legal_feed',     icon: 'book',     tone: 'info', route: 'legal' },
];

const TONE = {
  high:   { bg: 'var(--risk-high-soft)', fg: 'var(--risk-high)' },
  med:    { bg: 'var(--risk-med-soft)',  fg: 'var(--risk-med)' },
  info:   { bg: 'var(--info-soft)',      fg: 'var(--info)' },
  accent: { bg: 'var(--accent-soft)',    fg: 'var(--accent)' },
};

/* ---------- occupancy + placement helpers ---------- */
function buildOccupancy(widgets, cols, rows) {
  const m = Array.from({ length: rows }, () => Array(cols).fill(null));
  for (const w of widgets) {
    for (let r = w.y; r < w.y + w.h && r < rows; r++) {
      for (let c = w.x; c < w.x + w.w && c < cols; c++) {
        if (r >= 0 && c >= 0) m[r][c] = w.id;
      }
    }
  }
  return m;
}

function canPlace(occ, cols, rows, x, y, w, h) {
  if (x < 0 || y < 0 || w < 1 || h < 1) return false;
  if (x + w > cols || y + h > rows) return false;
  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      if (occ[r][c]) return false;
    }
  }
  return true;
}

/* Scan a (cols × rows) occupancy map for the first free w × h rectangle in
   reading order. Returns null when the grid is full. */
function findFreeSlot(occ, cols, rows, w, h) {
  if (w > cols || h > rows) return null;
  for (let y = 0; y <= rows - h; y++) {
    for (let x = 0; x <= cols - w; x++) {
      let free = true;
      for (let r = y; r < y + h && free; r++) {
        for (let c = x; c < x + w && free; c++) {
          if (occ[r][c]) free = false;
        }
      }
      if (free) return { x, y };
    }
  }
  return null;
}

/* Re-place every widget into the new (cols × rows) grid, preserving order
   and never overlapping. Each widget is tried at its saved position first;
   if it would collide or fall out of bounds, the next free slot is used.
   Widgets are processed top-to-bottom, left-to-right so spatial layout
   reads predictably after a resize.

   The previous `fitWidget(w, cols, rows)` only clamped a single widget into
   bounds without knowing about other widgets — two widgets at different
   valid positions could collapse onto the same cells after the layout
   shrank, which is what users were seeing on re-login when localStorage
   restored positions saved on a larger grid. */
function reflowWidgets(widgets, cols, rows) {
  if (!widgets || widgets.length === 0 || cols < 1 || rows < 1) return widgets || [];
  const ordered = [...widgets].sort(
    (a, b) => (a.y - b.y) || (a.x - b.x)
  );
  const occ = Array.from({ length: rows }, () => Array(cols).fill(null));
  const out = [];
  for (const w of ordered) {
    const ww = Math.max(1, Math.min(w.w, cols));
    const wh = Math.max(1, Math.min(w.h, rows));
    let x = Math.max(0, Math.min(cols - ww, w.x));
    let y = Math.max(0, Math.min(rows - wh, w.y));
    if (!canPlace(occ, cols, rows, x, y, ww, wh)) {
      const spot = findFreeSlot(occ, cols, rows, ww, wh);
      if (!spot) {
        // Grid genuinely has no room for this widget at its smallest fit.
        // Drop it rather than letting it overlap; user can re-add later.
        continue;
      }
      x = spot.x;
      y = spot.y;
    }
    for (let r = y; r < y + wh; r++) {
      for (let c = x; c < x + ww; c++) occ[r][c] = w.id;
    }
    out.push({ ...w, x, y, w: ww, h: wh });
  }
  return out;
}

/* Pick (cols, rows, cell) such that the grid fills the stage as fully as
   possible while every cell remains a square in [CELL_MIN, CELL_MAX]. We
   iterate the small (cols × rows) candidate space and pick the layout
   with the least wasted area. Result: tight square cells, ~120px each,
   filling the area edge-to-edge with at most a few px of margin. */
function computeLayout(W, H) {
  if (W < 100 || H < 100) return null;
  let best = null;
  const cMin = Math.max(1, Math.floor((W + GAP) / (CELL_MAX + GAP)));
  const cMax = Math.max(cMin, Math.ceil((W + GAP) / (CELL_MIN + GAP)));
  const rMin = Math.max(1, Math.floor((H + GAP) / (CELL_MAX + GAP)));
  const rMax = Math.max(rMin, Math.ceil((H + GAP) / (CELL_MIN + GAP)));
  for (let c = cMin; c <= cMax; c++) {
    for (let r = rMin; r <= rMax; r++) {
      const cellW = (W - (c - 1) * GAP) / c;
      const cellH = (H - (r - 1) * GAP) / r;
      const cell = Math.min(cellW, cellH);
      if (cell < CELL_MIN || cell > CELL_MAX) continue;
      const wasteW = W - (c * cell + (c - 1) * GAP);
      const wasteH = H - (r * cell + (r - 1) * GAP);
      const waste = wasteW + wasteH;
      if (!best || waste < best.waste) best = { cols: c, rows: r, cell, waste };
    }
  }
  if (best) return { cols: best.cols, rows: best.rows, cell: Math.floor(best.cell) };
  // Fallback when the area is unusually shaped — relax constraints
  const cols = Math.max(1, Math.round((W + GAP) / (CELL_TARGET + GAP)));
  const rows = Math.max(1, Math.round((H + GAP) / (CELL_TARGET + GAP)));
  const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(Math.min(
    (W - (cols - 1) * GAP) / cols,
    (H - (rows - 1) * GAP) / rows
  ))));
  return { cols, rows, cell };
}

/* ---------- widget body content ---------- */
function StatBlock({ value, label }) {
  return (
    <div className="wg-stat">
      <span className="wg-stat-v">{value}</span>
      <span className="wg-stat-l">{label}</span>
    </div>
  );
}

function WidgetBody({ widget, t }) {
  const big = widget.w >= 2 && widget.h >= 2;
  const wide = widget.w >= 3 && widget.h >= 2;
  const huge = (widget.w >= 3 && widget.h >= 3) || (widget.w >= 4);

  switch (widget.type) {
    case 'court_calendar': {
      const items = DEMO.tasks.filter(k => k.type === 'meeting' || k.type === 'review' || k.type === 'deadline').slice(0, huge ? 5 : 3);
      const next = items[0];
      return (
        <>
          {big && <StatBlock value={DEMO.tasks.length} label={t.wg_court_calendar_lbl} />}
          {!big && next && (
            <div className="wg-mini">{new Date(next.date).getDate()}</div>
          )}
          {wide && (
            <ul className="wg-list">
              {items.map(it => (
                <li key={it.id} className="wg-row">
                  <span className="wg-row-date">{new Date(it.date).toLocaleDateString(t.locale, { day: '2-digit', month: 'short' })}</span>
                  <span className="wg-row-t">{it.title}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'tasks': {
      const open = (LX.tasks || []).filter(k => k.col !== 'done');
      const high = open.filter(k => k.priority === 'high').length;
      return (
        <>
          {big && <StatBlock value={open.length} label={t.wg_tasks_open} />}
          {big && <div className="wg-sub">{t.prioHigh}: <b>{high}</b></div>}
          {huge && (
            <ul className="wg-list">
              {open.slice(0, 3).map(k => (
                <li key={k.id} className="wg-row">
                  <span className="chip-dot" style={{ background: k.priority === 'high' ? 'var(--risk-high)' : k.priority === 'med' ? 'var(--risk-med)' : 'var(--risk-low)' }} />
                  <span className="wg-row-t">{k.title}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'timer': {
      return (
        <>
          {big && <div className="wg-clock">02:14:36</div>}
          {big && <div className="wg-sub">{t.wg_timer_today}: <b>5,2 {t.mHours}</b></div>}
          {wide && <div className="wg-sub">{t.weekTotal}: <b>21,8 {t.mHours}</b></div>}
        </>
      );
    }
    case 'matters': {
      const items = (LX.matters || []).slice(0, huge ? 4 : 2);
      return (
        <>
          {big && <StatBlock value={(LX.matters || []).length} label={t.wg_matters_active} />}
          {wide && (
            <ul className="wg-list">
              {items.map(m => (
                <li key={m.id} className="wg-row">
                  <span className="wg-row-code">{m.code}</span>
                  <span className="wg-row-t">{m.title}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'statutes': {
      const soon = DEMO.tasks.filter(k => k.risk === 'high').length;
      return (
        <>
          {big && <StatBlock value={soon} label={t.wg_statutes_soon} />}
          {big && <div className="wg-sub" style={{ color: 'var(--risk-high)' }}>{t.wg_statutes_warn}</div>}
        </>
      );
    }
    case 'docs': {
      const items = (DEMO.library || []).slice(0, huge ? 4 : 3);
      return (
        <>
          {big && <StatBlock value={(DEMO.library || []).length} label={t.wg_docs_total} />}
          {wide && (
            <ul className="wg-list">
              {items.map(d => (
                <li key={d.id} className="wg-row">
                  <Icon name="doc" size={11} />
                  <span className="wg-row-t">{d.name}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'clients': {
      const items = (DEMO.clients || []).slice(0, huge ? 5 : 3);
      return (
        <>
          {big && <StatBlock value={(DEMO.clients || []).length} label={t.wg_clients_total} />}
          {wide && (
            <ul className="wg-list">
              {items.map(c => (
                <li key={c.id} className="wg-row">
                  <span className="wg-av" style={{ background: `oklch(0.58 0.14 ${c.color})` }}>{c.name.charAt(0)}</span>
                  <span className="wg-row-t">{c.name}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'invoices': {
      const unpaid = '128 400 ₴';
      return (
        <>
          {big && <StatBlock value={3} label={t.wg_invoices_unpaid} />}
          {big && <div className="wg-sub" style={{ color: 'var(--risk-med)', fontWeight: 700 }}>{unpaid}</div>}
          {wide && <div className="wg-sub">{t.wg_invoices_overdue}: <b>1</b></div>}
        </>
      );
    }
    case 'notes': {
      let saved = '';
      try { saved = localStorage.getItem(NOTES_KEY + '_' + widget.id) || ''; } catch (_e) {}
      if (!big) return null;
      return (
        <textarea
          className="wg-notes"
          placeholder={t.wg_notes_ph}
          defaultValue={saved}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { try { localStorage.setItem(NOTES_KEY + '_' + widget.id, e.target.value); } catch (_e) {} }}
        />
      );
    }
    case 'legal_search': {
      if (!big) return null;
      return (
        <div className="wg-search-mini" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <Icon name="search" size={12} />
          <input placeholder={t.legalPlaceholder} />
        </div>
      );
    }
    case 'templates': {
      const items = (DEMO.templates || []).sort((a, b) => b.uses - a.uses).slice(0, huge ? 4 : 2);
      return (
        <>
          {big && <StatBlock value={(DEMO.templates || []).length} label={t.wg_tpl_total} />}
          {wide && (
            <ul className="wg-list">
              {items.map(tp => (
                <li key={tp.id} className="wg-row">
                  <span className="wg-row-code">{tp.uses}</span>
                  <span className="wg-row-t">{tp.name}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'meetings': {
      const items = DEMO.tasks.filter(k => k.type === 'meeting').slice(0, huge ? 3 : 2);
      return (
        <>
          {big && <StatBlock value={items.length || 1} label={t.wg_meet_today} />}
          {wide && items.length > 0 && (
            <ul className="wg-list">
              {items.map(it => (
                <li key={it.id} className="wg-row">
                  <span className="wg-row-date">{new Date(it.date).toLocaleDateString(t.locale, { day: '2-digit', month: 'short' })}</span>
                  <span className="wg-row-t">{it.client}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'analytics': {
      return (
        <>
          {big && <StatBlock value="78%" label={t.wg_analytics_won} />}
          {big && <div className="wg-sub">{t.wg_analytics_avg}: <b>3,2 {t.wg_analytics_months}</b></div>}
          {wide && (
            <div className="wg-bars">
              {[60, 80, 45, 90, 70].map((v, i) => (
                <span key={i} className="wg-bar" style={{ height: v + '%' }} />
              ))}
            </div>
          )}
        </>
      );
    }
    case 'reminders': {
      const items = [
        { id: 'r1', t: t.wg_rem_1, risk: 'high' },
        { id: 'r2', t: t.wg_rem_2, risk: 'med' },
        { id: 'r3', t: t.wg_rem_3, risk: 'low' },
      ];
      return (
        <>
          {big && <StatBlock value={items.length} label={t.wg_rem_today} />}
          {wide && (
            <ul className="wg-list">
              {items.slice(0, huge ? 3 : 2).map(it => (
                <li key={it.id} className="wg-row">
                  <span className="chip-dot" style={{ background: { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' }[it.risk] }} />
                  <span className="wg-row-t">{it.t}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'legal_feed': {
      const items = [
        { id: 'l1', t: t.wg_feed_1, d: '08.06' },
        { id: 'l2', t: t.wg_feed_2, d: '03.06' },
        { id: 'l3', t: t.wg_feed_3, d: '29.05' },
      ];
      return (
        <>
          {big && <StatBlock value={12} label={t.wg_feed_week} />}
          {wide && (
            <ul className="wg-list">
              {items.slice(0, huge ? 3 : 2).map(it => (
                <li key={it.id} className="wg-row">
                  <span className="wg-row-date">{it.d}</span>
                  <span className="wg-row-t">{it.t}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    default:
      return null;
  }
}

/* ---------- main grid component ---------- */
export function WidgetGrid({ t, setRoute, user }) {
  const [widgets, setWidgets] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_e) {}
    return [];
  });
  const [picker, setPicker] = useState(null);
  const [drag, setDrag] = useState(null); // { id, x, y, w, h, valid, mode: 'resize'|'move' }
  const [layout, setLayout] = useState({ cols: 9, rows: 5, cell: 120 });
  // True only after the ResizeObserver has measured the real stage. The
  // initial layout state above is a placeholder so the very first paint
  // doesn't trigger a reflow against a fake grid size — that race used to
  // collapse multiple widgets onto the same cell on page reload.
  const [layoutMeasured, setLayoutMeasured] = useState(false);
  const gridRef = useRef(null);
  const stageRef = useRef(null);

  const { cols, rows, cell } = layout;

  // Recompute cols/rows/cell whenever the dashboard area changes. We aim for
  // strictly square cells around 120px (range 110–130) packed to fill the
  // stage with the smallest possible leftover.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const compute = () => {
      const r = el.getBoundingClientRect();
      const next = computeLayout(r.width, r.height);
      if (!next) return;
      setLayout(prev => (
        prev.cols === next.cols && prev.rows === next.rows && prev.cell === next.cell
          ? prev : next
      ));
      setLayoutMeasured(true);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener('resize', compute);
    return () => { ro.disconnect(); window.removeEventListener('resize', compute); };
  }, []);

  // Reflow widgets into the current grid in a collision-aware way: positions
  // saved on a larger grid (or for widgets that no longer fit) are
  // re-resolved into the nearest free slot instead of overlapping. Gated
  // behind `layoutMeasured` so the placeholder 9×5 layout state never
  // triggers an unwanted re-shuffle on first paint.
  useEffect(() => {
    if (!layoutMeasured || cols < 1 || rows < 1) return;
    setWidgets(ws => {
      const next = reflowWidgets(ws, cols, rows);
      // Cheap structural compare so we don't trigger an extra localStorage
      // write when nothing actually moved.
      if (next.length === ws.length && next.every((w, i) =>
        w.x === ws[i].x && w.y === ws[i].y && w.w === ws[i].w && w.h === ws[i].h && w.id === ws[i].id
      )) return ws;
      return next;
    });
  }, [cols, rows, layoutMeasured]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets)); } catch (_e) {}
  }, [widgets]);

  // When the user is dragging a widget, exclude it from the occupancy map so
  // its original cells appear empty and its new target cells render with the
  // preview tint underneath the moving widget.
  const occ = useMemo(() => {
    const list = drag ? widgets.filter(w => w.id !== drag.id) : widgets;
    return buildOccupancy(list, cols, rows);
  }, [widgets, drag, cols, rows]);

  const onCellClick = (c, r) => {
    if (occ[r] && occ[r][c]) return;
    setPicker({ x: c, y: r });
  };

  const addWidget = (type) => {
    if (!picker) return;
    if (!canPlace(occ, cols, rows, picker.x, picker.y, 1, 1)) {
      toast(t.wg_full, 'alert');
      setPicker(null);
      return;
    }
    const id = 'w_' + Math.random().toString(36).slice(2, 9);
    setWidgets(ws => [...ws, { id, type, x: picker.x, y: picker.y, w: 1, h: 1 }]);
    setPicker(null);
    toast(t.wg_added, 'plus');
  };

  const removeWidget = (id) => {
    setWidgets(ws => ws.filter(w => w.id !== id));
    try { localStorage.removeItem(NOTES_KEY + '_' + id); } catch (_e) {}
    toast(t.wg_removed, 'x');
  };

  // Map a mouse-pixel delta to a snap-to-grid cell delta using the live
  // grid bounding box. Works even when cells aren't perfectly square in
  // case a future change relaxes the constraint.
  const getCellPitch = () => {
    const el = gridRef.current;
    if (!el) return { px: cell + GAP, py: cell + GAP };
    const r = el.getBoundingClientRect();
    return {
      px: (r.width + GAP) / cols,
      py: (r.height + GAP) / rows,
    };
  };

  const onHandleDown = (e, id, dir) => {
    e.preventDefault();
    e.stopPropagation();
    const widget = widgets.find(w => w.id === id);
    if (!widget) return;
    const { px, py } = getCellPitch();
    const startX = e.clientX, startY = e.clientY;
    const start = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
    const baseOcc = buildOccupancy(widgets.filter(w => w.id !== id), cols, rows);

    document.body.style.userSelect = 'none';

    const move = (ev) => {
      const cellDX = Math.round((ev.clientX - startX) / px);
      const cellDY = Math.round((ev.clientY - startY) / py);
      let x = start.x, y = start.y, w = start.w, h = start.h;

      if (dir.includes('e')) w = start.w + cellDX;
      if (dir.includes('w')) {
        const nx = Math.max(0, Math.min(start.x + cellDX, start.x + start.w - 1));
        w = start.w + (start.x - nx);
        x = nx;
      }
      if (dir.includes('s')) h = start.h + cellDY;
      if (dir.includes('n')) {
        const ny = Math.max(0, Math.min(start.y + cellDY, start.y + start.h - 1));
        h = start.h + (start.y - ny);
        y = ny;
      }

      w = Math.max(1, w);
      h = Math.max(1, h);
      if (x + w > cols) w = cols - x;
      if (y + h > rows) h = rows - y;

      const valid = canPlace(baseOcc, cols, rows, x, y, w, h);
      setDrag({ id, x, y, w, h, valid, mode: 'resize' });
    };

    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      setDrag(d => {
        if (d && d.valid) {
          setWidgets(ws => ws.map(w => w.id === d.id ? { ...w, x: d.x, y: d.y, w: d.w, h: d.h } : w));
        } else if (d) {
          toast(t.wg_blocked, 'alert');
        }
        return null;
      });
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  // Drag-by-body: mousedown on the widget body starts a potential drag.
  // If the mouse moves more than DRAG_THRESHOLD pixels, it becomes a move;
  // otherwise it's treated as a click (and navigates to the widget's route).
  const onBodyDown = (e, widget, cat) => {
    if (e.button !== 0) return;
    if (e.target.closest('.wg-handle, .wg-widget-close, input, textarea, button')) return;
    e.preventDefault();
    const { px, py } = getCellPitch();
    const startX = e.clientX, startY = e.clientY;
    const start = { x: widget.x, y: widget.y };
    let dragging = false;
    const baseOcc = buildOccupancy(widgets.filter(w => w.id !== widget.id), cols, rows);

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      const cellDX = Math.round(dx / px);
      const cellDY = Math.round(dy / py);
      let nx = start.x + cellDX;
      let ny = start.y + cellDY;
      nx = Math.max(0, Math.min(cols - widget.w, nx));
      ny = Math.max(0, Math.min(rows - widget.h, ny));
      const valid = canPlace(baseOcc, cols, rows, nx, ny, widget.w, widget.h);
      setDrag({ id: widget.id, x: nx, y: ny, w: widget.w, h: widget.h, valid, mode: 'move' });
    };

    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (!dragging) {
        // It was a click — navigate
        if (cat && cat.route && setRoute) setRoute(cat.route);
        return;
      }
      setDrag(d => {
        if (d && d.valid) {
          setWidgets(ws => ws.map(w => w.id === d.id ? { ...w, x: d.x, y: d.y } : w));
        } else if (d) {
          toast(t.wg_blocked, 'alert');
        }
        return null;
      });
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const firstName = ((user && user.name) || '').trim().split(/\s+/)[0] || '';
  const totalCells = cols * rows;

  return (
    <div className="wg-shell">
      <div className="wg-toolbar">
        <div className="wg-toolbar-left">
          <h1 className="wg-greet">{t.greeting}{firstName ? ', ' + firstName : ''}</h1>
          <div className="wg-subtitle">{t.wgSub}</div>
        </div>
        <div className="wg-meta">
          <span className="chip"><Icon name="sparkle" size={12} fill={true} /> {widgets.length} / {totalCells}</span>
          {widgets.length > 0 && (
            <button className="btn btn-subtle btn-sm" onClick={() => { if (confirm(t.wg_clear_confirm)) { setWidgets([]); toast(t.wg_cleared, 'x'); } }}>
              <Icon name="x" size={13} /> {t.wg_clear}
            </button>
          )}
        </div>
      </div>

      <div className="wg-stage" ref={stageRef}>
        <div
          className="wg-grid"
          ref={gridRef}
          style={{
            gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
            gridTemplateRows: `repeat(${rows}, ${cell}px)`,
            gap: GAP,
          }}
        >
          {Array.from({ length: rows }).map((_, r) =>
            Array.from({ length: cols }).map((_, c) => {
              if (occ[r][c]) return null;
              const inPreview = drag &&
                c >= drag.x && c < drag.x + drag.w &&
                r >= drag.y && r < drag.y + drag.h;
              const previewCls = inPreview
                ? (drag.valid ? ' wg-cell-preview' : ' wg-cell-preview-bad')
                : '';
              return (
                <button
                  key={'e' + r + '-' + c}
                  className={'wg-cell' + previewCls}
                  style={{ gridColumn: c + 1, gridRow: r + 1 }}
                  onClick={() => onCellClick(c, r)}
                  aria-label={t.wg_add_aria}
                >
                  <Icon name="plus" size={18} />
                </button>
              );
            })
          )}

          {widgets.map(w => {
            const cat = WIDGETS.find(x => x.type === w.type);
            if (!cat) return null;
            const isDragging = drag && drag.id === w.id;
            const display = isDragging ? drag : w;
            const tone = TONE[cat.tone] || TONE.accent;
            const cls = [
              'wg-widget',
              isDragging ? 'wg-widget-dragging' : '',
              isDragging && drag.mode === 'move' ? 'wg-widget-moving' : '',
              isDragging && !drag.valid ? 'wg-widget-bad' : '',
            ].filter(Boolean).join(' ');
            return (
              <div
                key={w.id}
                className={cls}
                style={{
                  gridColumn: `${display.x + 1} / span ${display.w}`,
                  gridRow: `${display.y + 1} / span ${display.h}`,
                  '--wg-tone-bg': tone.bg,
                  '--wg-tone-fg': tone.fg,
                }}
                onMouseDown={(e) => onBodyDown(e, w, cat)}
                role="button"
                tabIndex={0}
              >
                <div className="wg-widget-head">
                  <span className="wg-widget-ic"><Icon name={cat.icon} size={16} /></span>
                  <span className="wg-widget-title">{t['wg_' + w.type + '_name']}</span>
                  <button
                    className="wg-widget-close"
                    onClick={(e) => { e.stopPropagation(); removeWidget(w.id); }}
                    onMouseDown={(e) => e.stopPropagation()}
                    aria-label={t.wg_remove_aria}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
                <div className="wg-widget-body">
                  <WidgetBody widget={display} t={t} />
                </div>
                {HANDLES.map(dir => (
                  <span
                    key={dir}
                    className={'wg-handle wg-handle-' + dir}
                    onMouseDown={(e) => onHandleDown(e, w.id, dir)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <Modal
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={t.wgPick}
        sub={t.wgPickSub}
        icon="plus"
        wide
      >
        <div className="wg-pick-grid">
          {WIDGETS.map(w => {
            const tone = TONE[w.tone] || TONE.accent;
            return (
              <button key={w.type} className="wg-pick-item" onClick={() => addWidget(w.type)}>
                <span className="wg-pick-ic" style={{ background: tone.bg, color: tone.fg }}>
                  <Icon name={w.icon} size={20} />
                </span>
                <span className="wg-pick-body">
                  <span className="wg-pick-t">{t['wg_' + w.type + '_name']}</span>
                  <span className="wg-pick-s">{t['wg_' + w.type + '_desc']}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}
