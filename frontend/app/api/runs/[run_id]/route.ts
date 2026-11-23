export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { ConferenceRow, RunRow } from '../../../../lib/db';
import { ApiError } from '../../../../lib/errors';
import { handleRoute } from '../../../../lib/http';
import { loadGrid, loadTalks, runPayload } from '../../../../lib/services';
import { resolvePathId } from '../../../../lib/wire';

export async function GET(
  _request: Request,
  { params }: { params: { run_id: string } },
): Promise<Response> {
  return handleRoute((db) => {
    const runId = resolvePathId(params.run_id);
    const run = db.prepare('SELECT * FROM schedule_run WHERE id = ?').get(runId) as RunRow | undefined;
    if (!run) throw new ApiError(404, 'NOT_FOUND', `run ${runId} not found`);
    const conference = db
      .prepare('SELECT * FROM conference WHERE id = ?')
      .get(run.conference_id) as ConferenceRow;
    const grid = loadGrid(db, conference);
    const interests = new Map(loadTalks(db, conference).map((t) => [t.id, t.interest]));
    return Response.json(runPayload(db, run, grid, interests));
  });
}
