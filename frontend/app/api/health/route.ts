export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VERSION = '0.1.0';

/** Liveness only — never touches the database. */
export function GET(): Response {
  return Response.json({ status: 'ok', version: VERSION });
}
