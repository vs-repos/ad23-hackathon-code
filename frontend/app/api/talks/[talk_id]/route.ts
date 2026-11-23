export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { ApiError, readJson } from '../../../../lib/errors';
import { handleRoute, requireConference } from '../../../../lib/http';
import { SLOT_MINUTES } from '../../../../lib/scheduler';
import {
  getOrCreateSpeaker,
  pinsInLatestRun,
  replaceWindows,
  talkOrNull,
  talkPayload,
} from '../../../../lib/services';
import { resolvePathId, validateTalkIn, type TalkIn } from '../../../../lib/wire';

function sources(payload: TalkIn): { interest_source: string; heavy_source: string; ai_reason: string | null } {
  const interestSource = payload.interest_source || 'manual';
  const heavySource = payload.heavy_source || 'manual';
  const aiReason = interestSource === 'ai' || heavySource === 'ai' ? payload.ai_reason : null;
  return { interest_source: interestSource, heavy_source: heavySource, ai_reason: aiReason };
}

function talkOr404(talkId: number) {
  return (db: import('better-sqlite3').Database) => {
    const talk = talkOrNull(db, talkId);
    if (!talk) throw new ApiError(404, 'NOT_FOUND', `talk ${talkId} not found`);
    return talk;
  };
}

function guardPinned(talkId: number) {
  return (db: import('better-sqlite3').Database) => {
    const conference = requireConference(db);
    if (pinsInLatestRun(db, conference).has(talkId)) {
      throw new ApiError(
        409,
        'TALK_PINNED',
        'talk is pinned in the latest run; unpin it by omitting it from the next solve',
        [{ talk_id: talkId, problem: 'pinned' }],
      );
    }
  };
}

export async function GET(
  _request: Request,
  { params }: { params: { talk_id: string } },
): Promise<Response> {
  return handleRoute((db) => {
    const talkId = resolvePathId(params.talk_id);
    return Response.json(talkPayload(db, talkOr404(talkId)(db)));
  });
}

export async function PUT(
  request: Request,
  { params }: { params: { talk_id: string } },
): Promise<Response> {
  return handleRoute(async (db) => {
    const talkId = resolvePathId(params.talk_id);
    const payload = validateTalkIn(await readJson(request));
    const talk = talkOr404(talkId)(db);
    guardPinned(talkId)(db);

    const speakerId = getOrCreateSpeaker(db, payload.speaker_name.trim());
    const row = sources(payload);
    db.prepare(
      `UPDATE talk SET title = ?, abstract = ?, length_minutes = ?, slots_needed = ?, interest = ?, heavy = ?,
         speaker_id = ?, interest_source = ?, heavy_source = ?, ai_reason = ?
       WHERE id = ?`,
    ).run(
      payload.title.trim(),
      payload.abstract,
      payload.length_minutes,
      Math.floor(payload.length_minutes / SLOT_MINUTES),
      payload.interest,
      payload.heavy ? 1 : 0,
      speakerId,
      row.interest_source,
      row.heavy_source,
      row.ai_reason,
      talk.id,
    );
    replaceWindows(db, talk.id, payload.availability, payload.unavailability);

    const updated = talkOrNull(db, talk.id);
    return Response.json(updated ? talkPayload(db, updated) : {});
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { talk_id: string } },
): Promise<Response> {
  return handleRoute((db) => {
    const talkId = resolvePathId(params.talk_id);
    const talk = talkOr404(talkId)(db);
    guardPinned(talkId)(db);
    // Windows cascade with the talk; past assignments keep pointing at its id
    // and run_payload skips them, exactly like the Python cascade rules.
    db.prepare('DELETE FROM availability_window WHERE talk_id = ?').run(talk.id);
    db.prepare('DELETE FROM talk WHERE id = ?').run(talk.id);
    return new Response(null, { status: 204 });
  });
}
