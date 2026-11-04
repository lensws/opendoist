// Only passive media formats may be served inline. HTML and SVG stay downloads.
const types = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', avif:'image/avif', bmp:'image/bmp',
  mp4:'video/mp4', m4v:'video/mp4', webm:'video/webm', mov:'video/quicktime', ogv:'video/ogg',
  mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', wav:'audio/wav', ogg:'audio/ogg', oga:'audio/ogg', opus:'audio/ogg', flac:'audio/flac',
};
export function attachmentMediaType(name) {
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return Object.hasOwn(types, extension) ? types[extension] : null;
}
export function serveAttachment(req, res, file, headers, readData = () => file.data) {
  const type = new URL(req.url, 'http://localhost').searchParams.get('preview') === '1' && attachmentMediaType(file.name);
  const size = file.size ?? file.data.length;
  const etag = `"attachment-${file.id}-${type ? 'preview' : 'download'}"`;
  const responseHeaders = { ...headers, 'Cache-Control':'private, no-cache', 'ETag':etag, 'Vary':'Cookie', 'Content-Type':type || 'application/octet-stream',
    'Content-Disposition':`${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`,
    'Content-Security-Policy':"default-src 'none'; sandbox", 'Accept-Ranges':'bytes' };
  // Authorization and attachment existence have already been checked by the route.
  // Revalidate every reuse so logout/deletion still revokes access, without retransmitting the file.
  if (req.headers['if-none-match']?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
    res.writeHead(304, responseHeaders); return res.end();
  }
  let start = 0, end = size - 1, status = 200;
  if (type && req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    } else start = size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      res.writeHead(416, { ...responseHeaders, 'Content-Range':`bytes */${size}`, 'Content-Length':0 }); return res.end();
    }
    status = 206; responseHeaders['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  responseHeaders['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, responseHeaders);
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(readData()).subarray(start, end + 1));
}
