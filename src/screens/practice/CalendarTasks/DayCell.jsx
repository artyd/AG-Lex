/* ============================================================
   DayCell — one calendar cell. Renders day number, up to 3
   priority dots (+N overflow), today/selected/weekend/overdue
   variants.
   ============================================================ */
import { Icon } from '../../../ui/Icon';

const PRIO_DOT = {
  high: '#cf2230',
  med: 'oklch(70% 0.15 60)',
  low: 'oklch(60% 0.1 250)',
};

export const PRIO_LABEL = (t) => ({
  high: t.prioHigh,
  med: t.prioMed,
  low: t.prioLow,
});

export const PRIO_COLOR = PRIO_DOT;

export function DayCell({
  iso,
  dayNum,
  isToday,
  isSelected,
  isWeekend,
  isOverdue,
  tasksOnDay,
  onSelect,
}) {
  const shown = tasksOnDay.slice(0, 3);
  const overflow = tasksOnDay.length > 3 ? tasksOnDay.length - 3 : 0;
  const classes = [
    'ct-cell',
    isToday ? 'ct-today' : '',
    isSelected ? 'ct-sel' : '',
    isWeekend ? 'ct-weekend' : '',
    isOverdue ? 'ct-overdue' : '',
    tasksOnDay.length ? 'ct-has' : '',
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={() => onSelect(iso)}
      aria-pressed={isSelected ? 'true' : 'false'}
      aria-label={`${dayNum}: ${tasksOnDay.length} задач`}
    >
      <span className="ct-daynum">{dayNum}</span>
      <span className="ct-dots">
        {shown.map(task => (
          <span
            key={task.id}
            className="ct-dot"
            style={{ background: PRIO_DOT[task.priority] || PRIO_DOT.med }}
            title={task.title}
          />
        ))}
        {overflow > 0 ? (
          <span className="ct-more">+{overflow}</span>
        ) : null}
      </span>
      {isOverdue && tasksOnDay.length ? (
        <span className="ct-overdue-flag" aria-hidden="true">
          <Icon name="alert" size={9} />
        </span>
      ) : null}
    </button>
  );
}
