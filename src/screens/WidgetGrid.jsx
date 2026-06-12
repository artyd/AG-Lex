/* ============================================================
   AG Lex — Dashboard widget grid (15×20 snap-to-grid canvas)
   ============================================================ */
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Icon } from '../ui/Icon';
import { Modal, toast } from '../ui/components';
import { DEMO } from '../data/demo';
import { LX } from '../data/lx';

const COLS = 15;
const ROWS = 20;
const STORAGE_KEY = 'aglex_dashboard_widgets';
const NOTES_KEY = 'aglex_dashboard_widget_notes';

const WIDGETS = [
  { type: 'court_calendar', icon: 'calendar', tone: 'high', route: 'calendar' },
  { type: 'tasks',          icon: 'check',    tone: 'med',  route: 'tasks' },
  { type: 'timer',          icon: 'clock',    tone: 'accent', route: 'billing' },
  { type: 'matters',        icon: 'folder',   tone: 'info', route: 'matters' },
  { type: 'statutes',       icon: 'alert',    tone: 'high', route: 'litigation' },
  { type: 'docs',           icon: 'doc',      tone: 'accent', route: 'library' },
  { type: 'clients',        icon: 'clients',  tone: 'info', route: 'clients' },
  { type: 'invoices',       icon: 'pay',      tone: 'med',  route: 'billing' },
  { type: 'notes',          icon: 'pen',      tone: 'accent', route: null },
  { type: 'legal_search',   icon: 'scales',   tone: 'info', route: 'legal' },
  { type: 'templates',      icon: 'templates', tone: 'accent', route: 'templates' },
  { type: 'meetings',       icon: 'chat',     tone: 'info', route: 'calendar' },
  { type: 'analytics',      icon: 'sparkle',  tone: 'accent', route: 'matters' },
  { type: 'reminders',      icon: 'bell',     tone: 'med',  route: 'tasks' },
  { type: 'legal_feed',     icon: 'book',     tone: 'info', route: 'legal' },
];

const TONE = {
  high:   { bg: 'var(--risk-high-soft)', fg: 'var(--risk-high)' },
  med:    { bg: 'var(--risk-med-soft)',  fg: 'var(--risk-med)' },
  info:   { bg: 'var(--info-soft)',      fg: 'var(--info)' },
  accent: { bg: 'var(--accent-soft)',    fg: 'var(--accent)' },
};

/* ---------- occupancy + placement helpers ---------- */
function buildOccupancy(widgets) {
  const m = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  for (const w of widgets) {
    for (let r = w.y; r < w.y + w.h && r < ROWS; r++) {
      for (let c = w.x; c < w.x + w.w && c < COLS; c++) {
        if (r >= 0 && c >= 0) m[r][c] = w.id;
      }
    }
  }
  return m;
}

