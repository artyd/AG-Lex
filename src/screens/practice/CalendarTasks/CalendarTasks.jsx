/* ============================================================
   CalendarTasks — merged Calendar + Tasks view (Practice nav).
   Two-column desktop layout: month grid + side panel. On
   narrow viewports the panel drops to a bottom sheet.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../ui/Icon';
import { toast } from '../../../ui/components';
import { CalendarGrid } from './CalendarGrid';
import { TaskPanel } from './TaskPanel';
import { useCalendarTasks } from './useCalendarTasks';

function useIsNarrow(breakpoint = 768) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (e) => setNarrow(e.matches);
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => {
      mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange);
    };
  }, [breakpoint]);
  return narrow;
}

export function CalendarTasks({ t }) {
  const {
    currentMonth,
    selectedDate,
    setSelectedDate,
    tasks,
    tasksForDate,
    create,
    update,
    remove,
    goToToday,
    stepMonth,
  } = useCalendarTasks();

  const isNarrow = useIsNarrow(768);
  const [sheetOpen, setSheetOpen] = useState(false);

  const selectedTasks = useMemo(() => tasksForDate(selectedDate), [tasksForDate, selectedDate]);

  const onSelectDate = (iso) => {
    setSelectedDate(iso);
    if (isNarrow) setSheetOpen(true);
  };

  const handleCreate = (draft) => {
    create(draft);
    toast(t.taskCreated || 'Задачу створено', 'check');
  };

  const handleUpdate = (id, patch) => {
    update(id, patch);
    if (patch.status === 'done') toast(t.taskDoneMsg || 'Задачу виконано', 'checkCircle');
  };

  const handleDelete = (task) => {
    remove(task.id);
    toast(t.taskDeleted || 'Задачу видалено', 'x');
  };

  // Keep total counter responsive for the heading.
  const monthCount = useMemo(() => {
    const y = currentMonth.getFullYear();
    const m = currentMonth.getMonth();
    return tasks.filter(tk => {
      if (!tk.due_date) return false;
      const d = new Date(tk.due_date);
      return d.getFullYear() === y && d.getMonth() === m;
    }).length;
  }, [tasks, currentMonth]);

  return (
    <div className="page view-enter">
      <div className="ct-layout">
        <div className="ct-cal-col">
          <CalendarGrid
            currentMonth={currentMonth}
            selectedDate={selectedDate}
            tasksForDate={tasksForDate}
            onSelectDate={onSelectDate}
            onPrev={() => stepMonth(-1)}
            onNext={() => stepMonth(1)}
            onToday={goToToday}
            t={t}
          />
          <div className="ct-cal-foot">
            <span className="ct-cal-foot-chip">
              <Icon name="check" size={11} />
              <span>{monthCount} {t.mTasksShort || 'задач'}</span>
            </span>
          </div>
        </div>

        <TaskPanel
          selectedDate={selectedDate}
          tasks={selectedTasks}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          isMobileSheetOpen={!isNarrow || sheetOpen}
          onCloseSheet={() => setSheetOpen(false)}
          t={t}
        />

        {isNarrow && sheetOpen ? (
          <button
            type="button"
            className="ct-sheet-scrim"
            aria-label={t.close || 'Закрити'}
            onClick={() => setSheetOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
