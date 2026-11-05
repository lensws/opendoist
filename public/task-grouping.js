export function categoryGroups(tasks, projects, sections) {
  const groups=new Map();
  for(const task of tasks) {
    const project=projects.find(p=>p.id===task.projectId), section=sections.find(s=>s.id===task.sectionId && s.projectId===project?.id);
    const key=JSON.stringify([project?.id || null,section?.id || null]);
    if(!groups.has(key)) groups.set(key,{key,projectId:project?.id || null,sectionId:section?.id || null,title:project ? `${project.name} · ${section?.name || 'Без раздела'}` : 'Входящие',tasks:[]});
    groups.get(key).tasks.push(task);
  }
  return [...groups.values()].sort((a,b)=>projects.findIndex(p=>p.id===a.projectId)-projects.findIndex(p=>p.id===b.projectId) || sections.findIndex(s=>s.id===a.sectionId)-sections.findIndex(s=>s.id===b.sectionId));
}
