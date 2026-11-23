export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { FixedBlockRow } from '../../../lib/db';
import { handleRoute, requireConference } from '../../../lib/http';
import { gridPayload, loadGrid } from '../../../lib/services';

export async function GET(): Promise<Response> {
  return handleRoute((db) => {
    const conference = requireConference(db);
    const grid = loadGrid(db, conference);
    const blocks = db
      .prepare('SELECT * FROM fixed_block WHERE conference_id = ? ORDER BY id')
      .all(conference.id) as FixedBlockRow[];
    return Response.json(gridPayload(grid, blocks));
  });
}
