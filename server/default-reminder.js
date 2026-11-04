import { randomUUID } from 'node:crypto';
const timed = task => task?.due?.instant && !task.due.allDay;
// Apply only on creation or the transition from an untimed to a timed task.
// Editing an already timed task must not restore a reminder the user removed.
export function withDefaultReminder(task, config, previous = null, now = Date.now()) {
  const channels = ['email', 'telegram'].filter(channel => config?.[channel]?.enabled);
  if (!timed(task) || timed(previous) || task.completedAt || task.reminders?.length || !channels.length || !(Date.parse(task.due.instant) - 10 * 60000 > now)) return task;
  return { ...task, reminders: [{ id: randomUUID(), kind: 'before', minutes: 10, channels, createdAt: now }] };
}
