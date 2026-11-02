// Shared deterministic ordering; legacy tasks keep their original creation order.
export function compareTasks(a, b) {
  return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}
export function descendants(tasks, id) {
  const found = new Set(), pending = [id];
  while (pending.length) { const parent = pending.pop(); for (const t of tasks) if (t.parentId === parent && !found.has(t.id)) { found.add(t.id); pending.push(t.id); } }
  return found;
}
export function orderedTree(tasks, compare = compareTasks) {
  const ids = new Set(tasks.map(t => t.id)), result = [], seen = new Set();
  function visit(parent, depth) {
    for (const task of tasks.filter(t => (ids.has(t.parentId) ? t.parentId : null) === parent).sort(compare)) {
      if (seen.has(task.id)) continue;
      seen.add(task.id); result.push({ task, depth }); visit(task.id, depth + 1);
    }
  }
  visit(null, 0); return result;
}
