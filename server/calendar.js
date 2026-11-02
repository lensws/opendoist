import { DateTime } from 'luxon';
import { AppError } from './store.js';
// Moving an occurrence changes its next due date, never silently replaces its recurrence rule.
export function rescheduleTask(task, body) {
  if (task.completedAt) throw new AppError(400, 'Выполненную задачу нельзя перенести');
  if (body.date === null) {
    if (task.recurrence) throw new AppError(400, 'Сначала отключите повторение в редакторе задачи');
    return { ...task, due: null, status: 'unscheduled' };
  }
  if (body.timezone !== undefined && typeof body.timezone !== 'string') throw new AppError(400, 'Укажите корректный часовой пояс');
  const timezone = task.due?.timezone || body.timezone || 'Europe/Moscow';
  const time = body.time === undefined ? task.due?.time ?? null : body.time;
  if (typeof body.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(body.date) || (time !== null && (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) || typeof timezone !== 'string') throw new AppError(400, 'Укажите корректную дату и время');
  const local = DateTime.fromISO(`${body.date}T${time || '00:00'}`, { zone: body.timezone || timezone });
  if (!local.isValid || local.toISODate() !== body.date || (time !== null && local.toFormat('HH:mm') !== time)) throw new AppError(400, 'Такого времени нет в часовом поясе задачи');
  const stored = local.setZone(timezone);
  return { ...task, status: 'scheduled', due: { date: time === null ? body.date : stored.toISODate(), time: time === null ? null : stored.toFormat('HH:mm'), allDay: time === null, timezone, instant: time === null ? null : local.toUTC().toISO() } };
}
