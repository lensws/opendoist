const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
export function searchWorkspace(store, query) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const result = {};
  if (!terms.length) return {groups:result,total:0};
  const matches = (...values) => { const text = normalize(values.join(' ')); return terms.every(term => text.includes(term)); };
  const projects = store.projects(), sections = store.sections();
  const placement = task => [projects.find(p=>p.id===task.projectId)?.name, sections.find(s=>s.id===task.sectionId)?.name].filter(Boolean).join(' / ');
  const add = (kind, rows) => { result[kind] = {total:rows.length,items:rows.slice(0,50)}; };
  const tasks = store.list();
  const found = tasks.filter(t=>matches(t.title,t.description,placement(t)));
  add('tasks',found.filter(t=>!t.completedAt).map(t=>({id:t.id,title:t.title,context:placement(t)})));
  add('completed',found.filter(t=>t.completedAt).map(t=>({id:t.id,title:t.title,context:placement(t)})));
  add('projects',projects.filter(p=>matches(p.name)).map(p=>({id:p.id,title:p.name})));
  add('sections',sections.filter(s=>matches(s.name,projects.find(p=>p.id===s.projectId)?.name)).map(s=>({id:s.id,title:s.name,context:projects.find(p=>p.id===s.projectId)?.name})));
  // Return only metadata; potentially large note bodies stay on the server.
  add('notes',store.notes(true).filter(n=>matches(n.title,n.body)).map(n=>({id:n.id,title:n.title})));
  add('history',store.history(true).filter(h=>matches(h.task.title,h.task.description,placement(h.task))).map(h=>({id:h.task.id,title:h.task.title,context:placement(h.task),completedAt:h.completedAt})));
  return {groups:result,total:Object.values(result).reduce((sum,g)=>sum+g.total,0)};
}
