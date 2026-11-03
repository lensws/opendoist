import { markdown } from './markdown.js';
export function initGlobalSearch({api,openTask,openNote,selectView}) {
  const host=document.querySelector('#global-search'), status=document.querySelector('#search-status'), list=document.querySelector('#search-results');
  let sequence=0,timer;
  const labels={tasks:'Задачи',completed:'Выполненные задачи',projects:'Проекты',sections:'Разделы',notes:'Заметки',history:'История выполнений'};
  function hide(){sequence++;clearTimeout(timer);host.hidden=true;list.replaceChildren();}
  function show(query){
    const seq=++sequence;clearTimeout(timer);host.hidden=false;list.replaceChildren();status.textContent='Поиск…';
    timer=setTimeout(async()=>{
      try{
        const result=await api(`/search?q=${encodeURIComponent(query)}`);
        if(seq!==sequence)return;
        status.textContent=result.total?`Найдено: ${result.total}`:'Ничего не найдено. Попробуйте другой запрос.';
        for(const [kind,group] of Object.entries(result.groups)){
          if(!group.total)continue;
          const heading=document.createElement('h3');heading.textContent=`${labels[kind]} · ${group.total}`;list.append(heading);
          for(const item of group.items){
            const row=document.createElement(kind==='history'?'article':'button');row.className='search-result';
            if(kind!=='history'){
              row.type='button';row.addEventListener('click',()=>{
                if(kind==='notes')openNote(item.id);
                else if(kind==='projects'||kind==='sections')selectView(`${kind==='projects'?'project':'section'}:${item.id}`);
                else openTask(item.id);
              });
            }
            const title=document.createElement('span');if(['tasks','completed','history'].includes(kind)){title.className='markdown';title.innerHTML=markdown(item.title);title.querySelectorAll('a').forEach(a=>a.replaceWith(...a.childNodes));}else title.textContent=item.title;row.append(title);
            const context=[item.context,item.completedAt?`Выполнено ${new Date(item.completedAt).toLocaleString('ru')}`:''].filter(Boolean).join(' · ');
            if(context){const small=document.createElement('small');small.textContent=context;row.append(small);}
            list.append(row);
          }
          if(group.total>group.items.length){const more=document.createElement('p');more.className='muted small';more.textContent='Показаны первые 50 результатов. Уточните запрос.';list.append(more);}
        }
      }catch(e){if(seq===sequence)status.textContent=e.message;}
    },180);
  }
  return {show,hide};
}
