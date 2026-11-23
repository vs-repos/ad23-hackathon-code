export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { readJson } from '../../../lib/errors';
import { handleRoute, requireConference } from '../../../lib/http';
import { pinProblemDetail, type Pin } from '../../../lib/scheduler';
import { loadGrid, loadTalks, persistRun, runPayload, runSolver } from '../../../lib/services';
import { validateRunRequest } from '../../../lib/wire';

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async (db) => {
    const payload = validateRunRequest(await readJson(request));
    const conference = requireConference(db);
    const talks = loadTalks(db, conference);
    if (talks.length === 0) {
      return Response.json(
        {
          code: 'VALIDATION_ERROR',
          message: 'a run needs at least one talk',
          details: [{ field: 'talks', problem: 'empty' }],
        },
        { status: 422 },
      );
    }

    const known = new Set(talks.map((t) => t.id));
    const unknown = payload.pins
      .filter((p) => !known.has(p.talk_id))
      .map((p) => ({ talk_id: p.talk_id, problem: 'unknown_talk' }));
    if (unknown.length > 0) {
      return Response.json(
        { code: 'VALIDATION_ERROR', message: 'pin references an unknown talk', details: unknown },
        { status: 422 },
      );
    }

    const pinPayloads: Pin[] = payload.pins.map((p) => ({
      talk_id: p.talk_id,
      day: p.day,
      room_code: p.room_code,
      start_slot: p.start_slot,
    }));
    const solved = runSolver(db, conference, pinPayloads, payload.scoring_override);

    if (solved.result.pin_problems.length > 0) {
      return Response.json(
        {
          code: 'PIN_CONFLICT',
          message: 'the pin cannot be satisfied',
          details: solved.result.pin_problems.map(pinProblemDetail),
        },
        { status: 409 },
      );
    }

    const run = persistRun(
      db,
      conference,
      solved.result,
      pinPayloads,
      solved.duration_ms,
      solved.result.timed_out,
    );
    const grid = loadGrid(db, conference);
    const body = runPayload(db, run, grid, solved.interests);

    if (solved.result.timed_out) {
      return Response.json(
        { code: 'SOLVE_TIMEOUT', message: 'the solver hit its wall-clock cap', details: [], run: body },
        { status: 504 },
      );
    }
    return Response.json(body, { status: 201 });
  });
}
