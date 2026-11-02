export function initProjects({ api, getData, reload, selectView, notify }) {
  const $ = s => document.querySelector(s);
  let editing = null, kind = 'project', parent = null, lastView = null;
  const node = (tag, text, cls = '') => { const el = document.createElement(tag); el.textContent = text; el.className = cls; return el; };
  function icon(entity) { const el = node('span', entity.iconType === 'emoji' ? entity.emoji : '#', 'project-icon'); if (entity.iconType === 'color') el.style.color = entity.color; return el; }
  function open(entity = null, type = 'project', projectId = null) {
    editing = entity; kind = type; parent = projectId || entity?.projectId;
    $('#entity-heading').textContent = `${entity ? 'Изменить' : 'Новый'} ${type === 'project' ? 'проект' : 'раздел'}`;
    $('#entity-name').value = entity?.name || ''; $('#entity-icon-type').value = entity?.iconType || 'color';
    $('#entity-color').value = entity?.color || '#c95736'; $('#entity-emoji').value = entity?.emoji || '📁';
    $('#entity-delete').hidden = !entity; $('#entity-error').textContent = ''; switchIcon(); $('#entity-dialog').showModal();
  }
  function switchIcon() { const emoji = $('#entity-icon-type').value === 'emoji'; $('#entity-emoji-label').hidden = !emoji; $('#entity-color-label').hidden = emoji; }
  function sectionsFor(projectSelect, sectionSelect, selected = sectionSelect.value) {
    sectionSelect.replaceChildren(new Option('Без раздела', ''));
    for (const s of getData().sections.filter(s => s.projectId === projectSelect.value)) sectionSelect.add(new Option(`${s.emoji || '#'} ${s.name}`, s.id));
    sectionSelect.value = [...sectionSelect.options].some(o => o.value === selected) ? selected : '';
    sectionSelect.disabled = !projectSelect.value;
  }
  function fillPlacement(prefix, projectId = '', sectionId = '') {
    const project = $(`#${prefix}-project`), section = $(`#${prefix}-section`);
    project.replaceChildren(new Option('Входящие', ''));
    for (const p of getData().projects) project.add(new Option(`${p.emoji || '#'} ${p.name}`, p.id));
    project.value = projectId || ''; sectionsFor(project, section, sectionId || '');
  }
  function placement(prefix) { return { projectId: $(`#${prefix}-project`).value || null, sectionId: $(`#${prefix}-section`).value || null }; }
  function draw(view) {
    const { projects, sections, tasks } = getData(), list = $('#project-list'); list.replaceChildren();
    const row = (entity, type) => {
      const line = node('div', '', `project-row ${type === 'section' ? 'section-row' : ''}`);
      const button = node('button', '', `nav-item${view === `${type}:${entity.id}` ? ' active' : ''}`); button.type = 'button';
      const count = tasks.filter(t => !t.completedAt && (type === 'project' ? t.projectId === entity.id : t.sectionId === entity.id)).length;
      button.append(icon(entity), node('span', entity.name, 'project-name'), node('span', String(count), 'count'));
      button.addEventListener('click', () => selectView(`${type}:${entity.id}`));
      const edit = node('button', '⋯', 'icon-button'); edit.type = 'button'; edit.setAttribute('aria-label', `Изменить ${type === 'project' ? 'проект' : 'раздел'} ${entity.name}`); edit.addEventListener('click', () => open(entity, type));
      line.append(button, edit); list.append(line);
    };
    for (const p of projects) { row(p, 'project'); for (const s of sections.filter(s => s.projectId === p.id)) row(s, 'section'); }
    let p = $('#add-project').value, s = $('#add-section').value;
    if (view !== lastView && view.startsWith('project:')) { p = view.slice(8); if (!sections.some(x => x.id === s && x.projectId === p)) s = ''; }
    if (view !== lastView && view.startsWith('section:')) { s = view.slice(8); p = sections.find(x => x.id === s)?.projectId || ''; }
    if (view !== lastView && view === 'inbox') { p = ''; s = ''; }
    fillPlacement('add', p, s); lastView = view;
    const currentProject = view.startsWith('project:') ? projects.find(p => p.id === view.slice(8)) : view.startsWith('section:') ? projects.find(p => p.id === sections.find(s => s.id === view.slice(8))?.projectId) : null;
    $('#section-add').hidden = !currentProject;
    $('#section-add').onclick = () => open(null, 'section', currentProject.id);
  }
  $('#project-add').addEventListener('click', () => open());
  $('#entity-icon-type').addEventListener('change', switchIcon);
  for (const prefix of ['add', 'edit']) $(`#${prefix}-project`).addEventListener('change', () => sectionsFor($(`#${prefix}-project`), $(`#${prefix}-section`), ''));
  $('#entity-form').addEventListener('submit', async event => {
    event.preventDefault(); event.submitter.disabled = true; $('#entity-error').textContent = '';
    try {
      const result = await api(`/${kind}s${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: { name: $('#entity-name').value, iconType: $('#entity-icon-type').value, color: $('#entity-color').value, emoji: $('#entity-emoji').value, projectId: parent, revision: editing?.revision } });
      $('#entity-dialog').close(); await reload(); selectView(`${kind}:${result.entity.id}`);
    } catch (e) { $('#entity-error').textContent = e.message; } finally { event.submitter.disabled = false; }
  });
  $('#entity-delete').addEventListener('click', async () => {
    if (!editing || !confirm(kind === 'project' ? 'Удалить проект и его разделы? Задачи останутся во Входящих.' : 'Удалить раздел? Задачи останутся в проекте без раздела.')) return;
    try { await api(`/${kind}s/${editing.id}`, { method: 'DELETE', body: { revision: editing.revision } }); $('#entity-dialog').close(); selectView('inbox'); await reload(); notify('Удалено. Задачи сохранены.'); }
    catch (e) { $('#entity-error').textContent = e.message; }
  });
  return { draw, fillPlacement, placement };
}
