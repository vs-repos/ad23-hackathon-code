export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { exportable } from '../../../../../lib/exportRun';
import { handleRoute } from '../../../../../lib/http';
import { resolvePathId } from '../../../../../lib/wire';
import { exportPayload } from '../../../../../lib/services';

export async function GET(
  _request: Request,
  { params }: { params: { run_id: string } },
): Promise<Response> {
  return handleRoute((db) => {
    const runId = resolvePathId(params.run_id);
    const { run, conference, grid, interests } = exportable(db, runId);
    return Response.json(exportPayload(db, conference, run, grid, interests));
  });
}
