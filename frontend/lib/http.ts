/** Shared route plumbing: one error shape and the single-conference lookup. */
import type Database from 'better-sqlite3';

import { getDb, singleConference, type ConferenceRow } from './db';
import { ApiError, errorResponse } from './errors';

export async function handleRoute(fn: (db: Database.Database) => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn(getDb());
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    console.error('[api] unhandled', error);
    return Response.json({ code: 'INTERNAL_ERROR', message: 'database error', details: [] }, { status: 500 });
  }
}

export function requireConference(db: Database.Database): ConferenceRow {
  const conference = singleConference(db);
  if (conference === null) {
    throw new ApiError(404, 'NOT_FOUND', 'no conference configured');
  }
  return conference;
}
