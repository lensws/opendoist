export function projectQuery(value, caret) {
  const before = value.slice(0, caret), match = /(?:^|\s)#([^#\n]*)$/u.exec(before);
  if (!match) return null;
  return { start: match.index + match[0].indexOf('#'), end: caret, query: match[1].toLocaleLowerCase() };
}
export function dateSegments(value, source, spans) {
  if (value.trim() !== source) return [{ text: value, marked: false }];
  const offset = value.length - value.trimStart().length, result = []; let cursor = 0;
  for (const span of [...spans].sort((a,b) => a.start-b.start)) {
    const start = span.start + offset, end = span.end + offset;
    if (start < cursor || end > value.length || start >= end) continue;
    result.push({ text: value.slice(cursor, start), marked: false }, { text: value.slice(start, end), marked: true }); cursor = end;
  }
  result.push({ text: value.slice(cursor), marked: false }); return result;
}
export function initTaskInput({ getProjects, chooseProject }) {
  const input = document.querySelector('#task-input'), mirror = document.querySelector('#task-highlight'), menu = document.querySelector('#project-suggestions');
  let choices = [], active = 0, query = null, composing = false;
  function hide() { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function highlight(source = '', spans = []) {
    mirror.replaceChildren();
    for (const part of dateSegments(input.value, source, spans)) { const el = document.createElement(part.marked ? 'mark' : 'span'); el.textContent = part.text; mirror.append(el); }
    mirror.scrollLeft = input.scrollLeft;
  }
  function select(index) {
    const project = choices[index]; if (!project || !query) return;
    const { start, end } = query;
    input.setRangeText('', start, end, 'end'); chooseProject(project.id); hide(); input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function draw() {
    menu.replaceChildren(); menu.hidden = false; input.setAttribute('aria-expanded', 'true');
    if (!choices.length) { const message = document.createElement('div'); message.className = 'suggestion-empty'; message.textContent = 'Проект не найден'; menu.append(message); input.removeAttribute('aria-activedescendant'); return; }
    choices.forEach((project, index) => {
      const option = document.createElement('div'); option.id = `project-option-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === active));
      option.textContent = `${project.emoji || '#'} ${project.name}`; option.className = 'project-option';
      option.addEventListener('pointerdown', event => event.preventDefault()); option.addEventListener('click', () => select(index)); menu.append(option);
    });
    input.setAttribute('aria-activedescendant', `project-option-${active}`); menu.children[active]?.scrollIntoView({ block: 'nearest' });
  }
  function suggest() {
    if (composing || input.selectionStart !== input.selectionEnd) { hide(); return; }
    query = projectQuery(input.value, input.selectionStart);
    if (!query) { hide(); return; }
    choices = getProjects().filter(p => p.name.toLocaleLowerCase().includes(query.query)).slice(0, 20); active = 0; draw();
  }
  input.addEventListener('input', () => { highlight(); suggest(); });
  input.addEventListener('click', suggest);
  input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) suggest(); });
  input.addEventListener('scroll', () => { mirror.scrollLeft = input.scrollLeft; });
  input.addEventListener('blur', hide);
  input.addEventListener('compositionstart', () => { composing = true; hide(); });
  input.addEventListener('compositionend', () => { composing = false; suggest(); });
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); if (choices.length) { active = (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; draw(); } }
    else if (event.key === 'Enter') { event.preventDefault(); if (choices.length) select(active); }
    else if (event.key === 'Tab' && choices.length) { event.preventDefault(); select(active); }
  });
  return { highlight, hide };
}
