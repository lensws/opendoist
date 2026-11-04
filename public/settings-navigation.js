export function initSettingsNavigation() {
  const $=s=>document.querySelector(s),dialog=$('#settings-dialog'),form=$('#settings-form');
  const heading=form.querySelector('.dialog-heading');dialog.prepend(heading);
  const layout=document.createElement('div');layout.className='settings-layout';
  const nav=document.createElement('nav');nav.className='settings-nav';nav.setAttribute('aria-label','Разделы настроек');
  const content=document.createElement('div');content.className='settings-content';
  layout.append(nav,content);dialog.append(layout);content.append(form);
  const groups=[['account','Учётная запись','○'],['general','Основное','⚙'],['appearance','Оформление','◐'],['notifications','Уведомления','♧'],['data','Данные','⇄'],['backups','Резервные копии','↥']];
  const panels=new Map(),buttons=new Map();let loaded=new Set();
  for(const [id,title,icon] of groups){
    const panel=document.createElement('section');panel.id=`settings-${id}`;panel.hidden=true;panel.className='settings-panel';
    const h=document.createElement('h3');h.textContent=title;panel.append(h);panels.set(id,panel);
    (['general','appearance','data'].includes(id)?form:content).append(panel);
    const button=document.createElement('button');button.type='button';button.className='settings-nav-item';button.setAttribute('aria-controls',panel.id);
    const symbol=document.createElement('span');symbol.textContent=icon;symbol.setAttribute('aria-hidden','true');if(id==='notifications')symbol.innerHTML='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';button.append(symbol,document.createTextNode(title));nav.append(button);buttons.set(id,button);
    button.onclick=()=>select(id,true);
  }
  panels.get('account').append($('#account-template').content.cloneNode(true));
  const fields=[...form.querySelectorAll(':scope > fieldset')];
  panels.get('general').append(fields[0]);panels.get('data').append(fields[1]);panels.get('appearance').append(...fields.slice(2));
  panels.get('data').append(form.querySelector('.task-transfer'));form.querySelector('.task-transfer').open=true;
  const timezone=$('#timezone');let current=timezone.previousElementSibling;
  while(current && current.id!=='settings-error'){const next=current.nextElementSibling;panels.get('general').append(current);current=next;}
  form.querySelector('.settings-divider').remove();
  for(const id of ['backups-open','notifications-open']){const button=$(`#${id}`);button.hidden=true;dialog.append(button);}
  const footer=form.querySelector('.dialog-actions'),error=$('#settings-error');form.append(error,footer);
  for(const [id,formId] of [['notifications','notifications-form'],['backups','backup-form']]){
    const embedded=$(`#${formId}`);embedded.querySelector('.dialog-heading').remove();
    embedded.querySelectorAll('[data-close]').forEach(button=>button.dataset.close='settings-dialog');panels.get(id).append(embedded);
  }
  function select(id,load=false){
    for(const [key,panel] of panels)panel.hidden=key!==id;
    for(const [key,button] of buttons){button.classList.toggle('active',key===id);if(key===id)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
    form.hidden=!['general','appearance','data'].includes(id);footer.hidden=id==='data';error.hidden=id==='data';content.scrollTop=0;
    if(load && ['notifications','backups'].includes(id) && !loaded.has(id)){loaded.add(id);$(`#${id}-open`).click();}
  }
  $('#settings-open').addEventListener('click',()=>select('general'));
  dialog.addEventListener('settings-section',event=>{loaded.add(event.detail);select(event.detail);});
  dialog.addEventListener('close',()=>{loaded=new Set();});
  dialog.addEventListener('settings-load-error',event=>loaded.delete(event.detail));
  form.addEventListener('invalid',event=>{const panel=event.target.closest('.settings-panel');if(panel){select(panel.id.replace('settings-',''));}},true);
  select('general');
}
