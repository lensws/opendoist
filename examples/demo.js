import { parseTask, occurrences } from '../src/index.js';
const options = { now: '2026-11-02T10:00:00+03:00', timezone: 'Europe/Moscow' };
for (const text of [
  'Купить молоко завтра в 18:00', 'Buy milk tomorrow at 6pm',
  'Отчёт каждую пятницу в 17:00', 'Water plants every 3 days',
  'Витамины каждые 3 дня после выполнения', 'Позвонить маме',
  'Отчёт следующая пятница', 'Review 3rd friday jan',
  'Подготовка 6 недель до 21 июля', 'Task every 2 days at 12:00 {Feb 28}',
  'Отчёт каждый 3 вторник начиная с 20 августа заканчивая через 18 месяцев',
  'Покупки без срока',
]) {
  const task = parseTask(text, options);
  console.log(JSON.stringify({ ...task, upcoming: task.recurrence?.mode === 'calendar' ? occurrences(task, { after: options.now, count: 3 }) : [] }, null, 2));
}
