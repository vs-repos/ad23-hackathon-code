/** Shared "is this run exportable" guard for both export routes. */
import type Database from 'better-sqlite3';

import type { ConferenceRow, RunRow } from './db';
import { ApiError } from './errors';
import type { GridSpec } from './scheduler';
import { loadGrid, loadTalks } from './services';

export function exportable(
  db: Database.Database,
  runId: number,
): { run: RunRow; conference: ConferenceRow; grid: GridSpec; interests: Map<number, number> } {
  const run = db.prepare('SELECT * FROM schedule_run WHERE id = ?').get(runId) as RunRow | undefined;
  if (!run) throw new ApiError(404, 'NOT_FOUND', `run ${runId} not found`);
  if (run.status === 'draft' || run.status === 'failed') {
    throw new ApiError(409, 'RUN_NOT_EXPORTABLE', `a run in status ${run.status} cannot be exported`, [
      { field: 'status', problem: 'not_exportable', received: run.status },
    ]);
  }
  const conference = db
    .prepare('SELECT * FROM conference WHERE id = ?')
    .get(run.conference_id) as ConferenceRow;
  const grid = loadGrid(db, conference);
  const interests = new Map(loadTalks(db, conference).map((t) => [t.id, t.interest]));
  return { run, conference, grid, interests };
}
