export const normalizeEmojiQuery = value => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{Mark}/gu, '').trim();
const favorites = ['📁','💼','🏠','💻','📚','🛒','💰','❤️','🏃','🎯','✅','🚀','💡','🗓️','📋','🔧','✈️','🌱','🎨','🎵','🐈','🐕','☕','🩺'];
export function indexEmojis(emojis) { return emojis.map(e => ({ ...e, search: normalizeEmojiQuery(e.keywords), name: normalizeEmojiQuery(e.label) })); }
export function searchEmojis(emojis, query = '', group = '') {
  const normalized = normalizeEmojiQuery(query), words = normalized.split(/\s+/).filter(Boolean);
  const results = emojis.filter(e => (group === '' || e.group === Number(group)) && (!words.length || words.every(w => e.search.includes(w)) || normalizeEmojiQuery(e.emoji) === normalized));
  const score = e => normalized ? (normalizeEmojiQuery(e.emoji) === normalized ? 100 : e.name === normalized ? 90 : e.name.startsWith(normalized) ? 60 : e.name.includes(normalized) ? 40 : 0) : favorites.includes(e.emoji) ? 100 - favorites.indexOf(e.emoji) : 0;
  return results.sort((a,b) => score(b)-score(a));
}
