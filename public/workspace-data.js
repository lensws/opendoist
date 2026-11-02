// Independent reads run together: one network round trip instead of three.
export async function fetchWorkspace(api, includeHistory = false) {
  const [settings, tasks, projects, history] = await Promise.all([
    api('/settings'), api('/tasks'), api('/projects'),
    includeHistory ? api('/history') : undefined,
  ]);
  return { settings: settings.settings, tasks: tasks.tasks, ...projects,
    ...(history ? { history: history.history } : {}) };
}
