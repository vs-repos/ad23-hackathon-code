/**
 * Shell layer: maps SQLite rows to the pure solver's plain structures and back.
 * A port of code/backend/app/services.py — no scheduling rule lives here.
 */
import type Database from 'better-sqlite3';

import {
  conferenceScoring,
  nowIso,
  parseJson,
  SOLVER_VERSION,
  type AssignmentRow,
  type ConferenceRow,
  type FixedBlockRow,
  type RunRow,
  type TalkRow,
  type WindowRow,
} from './db';
import {
  GridSpec,
  DAY_START_MINUTE,
  DEFAULT_DAY_SLOTS,
  solve,
  scoringFromDict,
  scoringToDict,
  type GridSpec as GridSpecType,
  type Pin,
  type Placement,
  type SolveResult,
  type TalkSpec,
  type Window,
} from './scheduler';

export const MAX_TALKS = 80;

// --------------------------------------------------------------------------- //
// Grid
// --------------------------------------------------------------------------- //

export function loadGrid(db: Database.Database, conference: ConferenceRow): GridSpecType {
  const blocks = db
    .prepare('SELECT * FROM fixed_block WHERE conference_id = ? ORDER BY id')
    .all(conference.id) as FixedBlockRow[];
  const rooms = (
    db.prepare('SELECT code FROM room WHERE conference_id = ?').all(conference.id) as { code: string }[]
  )
    .map((r) => r.code)
    .sort();
  return new GridSpec(
    rooms,
    conference.slot_minutes,
    DAY_START_MINUTE,
    { ...DEFAULT_DAY_SLOTS },
    blocks.map((b) => ({
      kind: b.kind,
      label: b.label,
      day: b.day,
      start_minute: b.start_minute,
      end_minute: b.end_minute,
      room_codes: parseJson<string[]>(b.room_codes, []),
    })),
  );
}

export function gridPayload(grid: GridSpecType, blocks: FixedBlockRow[]): Record<string, unknown> {
  const days = [];
  for (const day of grid.day_numbers()) {
    const slots = [];
    for (const room of grid.rooms) {
      for (let slot = 0; slot < grid.slots_per_day[day]; slot += 1) {
        const block = grid.block_at(day, room, slot);
        slots.push({
          day,
          slot_index: slot,
          start_time: grid.time_label(slot * grid.slot_minutes),
          end_time: grid.time_label((slot + 1) * grid.slot_minutes),
          room_code: room,
          assignable: block === null,
          blocked_by: block === null ? null : block.kind,
        });
      }
    }
    days.push({
      day,
      start_time: grid.time_label(0),
      end_time: grid.time_label(grid.slots_per_day[day] * grid.slot_minutes),
      slots,
      fixed_blocks: blocks
        .filter((b) => b.day === day)
        .map((b) => ({
          kind: b.kind,
          label: b.label,
          day: b.day,
          start_minute: b.start_minute,
          end_minute: b.end_minute,
          start_time: grid.time_label(b.start_minute),
          end_time: grid.time_label(b.end_minute),
          room_codes: parseJson<string[]>(b.room_codes, []),
        })),
    });
  }
  return { slot_minutes: grid.slot_minutes, rooms: [...grid.rooms], days };
}

// --------------------------------------------------------------------------- //
// Talks
// --------------------------------------------------------------------------- //

function speakerName(db: Database.Database, speakerId: number): string {
  const row = db.prepare('SELECT name FROM speaker WHERE id = ?').get(speakerId) as { name: string } | undefined;
  return row?.name ?? '';
}

function windowsFor(db: Database.Database, talkId: number, kind: string): Window[] {
  const rows = db
    .prepare('SELECT * FROM availability_window WHERE talk_id = ? AND kind = ? ORDER BY id')
    .all(talkId, kind) as WindowRow[];
  return rows.map((w) => ({ day: w.day, start_minute: w.start_minute, end_minute: w.end_minute }));
}

