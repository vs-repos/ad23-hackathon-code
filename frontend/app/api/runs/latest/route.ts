export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { RunRow } from '../../../../lib/db';
import { ApiError } from '../../../../lib/errors';
import { handleRoute, requireConference } from '../../../../lib/http';
import { loadGrid, loadTalks, runPayload } from '../../../../lib/services';

export async function GET(): Promise<Response> {
  return handleRoute((db) => {
    const conference = requireConference(db);
    const run = db
      .prepare('SELECT * FROM schedule_run WHERE conference_id = ? ORDER BY id DESC LIMIT 1')
      .get(conference.id) as RunRow | undefined;
    if (!run) throw new ApiError(404, 'NOT_FOUND', 'no run has been created yet');
    const grid = loadGrid(db, conference);
    const interests = new Map(loadTalks(db, conference).map((t) => [t.id, t.interest]));
    return Response.json(runPayload(db, run, grid, interests));
  });
}
