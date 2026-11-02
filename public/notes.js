import { markdown } from './markdown.js';
export function initNotes({api, notify}) {
  const $=s=>document.querySelector(s), host=$('#notes-view'), dialog=$('#note-dialog');
  let notes=[], selected=null, baseline='', saving=false, sequence=0, refreshSequence=0, openSequence=0, query='';
  const value=()=>JSON.stringify({title:$('#note-title').value,body:$('#note-body').value});
  const dirty=()=>dialog.open && value()!==baseline;
  const message=e=>{ $('#note-error').textContent=e.message; };
  function draw() {
    const list=$('#notes-list'); list.replaceChildren();
    const visible=notes.filter(n=>n.title.toLocaleLowerCase().includes(query));
    $('#notes-empty').hidden=!!visible.length;
    $('#notes-empty').textContent=query?'Заметки не найдены.':'Пока нет заметок.';
    for(const note of visible) {
      const button=document.createElement('button'); button.type='button'; button.className='note-card'; button.textContent=note.title;
      button.addEventListener('click',()=>open(note.id)); list.append(button);
    }
  }
  async function refresh() {
    const generation=sequence, seq=++refreshSequence;
    try { const result=await api('/notes'); if(generation!==sequence || seq!==refreshSequence)return; notes=result.notes; draw(); $('#notes-error').textContent=''; }
    catch(e) { if(generation===sequence && seq===refreshSequence) $('#notes-error').textContent=e.message; }
  }
  async function open(id=null) {
    const generation=sequence, seq=++openSequence;
    try {
      const note=id?(await api(`/notes/${id}`)).note:null;
      if(generation!==sequence || seq!==openSequence)return;
      selected=note; $('#note-title').value=note?.title || ''; $('#note-body').value=note?.body || '';
      baseline=value(); $('#note-error').textContent=''; $('#note-delete').hidden=!note;
      $('#note-preview').hidden=true; $('#note-body').hidden=false; $('#note-preview-toggle').textContent='Предпросмотр';
      $('#note-preview').replaceChildren(); dialog.showModal(); $('#note-title').focus();
    } catch(e) { notify(e.message); }
  }
  function close() {
    if(saving)return;
    if(dirty() && !confirm('Закрыть заметку без сохранения изменений?'))return;
    dialog.close();
  }
  $('#note-new').addEventListener('click',()=>open());
  $('#note-close').addEventListener('click',close);
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue='';}});
  $('#note-preview-toggle').addEventListener('click',()=>{
    const preview=$('#note-preview'), showing=preview.hidden;
    if(showing) preview.innerHTML=markdown($('#note-body').value,true);
    preview.hidden=!showing; $('#note-body').hidden=showing;
    $('#note-preview-toggle').textContent=showing?'Редактировать':'Предпросмотр';
  });
  function busy(state) {
    saving=state;
    for(const el of $('#note-form').querySelectorAll('button,input,textarea')) el.disabled=state;
  }
  $('#note-form').addEventListener('submit',async e=>{
    e.preventDefault(); if(saving)return; busy(true); $('#note-error').textContent='';
    try {
      await api(`/notes${selected?'/'+selected.id:''}`,{method:selected?'PATCH':'POST',body:{title:$('#note-title').value,body:$('#note-body').value,revision:selected?.revision}});
      baseline=value(); dialog.close(); await refresh(); notify('Заметка сохранена');
    }catch(e){message(e);}finally{busy(false);}
  });
  $('#note-form').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing){e.preventDefault();$('#note-form').requestSubmit();}
  });
  $('#note-delete').addEventListener('click',async()=>{
    if(!selected || saving || !confirm(`Удалить заметку «${selected.title}»?`))return;
    busy(true);$('#note-error').textContent='';
    try{await api(`/notes/${selected.id}`,{method:'DELETE',body:{revision:selected.revision}});baseline=value();dialog.close();await refresh();notify('Заметка удалена');}
    catch(e){message(e);}finally{busy(false);}
  });
  return {
    show(search='') {const next=search.trim().toLocaleLowerCase(), refreshNeeded=host.hidden || next===query;query=next;host.hidden=false;draw();if(refreshNeeded)refresh();},
    hide() {host.hidden=true;openSequence++;},
    reset() {sequence++;notes=[];selected=null;baseline=value();draw();host.hidden=true;},
  };
}
