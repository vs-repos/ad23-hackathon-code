export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { ApiError, readJson } from '../../../lib/errors';
import { handleRoute, requireConference } from '../../../lib/http';
import { SLOT_MINUTES } from '../../../lib/scheduler';
import {
  getOrCreateSpeaker,
  loadTalks,
  MAX_TALKS,
  replaceWindows,
  talkPayload,
  talkOrNull,
} from '../../../lib/services';
import type { TalkIn } from '../../../lib/wire';
import { validateTalkIn } from '../../../lib/wire';

/** D-08: an omitted source means the operator typed the value. */
function applySources(payload: TalkIn): {
  interest_source: string;
  heavy_source: string;
  ai_reason: string | null;
} {
  const interestSource = payload.interest_source || 'manual';
  const heavySource = payload.heavy_source || 'manual';
  const aiReason = interestSource === 'ai' || heavySource === 'ai' ? payload.ai_reason : null;
  return { interest_source: interestSource, heavy_source: heavySource, ai_reason: aiReason };
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute((db) => {
    const conference = requireConference(db);
    const talks = loadTalks(db, conference);
    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const start = offsetParam ? Number(offsetParam) : 0;
    const end = limitParam ? start + Number(limitParam) : undefined;
    return Response.json({
      items: talks.slice(start, end).map((t) => talkPayload(db, t)),
      total: talks.length,
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async (db) => {
    const payload = validateTalkIn(await readJson(request));
    const conference = requireConference(db);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM talk WHERE conference_id = ?').get(conference.id) as {
      n: number;
    }).n;
    if (count >= MAX_TALKS) {
      throw new ApiError(409, 'TALK_LIMIT_EXCEEDED', `a conference holds at most ${MAX_TALKS} talks`, [
        { field: 'talks', problem: 'limit_reached', allowed: `<= ${MAX_TALKS}` },
      ]);
    }

    const speakerId = getOrCreateSpeaker(db, payload.speaker_name.trim());
    const sources = applySources(payload);
    const talkId = Number(
      db
        .prepare(
          `INSERT INTO talk (conference_id, speaker_id, title, abstract, length_minutes, slots_needed,
             interest, heavy, interest_source, heavy_source, ai_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conference.id,
          speakerId,
          payload.title.trim(),
          payload.abstract,
          payload.length_minutes,
          Math.floor(payload.length_minutes / SLOT_MINUTES),
          payload.interest,
          payload.heavy ? 1 : 0,
          sources.interest_source,
          sources.heavy_source,
          sources.ai_reason,
        ).lastInsertRowid,
    );
    replaceWindows(db, talkId, payload.availability, payload.unavailability);

    const talk = talkOrNull(db, talkId);
    return Response.json(talk ? talkPayload(db, talk) : {}, { status: 201 });
  });
}
