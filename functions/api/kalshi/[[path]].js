/* Cloudflare Pages Function: same-origin proxy for Kalshi's public trade API.
   Kalshi (api.elections.kalshi.com) sends no Access-Control-Allow-Origin header,
   so browsers cannot call it directly (CORS-blocked). This function forwards the
   request server-side and returns the JSON with `access-control-allow-origin: *`.
   No auth, no secrets — the upstream API is public. */

const UPSTREAM = 'https://api.elections.kalshi.com/trade-api/v2';

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '86400',
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign(
      { 'content-type': 'application/json; charset=utf-8' },
      corsHeaders()
    ),
  });
}

export async function onRequest(context) {
  const request = context.request;
  const params = context.params || {};

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  const segs = params.path || [];
  // Defensive: reject path traversal / odd characters (Pages routing already
  // decodes segments; tickers are [A-Z0-9-]).
  for (const s of segs) {
    if (s === '..' || s === '.' || /[^a-zA-Z0-9_\-.]/.test(s)) {
      return jsonResponse({ error: 'bad_path' }, 400);
    }
  }

  const url = new URL(request.url);
  const target = UPSTREAM + '/' + segs.join('/') + url.search;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        accept: 'application/json',
        'user-agent': 'rung-desk-pages/1.0',
      },
    });
  } catch (e) {
    return jsonResponse(
      { error: 'upstream_unreachable', detail: String((e && e.message) || e) },
      502
    );
  }

  let body;
  try {
    body = await upstream.text();
  } catch (e) {
    return jsonResponse({ error: 'upstream_read_failed' }, 502);
  }

  const headers = corsHeaders();
  headers['content-type'] =
    upstream.headers.get('content-type') || 'application/json';
  headers['cache-control'] = 'no-store';
  return new Response(body, { status: upstream.status, headers: headers });
}
