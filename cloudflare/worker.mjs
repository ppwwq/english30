// Public Cloudflare deployment. Study records remain in the learner's browser.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) {
      if (path === '/api/health' && ['GET', 'HEAD'].includes(request.method)) {
        const response = Response.json(
          { ok: true, release: env.RELEASE },
          { headers: { 'Cache-Control': 'no-store' } },
        );
        return request.method === 'HEAD' ? new Response(null, response) : response;
      }
      return new Response('Not found', { status: 404 });
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (!path.startsWith('/audio/') && !path.startsWith('/papers/audio/')) return env.ASSETS.fetch(request);

    // Native Assets currently ignores Range. Fetch the bounded audio file, then
    // answer Safari's byte probes and seeks with a genuine partial response.
    const sourceHeaders = new Headers(request.headers);
    sourceHeaders.delete('Range');
    sourceHeaders.delete('If-Range');
    const source = await env.ASSETS.fetch(new Request(request, { method: 'GET', headers: sourceHeaders }));
    if (source.status !== 200) return source;
    const headers = new Headers(source.headers);
    headers.set('Accept-Ranges', 'bytes');
    if (request.method === 'HEAD') {
      // Assets HEAD drops Content-Length; its GET metadata has the real size.
      if (!headers.has('Content-Length'))
        headers.set('Content-Length', String((await source.arrayBuffer()).byteLength));
      else await source.body?.cancel();
      return new Response(null, { status: 200, headers });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
    const ifRange = request.headers.get('If-Range');
    const validatorMatches =
      !ifRange ||
      (!ifRange.startsWith('W/') &&
        (ifRange.startsWith('"')
          ? ifRange === headers.get('ETag')
          : Number.isFinite(Date.parse(ifRange)) &&
            Date.parse(headers.get('Last-Modified')) <= Date.parse(ifRange)));
    if (!match || (!match[1] && !match[2]) || !validatorMatches)
      return new Response(source.body, { status: 200, headers });
    const bytes = await source.arrayBuffer();
    const size = bytes.byteLength;
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
      headers.set('Content-Range', `bytes */${size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
  },
};