function canPlace(occ, x, y, w, h, ignoreId) {
  if (x < 0 || y < 0 || w < 1 || h < 1) return false;
  if (x + w > COLS || y + h > ROWS) return false;
  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      const v = occ[r][c];
      if (v && v !== ignoreId) return false;
    }
  }
  return true;
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
export function WidgetGrid({ t, setRoute }) {
  const [widgets, setWidgets] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_e) {}
    return [];
  });
  const [picker, setPicker] = useState(null); // { x, y } when a free cell is clicked
  const [drag, setDrag] = useState(null);     // { id, x, y, w, h, valid } during resize
  const gridRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets)); } catch (_e) {}
  }, [widgets]);

  const occ = useMemo(() => buildOccupancy(widgets), [widgets]);

  const onCellClick = (c, r) => {
    if (occ[r][c]) return;
    setPicker({ x: c, y: r });
  };

  const addWidget = (type) => {
    if (!picker) return;
    if (!canPlace(occ, picker.x, picker.y, 1, 1, null)) {
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

  const onHandleDown = useCallback((e, id, dir) => {
    e.preventDefault();
    e.stopPropagation();
    const widget = widgets.find(w => w.id === id);
    if (!widget) return;
    const el = gridRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
    const cellW = (rect.width + gap) / COLS;
    const cellH = (rect.height + gap) / ROWS;
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };

    const move = (ev) => {
      const dx = Math.round((ev.clientX - startX) / cellW);
      const dy = Math.round((ev.clientY - startY) / cellH);
      let x = start.x, y = start.y, w = start.w, h = start.h;

      if (dir.includes('e')) w = start.w + dx;
      if (dir.includes('w')) {
        const newX = Math.max(0, Math.min(start.x + dx, start.x + start.w - 1));
        w = start.w + (start.x - newX);
        x = newX;
      }
      if (dir.includes('s')) h = start.h + dy;
      if (dir.includes('n')) {
        const newY = Math.max(0, Math.min(start.y + dy, start.y + start.h - 1));
        h = start.h + (start.y - newY);
        y = newY;
      }

      w = Math.max(1, w);
      h = Math.max(1, h);
      if (x + w > COLS) w = COLS - x;
      if (y + h > ROWS) h = ROWS - y;

      const valid = canPlace(occ, x, y, w, h, id);
      setDrag({ id, x, y, w, h, valid });
    };

    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setDrag(d => {
        if (d && d.valid) {
          setWidgets(ws => ws.map(w => w.id === d.id ? { ...w, x: d.x, y: d.y, w: d.w, h: d.h } : w));
        } else if (d && !d.valid) {
          toast(t.wg_blocked, 'alert');
        }
        return null;
      });
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }, [widgets, occ, t]);

  const onWidgetClick = (w, route) => {
    if (drag) return;
    if (route && setRoute) setRoute(route);
  };

  const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  return (
    <div className="card wg-card">
      <div className="wg-head">
        <div>
          <h2 className="wg-title">{t.wgTitle}</h2>
          <div className="wg-subtitle">{t.wgSub}</div>
        </div>
        <div className="wg-meta">
          <span className="chip"><Icon name="sparkle" size={12} fill={true} /> {widgets.length} / {COLS * ROWS}</span>
          {widgets.length > 0 && (
            <button className="btn btn-subtle btn-sm" onClick={() => { if (confirm(t.wg_clear_confirm)) { setWidgets([]); toast(t.wg_cleared, 'x'); } }}>
              <Icon name="x" size={13} /> {t.wg_clear}
            </button>
          )}
        </div>
      </div>

      <div className="wg-grid-wrap">
        <div className="wg-grid" ref={gridRef}>
          {Array.from({ length: ROWS }).map((_, r) =>
            Array.from({ length: COLS }).map((_, c) => {
              if (occ[r][c]) return null;
              // Show preview tint over empty cells inside drag target if drag valid
              const inPreview = drag && drag.valid &&
                c >= drag.x && c < drag.x + drag.w &&
                r >= drag.y && r < drag.y + drag.h;
              return (
                <button
                  key={'e' + r + '-' + c}
                  className={'wg-cell' + (inPreview ? ' wg-cell-preview' : '')}
                  style={{ gridColumn: c + 1, gridRow: r + 1 }}
                  onClick={() => onCellClick(c, r)}
                  aria-label={t.wg_add_aria}
                >
                  <Icon name="plus" size={14} />
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
            return (
              <div
                key={w.id}
                className={'wg-widget' + (isDragging ? ' wg-widget-dragging' : '') + (isDragging && !drag.valid ? ' wg-widget-bad' : '')}
                style={{
                  gridColumn: `${display.x + 1} / span ${display.w}`,
                  gridRow: `${display.y + 1} / span ${display.h}`,
                  '--wg-tone-bg': tone.bg,
                  '--wg-tone-fg': tone.fg,
                }}
                onClick={() => onWidgetClick(w, cat.route)}
                role="button"
                tabIndex={0}
              >
                <div className="wg-widget-head">
                  <span className="wg-widget-ic"><Icon name={cat.icon} size={13} /></span>
                  {(display.w >= 2 || display.h >= 2) && (
                    <span className="wg-widget-title">{t['wg_' + w.type + '_name']}</span>
                  )}
                  <button
                    className="wg-widget-close"
                    onClick={(e) => { e.stopPropagation(); removeWidget(w.id); }}
                    onMouseDown={(e) => e.stopPropagation()}
                    aria-label={t.wg_remove_aria}
                  >
                    <Icon name="x" size={11} />
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
                    onClick={(e) => e.stopPropagation()}
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
