export function matchesSubmitShortcut(event, shortcut = 'enter') {
  if (event.key !== 'Enter' || event.isComposing || event.repeat || event.altKey || event.shiftKey || event.defaultPrevented) return false;
  return shortcut === 'ctrl-enter' ? Boolean(event.ctrlKey || event.metaKey) : !event.ctrlKey && !event.metaKey;
}
