/* ============================================================
   CalendarGrid — month grid with prev/next/today controls.
   Week starts on Monday. Renders a DayCell per day; empty
   leading slots are non-interactive.
   ============================================================ */
import { Icon } from '../../../ui/Icon';
import { DayCell } from './DayCell';
import { ymd, todayISO } from './useCalendarTasks';

const DOW_UK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_UK = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
const MONTH_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function CalendarGrid({
  currentMonth,
  selectedDate,
  tasksForDate,
  onSelectDate,
  onPrev,
  onNext,
  onToday,
  t,
}) {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const monthNames = t && t.locale === 'en-GB' ? MONTH_EN : MONTH_UK;
  const dows = t && t.locale === 'en-GB' ? DOW_EN : DOW_UK;

  // Monday-first: shift Sunday(0) to position 6.
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayISO();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push({ empty: true, key: 'e' + i });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = ymd(new Date(year, month, d));
    const dow = (firstDow + d - 1) % 7;
    cells.push({
      empty: false,
      key: iso,
      iso,
      day: d,
      isWeekend: dow >= 5,
    });
  }

  return (
    <div className="ct-cal-card">
      <div className="ct-cal-head">
        <h2 className="ct-cal-title">{monthNames[month]} {year}</h2>
        <div className="ct-cal-nav">
          <button
            type="button"
            className="ct-nav-btn"
            onClick={onPrev}
            aria-label={t.prev || 'Попередній місяць'}
          >
            <Icon name="chevR" size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button
            type="button"
            className="ct-today-btn"
            onClick={onToday}
          >
            {t.today || 'Сьогодні'}
          </button>
          <button
            type="button"
            className="ct-nav-btn"
            onClick={onNext}
            aria-label={t.next || 'Наступний місяць'}
          >
            <Icon name="chevR" size={14} />
          </button>
        </div>
      </div>
      <div className="ct-dows">
        {dows.map(d => <div key={d} className="ct-dow">{d}</div>)}
      </div>
      <div className="ct-grid">
        {cells.map(cell => {
          if (cell.empty) return <div key={cell.key} className="ct-cell ct-empty" />;
          const onDay = tasksForDate(cell.iso);
          const hasOpen = onDay.some(tk => tk.status !== 'done');
          const isOverdue = cell.iso < today && hasOpen;
          return (
            <DayCell
              key={cell.key}
              iso={cell.iso}
              dayNum={cell.day}
              isToday={cell.iso === today}
              isSelected={cell.iso === selectedDate}
              isWeekend={cell.isWeekend}
              isOverdue={isOverdue}
              tasksOnDay={onDay}
              onSelect={onSelectDate}
            />
          );
        })}
      </div>
    </div>
  );
}