export function talkPayload(db: Database.Database, talk: TalkRow): Record<string, unknown> {
  return {
    id: talk.id,
    title: talk.title,
    abstract: talk.abstract,
    speaker_name: speakerName(db, talk.speaker_id),
    length_minutes: talk.length_minutes,
    slots_needed: talk.slots_needed,
    interest: talk.interest,
    heavy: Boolean(talk.heavy),
    interest_source: talk.interest_source || 'manual',
    heavy_source: talk.heavy_source || 'manual',
    ai_reason: talk.ai_reason,
    availability: windowsFor(db, talk.id, 'AVAILABLE'),
    unavailability: windowsFor(db, talk.id, 'UNAVAILABLE'),
  };
}

export function talkSpec(db: Database.Database, talk: TalkRow): TalkSpec {
  return {
    id: talk.id,
    title: talk.title,
    speaker_name: speakerName(db, talk.speaker_id),
    length_minutes: talk.length_minutes,
    interest: talk.interest,
    heavy: Boolean(talk.heavy),
    availability: windowsFor(db, talk.id, 'AVAILABLE'),
    unavailability: windowsFor(db, talk.id, 'UNAVAILABLE'),
  };
}

export function getOrCreateSpeaker(db: Database.Database, name: string): number {
  const existing = db.prepare('SELECT id FROM speaker WHERE name = ?').get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO speaker (name) VALUES (?)').run(name).lastInsertRowid);
}

export function replaceWindows(
  db: Database.Database,
  talkId: number,
  availability: Window[],
  unavailability: Window[],
): void {
  db.prepare('DELETE FROM availability_window WHERE talk_id = ?').run(talkId);
  const insert = db.prepare(
    'INSERT INTO availability_window (talk_id, kind, day, start_minute, end_minute) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [kind, windows] of [
    ['AVAILABLE', availability],
    ['UNAVAILABLE', unavailability],
  ] as const) {
    for (const w of windows) insert.run(talkId, kind, w.day, w.start_minute, w.end_minute);
  }
}

export function loadTalks(db: Database.Database, conference: ConferenceRow): TalkRow[] {
  return db.prepare('SELECT * FROM talk WHERE conference_id = ? ORDER BY id').all(conference.id) as TalkRow[];
}

export function talkOrNull(db: Database.Database, talkId: number): TalkRow | null {
  return (db.prepare('SELECT * FROM talk WHERE id = ?').get(talkId) as TalkRow | undefined) ?? null;
}

// --------------------------------------------------------------------------- //
// Hour scores (D-09)
// --------------------------------------------------------------------------- //

/**
 * Per clock hour of each day: interest of every talking room, then a running
 * total. A talk contributes its full interest to every hour block it overlaps,
 * never a prorated share (D-09). Hours with no placed talk are absent.
 */
export function hourScores(grid: GridSpecType, interests: Map<number, number>, talksOut: Placement[]): Record<string, unknown>[] {
  const perHour = new Map<string, number>();
  for (const t of talksOut) {
    const interest = interests.get(t.talk_id);
    if (interest === undefined) continue;
    const startMinute = t.start_slot * grid.slot_minutes;
    const endMinute = t.end_slot * grid.slot_minutes;
    for (let hour = Math.floor(startMinute / 60) * 60; hour < endMinute; hour += 60) {
      const key = `${t.day}:${hour}`;
      perHour.set(key, (perHour.get(key) ?? 0) + interest);
    }
  }

  const entries: { day: number; hour: number; value: number }[] = [];
  perHour.forEach((value, key) => {
    const [day, hour] = key.split(':').map(Number);
    entries.push({ day, hour, value });
  });
  entries.sort((a, b) => a.day - b.day || a.hour - b.hour);

  const scores: Record<string, unknown>[] = [];
  let running = 0;
  for (const entry of entries) {
    running += entry.value;
    scores.push({
      day: entry.day,
      hour_start: grid.time_label(entry.hour),
      hour_interest: entry.value,
      cumulative: running,
    });
  }
  return scores;
}

// --------------------------------------------------------------------------- //
// Runs
// --------------------------------------------------------------------------- //

export type RunSolverOutput = {
  result: SolveResult;
  grid: GridSpecType;
  interests: Map<number, number>;
  duration_ms: number;
};

