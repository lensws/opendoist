import { orderedTree, descendants } from './task-tree.js';
import { markdown } from './markdown.js';
const $ = s => document.querySelector(s);
export function initTaskDetails({ api, getTasks, reload, notify }) {
  let current = null, dragging = null, saving = false, sequence = 0, preview = false;
  const snapshot = task => getTasks().filter(t => (t.projectId ?? null) === (task.projectId ?? null)).map(({id, revision}) => ({id, revision}));
  async function move(task, patch) {
    if (saving) return; saving = true;
    try { await api(`/tasks/${task.id}/move`, {method:'POST', body:{...patch, previous:snapshot(task)}}); await reload(); notify('Порядок задач сохранён'); }
    catch (e) { notify(e.message); await reload(); } finally { saving = false; }
  }
  function decorate(row, task, depth, entries) {
    row.style.setProperty('--task-depth', String(depth)); row.dataset.taskId = task.id;
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'task-drag'; handle.textContent = '⠿'; handle.draggable = false;
    handle.title = 'Перетащить; Alt+↑/↓ — порядок, Alt+→/← — вложенность'; handle.setAttribute('aria-label', `Переместить ${task.title}`);
    row.prepend(handle);
    const clear = () => document.querySelectorAll('.task-drop-before,.task-drop-after,.task-drop-child').forEach(e => e.classList.remove('task-drop-before','task-drop-after','task-drop-child'));
    const siblings = () => orderedTree(getTasks().filter(t => !t.completedAt && (t.projectId ?? null) === (task.projectId ?? null) && (t.sectionId ?? null) === (task.sectionId ?? null) && (t.parentId ?? null) === (task.parentId ?? null))).map(x => x.task);
    handle.addEventListener('keydown', e => {
      if (!e.altKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) return;
      e.preventDefault(); const list = siblings(), index = list.findIndex(t => t.id === task.id);
      if (e.key === 'ArrowUp' && index > 0) move(task, {parentId:task.parentId, beforeId:list[index-1].id});
      if (e.key === 'ArrowDown' && index < list.length-1) move(task, {parentId:task.parentId, beforeId:list[index+2]?.id ?? null});
      if (e.key === 'ArrowRight' && index > 0) move(task, {parentId:list[index-1].id});
      if (e.key === 'ArrowLeft' && task.parentId) { const parent = getTasks().find(t => t.id === task.parentId); move(task, {parentId:parent?.parentId ?? null}); }
    });
    let pointer = null;
    function cancelDrag(event) {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'keydown') event.preventDefault();
      if (pointer) finish({pointerId:pointer.id,type:'cancel'});
    }
    function updateDragCard(event) {
      if (!pointer.card) {
        const rect = row.getBoundingClientRect();
        const card = row.cloneNode(true);
        card.classList.add('task-drag-preview');
        card.setAttribute('aria-hidden', 'true'); card.inert = true;
        card.removeAttribute('id'); card.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        card.style.width = `${rect.width}px`;
        pointer.offsetX = pointer.x - rect.left; pointer.offsetY = pointer.y - rect.top;
        pointer.card = card; document.body.append(card);
        document.body.classList.add('task-drag-active');
      }
      pointer.card.style.left = `${Math.max(8, Math.min(event.clientX - pointer.offsetX, window.innerWidth - pointer.card.offsetWidth - 8))}px`;
      pointer.card.style.top = `${event.clientY - pointer.offsetY}px`;
    }
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || saving) return;
      pointer = {id:e.pointerId,x:e.clientX,y:e.clientY,patch:null};
      handle.setPointerCapture(e.pointerId);
      window.addEventListener('keydown',cancelDrag); window.addEventListener('blur',cancelDrag);
    });
    handle.addEventListener('pointermove', e => {
      if (!pointer || pointer.id !== e.pointerId) return;
      if (!dragging && Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y) < 6) return;
      e.preventDefault(); updateDragCard(e); dragging=task; row.classList.add('dragging'); clear(); pointer.patch=null;
      const targetRow=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-task-id]');
      const target=targetRow && entries.find(t=>t.id===targetRow.dataset.taskId);
      if (!target || target.id===task.id || descendants(getTasks(),task.id).has(target.id)) return;
      const rect=targetRow.getBoundingClientRect();
      if(e.clientX>rect.left+85) {
        targetRow.classList.add('task-drop-child'); pointer.patch={parentId:target.id,sectionId:target.sectionId};
      } else {
        const after=e.clientY>rect.top+rect.height/2;
        const peers=entries.filter(t=>t.id!==task.id && (t.parentId ?? null)===(target.parentId ?? null) && (t.sectionId ?? null)===(target.sectionId ?? null));
        const next=peers[peers.findIndex(t=>t.id===target.id)+1];
        pointer.patch={parentId:target.parentId ?? null,sectionId:target.sectionId ?? null,beforeId:after ? next?.id ?? null : target.id};
        targetRow.classList.add(after ? 'task-drop-after' : 'task-drop-before');
      }
      if(e.clientY<50) window.scrollBy(0,-12); else if(e.clientY>window.innerHeight-50) window.scrollBy(0,12);
    });
    function finish(e) {
      if(!pointer || pointer.id!==e.pointerId) return;
      const patch=pointer.patch; pointer.card?.remove();
      document.body.classList.remove('task-drag-active');
      window.removeEventListener('keydown',cancelDrag); window.removeEventListener('blur',cancelDrag);
      pointer=null; dragging=null; clear(); row.classList.remove('dragging');
      if(handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      if(e.type==='pointerup' && patch) move(task,patch);
    }
    handle.addEventListener('pointerup',finish); handle.addEventListener('pointercancel',finish); handle.addEventListener('lostpointercapture',finish);
  }
  function renderPreview() { $('#description-preview').innerHTML = markdown($('#edit-description').value, true); $('#title-preview').innerHTML = markdown($('#edit-title').value); }
  $('#description-toggle').addEventListener('click', () => { preview=!preview; $('#description-preview').hidden=!preview; $('#title-preview').hidden=!preview; $('#description-toggle').textContent=preview ? 'Скрыть предпросмотр' : 'Предпросмотр Markdown'; renderPreview(); });
  $('#edit-description').addEventListener('input',renderPreview); $('#edit-title').addEventListener('input',renderPreview);
  async function files(task, seq) {
    const result=await api(`/tasks/${task.id}/attachments`); if (seq !== sequence) return;
    $('#attachment-list').replaceChildren();
    for (const file of result.files) {
      const row=document.createElement('div'); row.className='attachment-row';
      const link=document.createElement('a'); link.href=`/api/tasks/${task.id}/attachments/${file.id}`; link.textContent=`${file.name} · ${(file.size/1024).toFixed(1)} КБ`; link.download=file.name;
      const remove=document.createElement('button'); remove.type='button'; remove.className='icon-button'; remove.textContent='×'; remove.setAttribute('aria-label',`Удалить файл ${file.name}`);
      remove.onclick=async () => { if (!confirm(`Удалить файл «${file.name}»?`)) return; remove.disabled=true; try { await api(`/tasks/${task.id}/attachments/${file.id}`,{method:'DELETE'}); await files(task,seq); } catch(e) { $('#attachment-error').textContent=e.message; remove.disabled=false; } };
      row.append(link,remove); $('#attachment-list').append(row);
    }
  }
  $('#attachment-input').addEventListener('change',async e => {
    const task=current, seq=sequence, selected=[...e.target.files]; e.target.disabled=true; $('#attachment-error').textContent='';
    try {
      for (const file of selected) {
        if(file.size>20*1024*1024) throw Error('Файл больше 20 МБ');
        const response=await fetch(`/api/tasks/${task.id}/attachments`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file});
        if(!response.ok) throw Error((await response.json()).error || 'Не удалось загрузить файл');
      }
      if(seq===sequence) await files(task,seq);
    } catch(e) { if(seq===sequence) { $('#attachment-error').textContent=e.message; await files(task,seq); } }
    finally { $('#attachment-input').disabled=false; $('#attachment-input').value=''; }
  });
  $('#edit-project').addEventListener('change', () => { $('#edit-parent').replaceChildren(new Option('Самостоятельная задача','')); });
  $('#edit-section').addEventListener('change', () => { $('#edit-parent').value=''; });
  function open(task) {
    current=task; const seq=++sequence; $('#edit-description').value=task.description || ''; preview=false; $('#description-preview').hidden=true; $('#title-preview').hidden=true; $('#description-toggle').textContent='Предпросмотр Markdown';
    $('#attachment-list').replaceChildren(); $('#attachment-error').textContent=''; files(task,seq).catch(e=>{if(seq===sequence) $('#attachment-error').textContent=e.message;});
    const select=$('#edit-parent'); select.replaceChildren(new Option('Самостоятельная задача',''));
    const children=descendants(getTasks(),task.id);
    for(const {task:t,depth} of orderedTree(getTasks().filter(t=>(t.projectId ?? null)===(task.projectId ?? null) && (!t.completedAt || t.id===task.parentId) && t.id!==task.id && !children.has(t.id)))) select.add(new Option(`${'— '.repeat(depth)}${t.title}`,t.id));
    select.value=task.parentId || '';
  }
  async function saveParent(task, previousParent) {
    const parentId=$('#edit-parent').value || null;
    if(parentId !== (previousParent ?? null)) { await reload(); const fresh=getTasks().find(t=>t.id===task.id); await api(`/tasks/${task.id}/move`,{method:'POST',body:{parentId,previous:snapshot(fresh)}}); }
  }
  return {decorate,open,saveParent};
}
