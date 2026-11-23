export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type Database from 'better-sqlite3';

import { singleConference, type ConferenceRow } from '../../../lib/db';
import { ApiError, readJson, ValidationFailure } from '../../../lib/errors';
import { handleRoute, requireConference } from '../../../lib/http';
import { scoringOut } from '../../../lib/services';
import { validateConferencePatch } from '../../../lib/wire';

function conferenceOut(conference: ConferenceRow): Record<string, unknown> {
  return {
    id: conference.id,
    name: conference.name,
    days: conference.days,
    slot_minutes: conference.slot_minutes,
    scoring: scoringOut(conference),
  };
}

export async function GET(): Promise<Response> {
  return handleRoute((db) => Response.json(conferenceOut(requireConference(db))));
}

export async function PATCH(request: Request): Promise<Response> {
  return handleRoute(async (db: Database.Database) => {
    const conference = requireConference(db);
    const patch = validateConferencePatch(await readJson(request));

    if (patch.name !== undefined) {
      if (!patch.name.trim()) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'name must not be blank', [
          { field: 'name', problem: 'must not be blank' },
        ]);
      }
      conference.name = patch.name.trim();
    }

    if (patch.scoring !== undefined) {
      const details: Record<string, unknown>[] = [];
      for (const [key, value] of Object.entries(patch.scoring)) {
        if (key === 'solve_timeout_ms' && value < 1) {
          details.push({ field: `scoring.${key}`, problem: 'must be >= 1' });
        } else if (key !== 'solve_timeout_ms' && value < 0) {
          details.push({ field: `scoring.${key}`, problem: 'must be >= 0' });
        }
      }
      if (details.length > 0) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'scoring config rejected', details);
      }
    }

    const current = singleConference(db) ?? conference;
    let stored: Record<string, unknown> = {};
    try {
      stored = JSON.parse(current.scoring_config || '{}') as Record<string, unknown>;
    } catch {
      stored = {};
    }
    if (patch.scoring !== undefined) Object.assign(stored, patch.scoring);

    db.prepare('UPDATE conference SET name = ?, scoring_config = ? WHERE id = ?').run(
      patch.name !== undefined ? patch.name.trim() : conference.name,
      JSON.stringify(stored),
      conference.id,
    );

    const updated = { ...conference, name: patch.name !== undefined ? patch.name.trim() : conference.name, scoring_config: JSON.stringify(stored) };
    return Response.json(conferenceOut(updated));
  });
}
