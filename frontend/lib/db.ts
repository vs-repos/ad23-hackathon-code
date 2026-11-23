/**
 * SQLite persistence, equivalent to code/backend/app/db.py + seed.py.
 *
 * `better-sqlite3` is synchronous, so no connection pool and no async plumbing.
 * One connection per process, created on first use.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import demoFile from '../data/demo_talks.json';
import { DEFAULT_SCORING, defaultGrid, scoringToDict, SLOT_MINUTES, type ScoringConfig } from './scheduler';

export const CONFERENCE_NAME = 'Analyst Days';
export const SOLVER_VERSION = 'mvp-1';

export type ConferenceRow = {
  id: number;
  name: string;
  days: number;
  slot_minutes: number;
  scoring_config: string;
};

export type TalkRow = {
  id: number;
  conference_id: number;
  speaker_id: number;
  title: string;
  abstract: string | null;
  length_minutes: number;
  slots_needed: number;
  interest: number;
  heavy: number;
  interest_source: string;
  heavy_source: string;
  ai_reason: string | null;
};

export type WindowRow = {
  id: number;
  talk_id: number;
  kind: string;
  day: number;
  start_minute: number;
  end_minute: number;
};

export type FixedBlockRow = {
  id: number;
  conference_id: number;
  kind: string;
  label: string;
  day: number;
  start_minute: number;
  end_minute: number;
  room_codes: string;
};

export type RunRow = {
  id: number;
  conference_id: number;
  status: string;
  placed_count: number;
  objective_total: number | null;
  objective_breakdown: string | null;
  unplaced: string;
  pins_used: string;
  partial: number;
  solver_version: string;
  duration_ms: number;
  created_at: string;
};

export type AssignmentRow = {
  id: number;
  run_id: number;
  talk_id: number;
  room_id: number;
  day: number;
  start_slot: number;
  end_slot: number;
  pinned: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conference (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(200) NOT NULL,
  days INTEGER NOT NULL DEFAULT 2,
  slot_minutes INTEGER NOT NULL DEFAULT 20,
  scoring_config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS room (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conference_id INTEGER NOT NULL REFERENCES conference(id),
  code VARCHAR(8) NOT NULL,
  capacity_ignored INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS speaker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(200) NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS talk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conference_id INTEGER NOT NULL REFERENCES conference(id),
  speaker_id INTEGER NOT NULL REFERENCES speaker(id),
  title VARCHAR(300) NOT NULL,
  abstract TEXT,
  length_minutes INTEGER NOT NULL,
  slots_needed INTEGER NOT NULL,
  interest INTEGER NOT NULL,
  heavy INTEGER NOT NULL DEFAULT 0,
  interest_source VARCHAR(8) NOT NULL DEFAULT 'manual',
  heavy_source VARCHAR(8) NOT NULL DEFAULT 'manual',
  ai_reason TEXT
);
CREATE TABLE IF NOT EXISTS availability_window (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  talk_id INTEGER NOT NULL REFERENCES talk(id),
  kind VARCHAR(16) NOT NULL,
  day INTEGER NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fixed_block (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conference_id INTEGER NOT NULL REFERENCES conference(id),
  kind VARCHAR(16) NOT NULL,
  label VARCHAR(100) NOT NULL,
  day INTEGER NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  room_codes TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS schedule_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conference_id INTEGER NOT NULL REFERENCES conference(id),
  status VARCHAR(16) NOT NULL,
  placed_count INTEGER NOT NULL DEFAULT 0,
  objective_total REAL,
  objective_breakdown TEXT,
  unplaced TEXT NOT NULL DEFAULT '[]',
  pins_used TEXT NOT NULL DEFAULT '[]',
  partial INTEGER NOT NULL DEFAULT 0,
  solver_version VARCHAR(32) NOT NULL DEFAULT 'mvp-1',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES schedule_run(id),
  talk_id INTEGER NOT NULL REFERENCES talk(id),
  room_id INTEGER NOT NULL REFERENCES room(id),
  day INTEGER NOT NULL,
  start_slot INTEGER NOT NULL,
  end_slot INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
`;

export function dbPath(): string {
  return process.env['AGENDA_DB_PATH'] || '/tmp/agenda.db';
}

let connection: Database.Database | null = null;

export function getDb(): Database.Database {
  if (connection) return connection;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // SQLAlchemy left SQLite's FK enforcement off, so a deleted talk never blocks
  // on its old assignments; run_payload skips rows whose talk is gone.
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  // A crash-left draft becomes failed on start (SDS §3).
  db.prepare("UPDATE schedule_run SET status = 'failed' WHERE status = 'draft'").run();
  seedIfEmpty(db);
  connection = db;
  return db;
}

type DemoWindow = { day: number; start_minute: number; end_minute: number };
type DemoTalk = {
  speaker_name: string;
  title: string;
  abstract?: string | null;
  length_minutes: number;
  interest: number;
  heavy?: boolean;
  interest_source?: string;
  heavy_source?: string;
  availability?: DemoWindow[];
  unavailability?: DemoWindow[];
};

export function seedIfEmpty(db: Database.Database): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM conference').get() as { n: number };
  if (row.n > 0) return;

  const grid = defaultGrid();
  const insertConference = db.prepare(
    'INSERT INTO conference (name, days, slot_minutes, scoring_config, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertRoom = db.prepare('INSERT INTO room (conference_id, code) VALUES (?, ?)');
  const insertBlock = db.prepare(
    'INSERT INTO fixed_block (conference_id, kind, label, day, start_minute, end_minute, room_codes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertSpeaker = db.prepare('INSERT INTO speaker (name) VALUES (?)');
  const insertTalk = db.prepare(
    `INSERT INTO talk (conference_id, speaker_id, title, abstract, length_minutes, slots_needed,
       interest, heavy, interest_source, heavy_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertWindow = db.prepare(
    'INSERT INTO availability_window (talk_id, kind, day, start_minute, end_minute) VALUES (?, ?, ?, ?, ?)',
  );

  db.transaction(() => {
    const conferenceId = Number(
      insertConference.run(
        CONFERENCE_NAME,
        2,
        grid.slot_minutes,
        JSON.stringify(scoringToDict(DEFAULT_SCORING)),
        new Date().toISOString(),
      ).lastInsertRowid,
    );
    for (const code of grid.rooms) insertRoom.run(conferenceId, code);
    for (const b of grid.fixed_blocks) {
      insertBlock.run(conferenceId, b.kind, b.label, b.day, b.start_minute, b.end_minute, JSON.stringify(b.room_codes));
    }

    const speakers = new Map<string, number>();
    for (const talk of (demoFile as { talks: DemoTalk[] }).talks) {
      let speakerId = speakers.get(talk.speaker_name);
      if (speakerId === undefined) {
        speakerId = Number(insertSpeaker.run(talk.speaker_name).lastInsertRowid);
        speakers.set(talk.speaker_name, speakerId);
      }
      const talkId = Number(
        insertTalk.run(
          conferenceId,
          speakerId,
          talk.title,
          talk.abstract ?? null,
          talk.length_minutes,
          Math.floor(talk.length_minutes / SLOT_MINUTES),
          talk.interest,
          talk.heavy ? 1 : 0,
          talk.interest_source || 'manual',
          talk.heavy_source || 'manual',
        ).lastInsertRowid,
      );
      for (const [kind, windows] of [
        ['AVAILABLE', talk.availability ?? []],
        ['UNAVAILABLE', talk.unavailability ?? []],
      ] as const) {
        for (const w of windows) insertWindow.run(talkId, kind, w.day, w.start_minute, w.end_minute);
      }
    }
  })();
}

/** One conference per database (SDS §2). */
export function singleConference(db: Database.Database): ConferenceRow | null {
  const row = db.prepare('SELECT * FROM conference ORDER BY id LIMIT 1').get() as ConferenceRow | undefined;
  return row ?? null;
}

export function conferenceScoring(conference: ConferenceRow | null | undefined): ScoringConfig {
  if (!conference) return { ...DEFAULT_SCORING };
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(conference.scoring_config || '{}') as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return scoringFromParsed(parsed);
}

function scoringFromParsed(parsed: Record<string, unknown>): ScoringConfig {
  const out = { ...DEFAULT_SCORING } as ScoringConfig;
  for (const key of Object.keys(DEFAULT_SCORING) as (keyof ScoringConfig)[]) {
    const value = parsed[key];
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