export function runSolver(
  db: Database.Database,
  conference: ConferenceRow,
  pins: Pin[],
  scoringOverride: Record<string, unknown> | null,
): RunSolverOutput {
  const grid = loadGrid(db, conference);
  const configData: Record<string, unknown> = { ...conferenceScoring(conference) };
  if (scoringOverride) {
    for (const [key, value] of Object.entries(scoringOverride)) {
      if (value !== undefined && value !== null) configData[key] = value;
    }
  }
  const config = scoringFromDict(configData);

  const talks = loadTalks(db, conference);
  const specs = talks.map((t) => talkSpec(db, t));

  const started = Date.now();
  const result = solve({ grid, talks: specs, pins, config }, 200_000, config.solve_timeout_ms / 1000);
  const durationMs = Date.now() - started;

  return {
    result,
    grid,
    interests: new Map(talks.map((t) => [t.id, t.interest])),
    duration_ms: durationMs,
  };
}

export function persistRun(
  db: Database.Database,
  conference: ConferenceRow,
  result: SolveResult,
  pinPayloads: Pin[],
  durationMs: number,
  forceFailed = false,
): RunRow {
  const status = forceFailed ? 'failed' : result.status;
  let breakdown: Record<string, number> | null = null;
  if (result.placements.length > 0) {
    breakdown = {
      penalty_collision: result.score.penalty_collision,
      penalty_heavy: result.score.penalty_heavy,
      objective_total: result.score.objective_total,
    };
  }
  const createdAt = nowIso();
  const runId = Number(
    db
      .prepare(
        `INSERT INTO schedule_run (conference_id, status, placed_count, objective_total, objective_breakdown,
           unplaced, pins_used, partial, solver_version, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conference.id,
        status,
        result.placed_count,
        breakdown === null ? null : result.score.objective_total,
        breakdown === null ? null : JSON.stringify(breakdown),
        JSON.stringify(
          result.unplaced.map((u) => ({
            talk_id: u.talk_id,
            title: u.title,
            speaker_name: u.speaker_name,
            reasons: u.reasons,
            diagnosis: u.diagnosis,
          })),
        ),
        JSON.stringify(pinPayloads.map((p) => ({
          talk_id: p.talk_id,
          day: p.day,
          room_code: p.room_code,
          start_slot: p.start_slot,
        }))),
        result.timed_out ? 1 : 0,
        SOLVER_VERSION,
        durationMs,
        createdAt,
      ).lastInsertRowid,
  );

  const rooms = new Map(
    (db.prepare('SELECT id, code FROM room WHERE conference_id = ?').all(conference.id) as {
      id: number;
      code: string;
    }[]).map((r) => [r.code, r.id]),
  );
  const insertAssignment = db.prepare(
    'INSERT INTO assignment (run_id, talk_id, room_id, day, start_slot, end_slot, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const p of result.placements) {
    insertAssignment.run(runId, p.talk_id, rooms.get(p.room_code), p.day, p.start_slot, p.end_slot, p.pinned ? 1 : 0);
  }

  return db.prepare('SELECT * FROM schedule_run WHERE id = ?').get(runId) as RunRow;
}

export function pinsInLatestRun(db: Database.Database, conference: ConferenceRow): Set<number> {
  const latest = db
    .prepare('SELECT * FROM schedule_run WHERE conference_id = ? ORDER BY id DESC LIMIT 1')
    .get(conference.id) as RunRow | undefined;
  if (!latest) return new Set();
  const pins = parseJson<{ talk_id: number }[]>(latest.pins_used, []);
  return new Set(pins.map((p) => Number(p.talk_id)));
}

export function runPayload(
  db: Database.Database,
  run: RunRow,
  grid: GridSpecType,
  interests: Map<number, number>,
): Record<string, unknown> {
  const talks = db.prepare('SELECT * FROM talk WHERE conference_id = ?').all(run.conference_id) as TalkRow[];
  const talkRows = new Map(talks.map((t) => [t.id, t]));
  const rooms = new Map(
    (db.prepare('SELECT id, code FROM room WHERE conference_id = ?').all(run.conference_id) as {
      id: number;
      code: string;
    }[]).map((r) => [r.id, r.code]),
  );
  const conference = db.prepare('SELECT * FROM conference WHERE id = ?').get(run.conference_id) as
    | ConferenceRow
    | undefined;
  const config = conferenceScoring(conference);

  const assignments = db
    .prepare('SELECT * FROM assignment WHERE run_id = ?')
    .all(run.id) as AssignmentRow[];
  assignments.sort(
    (a, b) => a.day - b.day || a.start_slot - b.start_slot || a.room_id - b.room_id || a.talk_id - b.talk_id,
  );

  const talksOut: Placement[] = [];
  const interestMap = new Map<number, number>();
  for (const a of assignments) {
    const talk = talkRows.get(a.talk_id);
    if (!talk) continue;
    const roomCode = rooms.get(a.room_id) ?? '';
    const rhythm = grid.rhythm(a.day, roomCode, a.start_slot, config);
    interestMap.set(a.talk_id, talk.interest);
    talksOut.push({
      talk_id: a.talk_id,
      title: talk.title,
      speaker_name: speakerName(db, talk.speaker_id),
      room_code: roomCode,
      day: a.day,
      start_slot: a.start_slot,
      end_slot: a.end_slot,
      start_time: grid.time_label(a.start_slot * grid.slot_minutes),
      end_time: grid.time_label(a.end_slot * grid.slot_minutes),
      interest: talk.interest,
      rhythm,
      contribution: round6(talk.interest * rhythm),
      pinned: Boolean(a.pinned),
    });
  }

  const storedBreakdown = parseJson<Record<string, number> | null>(run.objective_breakdown, null);
  let breakdown: Record<string, unknown> | null = null;
  if (storedBreakdown !== null) {
    breakdown = {
      talks: talksOut,
      penalty_collision: storedBreakdown['penalty_collision'] ?? 0,
      penalty_heavy: storedBreakdown['penalty_heavy'] ?? 0,
      objective_total: storedBreakdown['objective_total'] ?? 0,
    };
  }

  return {
    id: run.id,
    status: run.status,
    placed_count: run.placed_count,
    objective_total: run.objective_total,
    breakdown,
    unplaced: parseJson(run.unplaced, []),
    pins_used: parseJson(run.pins_used, []),
    partial: Boolean(run.partial),
    duration_ms: run.duration_ms,
    hour_scores: hourScores(grid, interestMap, talksOut),
    created_at: run.created_at ?? null,
  };
}

export function exportPayload(
  db: Database.Database,
  conference: ConferenceRow,
  run: RunRow,
  grid: GridSpecType,
  interests: Map<number, number>,
): Record<string, unknown> {
  const payload = runPayload(db, run, grid, interests) as {
    breakdown: { talks: Placement[] } | null;
    unplaced: { talk_id: number; title: string; speaker_name?: string; reasons: string[]; diagnosis: string }[];
    hour_scores: unknown[];
    objective_total: number | null;
  };
  const talks = payload.breakdown ? payload.breakdown.talks : [];
  return {
    conference: { name: conference.name, days: conference.days, slot_minutes: conference.slot_minutes },
    run: {
      id: run.id,
      status: run.status,
      objective_total: payload.objective_total,
      partial: Boolean(run.partial),
    },
    placed: talks.map((t) => ({
      day: t.day,
      room_code: t.room_code,
      start_time: t.start_time,
      end_time: t.end_time,
      speaker_name: t.speaker_name,
      title: t.title,
      interest: t.interest,
      pinned: t.pinned,
    })),
    hour_scores: payload.hour_scores,
    unplaced: payload.unplaced.map((u) => ({
      talk_id: u.talk_id,
      title: u.title,
      speaker_name: u.speaker_name ?? '',
      reasons: u.reasons,
      diagnosis: u.diagnosis,
    })),
  };
}

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function scoringOut(conference: ConferenceRow): Record<string, number> {
  return scoringToDict(conferenceScoring(conference)) as unknown as Record<string, number>;
}
