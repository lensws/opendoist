// Regenerate with npm run emojis:build after updating the pinned development dataset.
import { readFileSync, writeFileSync } from 'node:fs';
import { entityFields } from '../server/projects.js';
const read = path => JSON.parse(readFileSync(new URL(`../node_modules/emojibase-data/${path}`, import.meta.url)));
const ru = read('ru/data.json'), en = new Map(read('en/data.json').map(e => [e.hexcode, e]));
const aliases = {
  '💼': 'работа бизнес офис work business office', '💻': 'работа разработка код программирование computer laptop code coding development',
  '🏠': 'дом семья быт home house family', '📚': 'учеба учёба образование чтение книги study learning education books reading',
  '🏃': 'спорт тренировки фитнес бег sport workout fitness running', '🏋️': 'спорт тренировки фитнес зал sport workout gym fitness',
  '💰': 'финансы деньги бюджет finance money budget', '✈️': 'отпуск поездки путешествия vacation travel trip flight',
  '🛒': 'покупки магазин продукты shopping groceries store', '🩺': 'здоровье врач медицина health doctor medicine',
  '📁': 'проект папка файлы документы project folder files documents', '✅': 'готово выполнено завершено done completed finish',
  '🚀': 'запуск релиз проект launch release project', '💡': 'идеи идея идеи ideas idea inspiration',
};
const emojis = ru.filter(e => Number.isInteger(e.group) && e.group !== 2).sort((a,b) => a.order-b.order).flatMap(e => {
  try { entityFields({ name: 'emoji', iconType: 'emoji', color: '#000000', emoji: e.emoji }); } catch { return []; }
  const english = en.get(e.hexcode);
  return [{ emoji: e.emoji, label: e.label, group: e.group, keywords: [...new Set([e.label, ...(e.tags || []), english?.label || '', ...(english?.tags || []), aliases[e.emoji] || ''])].join(' ') }];
});
const groups = read('ru/messages.json').groups.filter(g => g.order !== 2).map(g => ({ id:g.order, name:g.message }));
writeFileSync(new URL('../public/emojis.json', import.meta.url), JSON.stringify({ source:'emojibase-data@18.0.0 (MIT)', groups, emojis }));
writeFileSync(new URL('../public/emojis-LICENSE.txt', import.meta.url), readFileSync(new URL('../node_modules/emojibase-data/LICENSE', import.meta.url)));
console.log(`Generated ${emojis.length} emoji entries`);
