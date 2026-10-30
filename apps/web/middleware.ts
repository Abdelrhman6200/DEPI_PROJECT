import { NextResponse, type NextRequest } from 'next/server';

/**
 * Second guard for the API proxy (the first is the narrow rewrite in next.config.ts). Behind the public tunnel no Caddy
 * server checks requests, so the same rule as the server's Caddyfile applies here: a path with an encoded dot, slash,
 * backslash or NUL, or a literal "." / ".." segment, is refused before any routing or rewriting. Query strings are not
 * checked (they legitimately carry encoded paths, e.g. /login?next=%2Fapp%2Ftoday).
 */
export function middleware(req: NextRequest) {
  const raw = req.url;
  const start = raw.indexOf('/', raw.indexOf('//') + 2);
  const q = raw.indexOf('?', start);
  const path = start < 0 ? '/' : raw.slice(start, q < 0 ? undefined : q);
  if (/%2e|%2f|%5c|%00/i.test(path) || /(^|\/)\.{1,2}(\/|$)/.test(path)) {
    return new NextResponse('Bad request', { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.next();
}
