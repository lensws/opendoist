// Deliberately small Markdown subset. Raw HTML is always escaped.
const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function inlineMarkdown(source, depth = 0) {
  if (depth > 8) return escape(source);
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let out = '', offset = 0;
  for (const m of source.matchAll(pattern)) {
    out += escape(source.slice(offset, m.index)); offset = m.index + m[0].length;
    if (m[1]) out += `<code>${escape(m[1])}</code>`;
    else if (m[2]) {
      let safe = false; try { safe = ['https:', 'http:', 'mailto:'].includes(new URL(m[3]).protocol); } catch { /* Plain text for invalid links. */ }
      out += safe ? `<a href="${escape(m[3])}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(m[2], depth + 1)}</a>` : escape(m[0]);
    } else { const value = m[4] || m[5] || m[6] || m[7] || m[8], tag = m[4] || m[5] ? 'strong' : m[6] ? 'del' : 'em'; out += `<${tag}>${inlineMarkdown(value, depth + 1)}</${tag}>`; }
  }
  return out + escape(source.slice(offset));
}
export function markdown(source = '', block = false) {
  if (!block) return inlineMarkdown(source);
  let code = null, out = '', list = null;
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of source.split('\n')) {
    if (line.startsWith('```')) { closeList(); if (code === null) code = []; else { out += `<pre><code>${escape(code.join('\n'))}</code></pre>`; code = null; } continue; }
    if (code !== null) { code.push(line); continue; }
    const item = /^(?:[-*] |\d+\. )(.*)$/.exec(line);
    if (item) { const type = /^\d/.test(line) ? 'ol' : 'ul'; if (list !== type) { closeList(); list = type; out += `<${list}>`; } out += `<li>${inlineMarkdown(item[1])}</li>`; continue; }
    closeList();
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) out += `<h${heading[1].length + 2}>${inlineMarkdown(heading[2])}</h${heading[1].length + 2}>`;
    else if (line.startsWith('> ')) out += `<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`;
    else out += line ? `<p>${inlineMarkdown(line)}</p>` : '<br>';
  }
  closeList(); if (code !== null) out += `<pre><code>${escape(code.join('\n'))}</code></pre>`;
  return out;
}
