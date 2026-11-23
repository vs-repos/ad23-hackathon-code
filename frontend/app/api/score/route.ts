export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { ApiError, errorResponse, readJson } from '../../../lib/errors';
import { scoreTalk } from '../../../lib/llm_score';
import { validateScoreRequest } from '../../../lib/wire';

/** Propose interest and heavy. No database write; the operator saves. */
export async function POST(request: Request): Promise<Response> {
  try {
    const payload = validateScoreRequest(await readJson(request));
    return Response.json(await scoreTalk(payload.title.trim(), payload.abstract, payload.length_min));
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    console.error('[api/score] unhandled', error);
    return Response.json({ code: 'INTERNAL_ERROR', message: 'database error', details: [] }, { status: 500 });
  }
}
