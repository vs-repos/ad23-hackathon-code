import { NextResponse, type NextRequest } from 'next/server';

/*
 * Proxies same-origin /api/* to the backend. BACKEND_ORIGIN is read per request
 * with bracket notation so Next cannot inline it at build time, and so a missing
 * or invalid value degrades to a 503 instead of breaking `next build`.
 */
export function middleware(request: NextRequest) {
  const raw = process.env['BACKEND_ORIGIN']?.trim() ?? '';
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    return NextResponse.json(
      {
        code: 'BACKEND_NOT_CONFIGURED',
        message: 'Set BACKEND_ORIGIN to an http(s) origin',
        details: [],
      },
      { status: 503 },
    );
  }
  const origin = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const { pathname, search } = request.nextUrl;
  return NextResponse.rewrite(new URL(`${origin}${pathname}${search}`));
}

export const config = { matcher: '/api/:path*' };
