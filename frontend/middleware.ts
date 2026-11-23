import { NextResponse, type NextRequest } from 'next/server';

/*
 * Split deployments proxy same-origin /api/* to an external backend. When no
 * http(s) origin is configured (the single-container case) the request is left
 * alone so it reaches the in-app route handlers under app/api/.
 * BACKEND_ORIGIN is read per request with bracket notation, never inlined.
 */
export function middleware(request: NextRequest) {
  const raw = process.env['BACKEND_ORIGIN']?.trim() ?? '';
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    return NextResponse.next();
  }
  const origin = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const { pathname, search } = request.nextUrl;
  return NextResponse.rewrite(new URL(`${origin}${pathname}${search}`));
}

export const config = { matcher: '/api/:path*' };
