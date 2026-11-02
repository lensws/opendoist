import { indexEmojis, searchEmojis } from './emoji-search.js';
export function initEmojiPicker() {
  const $ = s => document.querySelector(s), search = $('#emoji-search'), group = $('#emoji-group'), grid = $('#emoji-grid'), status = $('#emoji-status'), more = $('#emoji-more'), input = $('#entity-emoji');
  let data = null, loading = null, limit = 72;
  function selection() {
    $('#emoji-selected').textContent = input.value || '—';
    for (const button of grid.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.emoji === input.value));
  }
  function render() {
    if (!data) return;
    const results = searchEmojis(data, search.value, group.value), visible = results.slice(0, limit);
    grid.replaceChildren();
    for (const entry of visible) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.emoji; button.dataset.emoji = entry.emoji;
      button.className = 'emoji-choice'; button.title = entry.label; button.setAttribute('aria-label', `${entry.emoji} — ${entry.label}`); button.tabIndex = -1;
      button.addEventListener('click', () => { input.value = entry.emoji; selection(); }); grid.append(button);
    }
    const first = [...grid.children].find(b => b.dataset.emoji === input.value) || grid.firstElementChild; if (first) first.tabIndex = 0;
    selection(); more.hidden = results.length <= limit;
    status.textContent = results.length ? `Найдено: ${results.length}. Показано: ${visible.length}.` : 'Ничего не найдено. Попробуйте другое слово или категорию.';
  }
  async function load() {
    if (data) { render(); return; }
    if (loading) return loading;
    status.textContent = 'Загружаем набор эмодзи…'; $('#emoji-retry').hidden = true;
    loading = (async () => {
      try {
        const response = await fetch('/emojis.json'); if (!response.ok) throw Error();
        const dataset = await response.json(); data = indexEmojis(dataset.emojis);
        for (const entry of dataset.groups) group.add(new Option(entry.name, String(entry.id)));
        render();
      } catch { status.textContent = 'Не удалось загрузить набор. Повторите загрузку или вставьте свой эмодзи ниже.'; $('#emoji-retry').hidden = false; }
      finally { loading = null; }
    })(); return loading;
  }
  for (const element of [search, group]) element.addEventListener(element === search ? 'input' : 'change', () => { limit = 72; render(); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  more.addEventListener('click', () => { const oldLimit = limit; limit += 72; render(); grid.children[oldLimit]?.focus(); });
  $('#emoji-retry').addEventListener('click', load); input.addEventListener('input', selection);
  grid.addEventListener('focusin', event => { if (event.target.matches('button')) for (const button of grid.children) button.tabIndex = button === event.target ? 0 : -1; });
  grid.addEventListener('keydown', event => {
    if (!event.target.matches('button')) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length, buttons = [...grid.children], current = buttons.indexOf(event.target);
    const indices = { ArrowLeft: current - 1, ArrowRight: current + 1, ArrowUp: current - columns, ArrowDown: current + columns, Home: 0, End: buttons.length - 1 };
    if (event.key in indices) { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, indices[event.key]))]?.focus(); }
  });
  return { reset() { search.value = ''; group.value = ''; limit = 72; selection(); if (data) render(); }, show() { selection(); return load(); } };
}
