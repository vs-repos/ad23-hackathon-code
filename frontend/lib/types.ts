export type Window = { day: number; start_minute: number; end_minute: number };

/** D-08: who supplied the score. Omitted on the wire means "manual". */
export type ScoreSource = 'ai' | 'manual';

export type Talk = {
  id: number;
  title: string;
  abstract: string | null;
  speaker_name: string;
  length_minutes: number;
  slots_needed: number;
  interest: number;
  heavy: boolean;
  interest_source: ScoreSource;
  heavy_source: ScoreSource;
  ai_reason: string | null;
  availability: Window[];
  unavailability: Window[];
};

export type ScoreSuggestion = { interest: number; heavy: boolean; reason: string };

/** D-09: one clock hour of a narrated day; `cumulative` restarts per day. */
export type HourScore = {
  day: number;
  hour_start: string;
  hour_interest: number;
  cumulative: number;
};

export type GridSlot = {
  day: number;
  slot_index: number;
  start_time: string;
  end_time: string;
  room_code: string;
  assignable: boolean;
  blocked_by: string | null;
};

export type FixedBlock = {
  kind: string;
  label: string;
  day: number;
  start_minute: number;
  end_minute: number;
  start_time: string | null;
  end_time: string | null;
  room_codes: string[];
};

export type GridDay = {
  day: number;
  start_time: string | null;
  end_time: string | null;
  slots: GridSlot[];
  fixed_blocks: FixedBlock[];
};

export type Grid = { slot_minutes: number; rooms: string[]; days: GridDay[] };

export type Placement = {
  talk_id: number;
  title: string;
  speaker_name: string;
  room_code: string;
  day: number;
  start_slot: number;
  end_slot: number;
  start_time: string;
  end_time: string;
  interest: number;
  rhythm: number;
  contribution: number;
  pinned: boolean;
};

export type UnplacedTalk = {
  talk_id: number;
  title: string;
  speaker_name?: string | null;
  reasons: string[];
  diagnosis: string;
};

export type Breakdown = {
  talks: Placement[];
  penalty_collision: number;
  penalty_heavy: number;
  objective_total: number;
};

export type Pin = { talk_id: number; day: number; room_code: string; start_slot: number };

export type Run = {
  id: number;
  status: 'draft' | 'solved' | 'infeasible' | 'failed';
  placed_count: number;
  objective_total: number | null;
  breakdown: Breakdown | null;
  unplaced: UnplacedTalk[];
  pins_used: Pin[];
  partial: boolean;
  duration_ms: number;
  hour_scores: HourScore[];
  created_at: string | null;
};

export type Scoring = {
  rhythm_early: number;
  rhythm_late_morning: number;
  rhythm_post_lunch: number;
  rhythm_late_afternoon: number;
  rhythm_last_slot: number;
  collision_penalty: number;
  heavy_late_penalty: number;
  solve_timeout_ms: number;
};

export type Conference = {
  id: number;
  name: string;
  days: number;
  slot_minutes: number;
  scoring: Scoring;
};

export type ApiErrorBody = { code: string; message: string; details: { field?: string; problem?: string }[] };
