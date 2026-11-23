/**
 * Pure agenda scheduler — a line-by-line port of code/backend/app/scheduler.py.
 *
 * No next, no sqlite, no network. Everything is a function of its arguments.
 * `Date.now` is read only when the caller passes a time limit, and the
 * wall-clock cap is reported, never thrown.
 */

export const SLOT_MINUTES = 20;
export const DAY_START_MINUTE = 9 * 60; // 09:00, the origin for every minute offset
export const SLOTS_IN_DAY = 64; // bitmask stride: one day of slots fits in an int

const EARLY_MORNING_END_MINUTE = 120; // 11:00
const LATE_AFTERNOON_START_MINUTE = 420; // 16:00

export const DEFAULT_DAY_SLOTS: Record<number, number> = { 1: 30, 2: 27 };
export const DEFAULT_ROOMS: string[] = ['A', 'B', 'C', 'D'];

// Reasons ordered the way they are reported.
export const AVAILABILITY_REASONS = [
  'outside_availability',
  'unavailability_overlap',
  'fixed_block',
  'room_dark',
  'no_free_slot',
  'pin_conflict',
];

// --------------------------------------------------------------------------- //
// Input
// --------------------------------------------------------------------------- //

export type FixedBlock = {
  kind: string;
  label: string;
  day: number;
  start_minute: number;
  end_minute: number;
  room_codes: string[]; // empty = all rooms
};

export type ScoringConfig = {
  rhythm_early: number;
  rhythm_late_morning: number;
  rhythm_post_lunch: number;
  rhythm_late_afternoon: number;
  rhythm_last_slot: number;
  collision_penalty: number;
  heavy_late_penalty: number;
  solve_timeout_ms: number;
};

export const SCORING_FIELDS: (keyof ScoringConfig)[] = [
  'rhythm_early',
  'rhythm_late_morning',
  'rhythm_post_lunch',
  'rhythm_late_afternoon',
  'rhythm_last_slot',
  'collision_penalty',
  'heavy_late_penalty',
  'solve_timeout_ms',
];

export const DEFAULT_SCORING: ScoringConfig = {
  rhythm_early: 0.6,
  rhythm_late_morning: 1.0,
  rhythm_post_lunch: 1.1,
  rhythm_late_afternoon: 0.8,
  rhythm_last_slot: 0.5,
  collision_penalty: 3.0,
  heavy_late_penalty: 2.0,
  solve_timeout_ms: 10000,
};

export function scoringToDict(config: ScoringConfig): ScoringConfig {
  const out = {} as ScoringConfig;
  for (const name of SCORING_FIELDS) out[name] = config[name] as never;
  return out;
}

export function scoringFromDict(data: Record<string, unknown> | null | undefined): ScoringConfig {
  if (!data) return { ...DEFAULT_SCORING };
  const values: Record<string, unknown> = {};
  for (const name of SCORING_FIELDS) {
    const value = data[name];
    if (value !== undefined && value !== null) values[name] = value;
  }
  return { ...DEFAULT_SCORING, ...values } as ScoringConfig;
}

export class GridSpec {
  constructor(
    readonly rooms: string[],
    readonly slot_minutes: number,
    readonly day_start_minute: number,
    readonly slots_per_day: Record<number, number>,
    readonly fixed_blocks: FixedBlock[],
  ) {}

  // -- geometry ----------------------------------------------------------- //

  day_numbers(): number[] {
    return Object.keys(this.slots_per_day)
      .map(Number)
      .sort((a, b) => a - b);
  }

  time_label(minute_of_day: number): string {
    const total = this.day_start_minute + minute_of_day;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  block_at(day: number, room: string, slot: number): FixedBlock | null {
    const minute = slot * this.slot_minutes;
    for (const block of this.fixed_blocks) {
      if (block.day !== day) continue;
      if (block.room_codes.length > 0 && !block.room_codes.includes(room)) continue;
      if (block.start_minute <= minute && minute < block.end_minute) return block;
    }
    return null;
  }

  /** `null` when assignable, else the reason code for one slot. */
  blocking_kind(day: number, room: string, slot: number): string | null {
    if (!(day in this.slots_per_day) || slot < 0 || slot >= this.slots_per_day[day]) {
      return 'does_not_fit';
    }
    const block = this.block_at(day, room, slot);
    if (block === null) return null;
    return block.room_codes.length > 0 ? 'room_dark' : 'fixed_block';
  }

  is_assignable(day: number, room: string, slot: number): boolean {
    return this.blocking_kind(day, room, slot) === null;
  }

  lunch_slots(day: number, room: string): [number, number] | null {
    for (const block of this.fixed_blocks) {
      if (block.day !== day || block.kind !== 'LUNCH') continue;
      if (block.room_codes.length > 0 && !block.room_codes.includes(room)) continue;
      return [
        Math.floor(block.start_minute / this.slot_minutes),
        Math.floor(block.end_minute / this.slot_minutes),
      ];
    }
    return null;
  }

  last_assignable_slot(day: number, room: string): number {
    let last: number | null = null;
    for (let slot = 0; slot < this.slots_per_day[day]; slot += 1) {
      if (this.is_assignable(day, room, slot)) last = slot;
    }
    return last === null ? -1 : last;
  }

  heavy_late_slots(day: number, room: string): Set<number> {
    const starts: number[] = [];
    for (let slot = 0; slot < this.slots_per_day[day]; slot += 1) {
      if (this.is_assignable(day, room, slot)) starts.push(slot);
    }
    return new Set(starts.slice(-2));
  }

  /** One multiplier per start; bands are disjoint (SDS §6.4). */
  rhythm(day: number, room: string, start_slot: number, config: ScoringConfig): number {
    const start_minute = start_slot * this.slot_minutes;
    if (start_slot === this.last_assignable_slot(day, room)) return config.rhythm_last_slot;
    if (start_minute < EARLY_MORNING_END_MINUTE) return config.rhythm_early;
    const lunch = this.lunch_slots(day, room);
    if (lunch === null) {
      return start_minute < LATE_AFTERNOON_START_MINUTE
        ? config.rhythm_post_lunch
        : config.rhythm_late_afternoon;
    }
    if (start_slot < lunch[0]) return config.rhythm_late_morning;
    if (start_slot < lunch[1] || start_minute < LATE_AFTERNOON_START_MINUTE) return config.rhythm_post_lunch;
    return config.rhythm_late_afternoon;
  }
}

export type Window = { day: number; start_minute: number; end_minute: number };

export type TalkSpec = {
  id: number;
  title: string;
  speaker_name: string;
  length_minutes: number;
  interest: number;
  heavy: boolean;
  availability: Window[];
  unavailability: Window[];
};

export function slotsNeeded(talk: TalkSpec): number {
  return Math.floor(talk.length_minutes / SLOT_MINUTES);
}

export type Pin = { talk_id: number; day: number; room_code: string; start_slot: number };

export type SolveInput = {
  grid: GridSpec;
  talks: TalkSpec[];
  pins?: Pin[];
  config?: ScoringConfig;
};

// --------------------------------------------------------------------------- //
// Output
// --------------------------------------------------------------------------- //

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
  speaker_name: string;
  reasons: string[];
  diagnosis: string;
};

export type ScoreBreakdown = {
  talks: Placement[];
  penalty_collision: number;
  penalty_heavy: number;
  objective_total: number;
};

export type PinProblem = {
  talk_id: number;
  day: number;
  room_code: string;
  start_slot: number;
  problem: string;
};

export function pinProblemDetail(problem: PinProblem): Record<string, unknown> {
  return {
    talk_id: problem.talk_id,
    day: problem.day,
    room_code: problem.room_code,
    start_slot: problem.start_slot,
    problem: problem.problem,
  };
}

export type SolveResult = {
  status: 'solved' | 'infeasible' | 'failed';
  placements: Placement[];
  unplaced: UnplacedTalk[];
  score: ScoreBreakdown;
  pin_problems: PinProblem[];
  placed_count: number;
  notes: string[];
  timed_out: boolean;
  capped: boolean;
};

// --------------------------------------------------------------------------- //
// The seeded Analyst Days grid (SDS §4)
// --------------------------------------------------------------------------- //

function block(
  kind: string,
  label: string,
  day: number,
  start_minute: number,
  end_minute: number,
  room_codes: string[] = [],
): FixedBlock {
  return { kind, label, day, start_minute, end_minute, room_codes };
}

export function defaultGrid(): GridSpec {
  const blocks: FixedBlock[] = [
    block('REGISTRATION', 'Registration', 1, 0, 60),
    block('OPENING', 'Opening', 1, 60, 80),
    block('LUNCH', 'Lunch shift 1', 1, 220, 280, ['A']),
    block('LUNCH', 'Lunch shift 2', 1, 240, 300, ['B']),
    block('LUNCH', 'Lunch shift 3', 1, 260, 320, ['C', 'D']),
    block('COFFEE', 'Coffee break', 1, 380, 420),
    block('EVENING', 'Evening program', 1, 540, 600),
    block('COFFEE', 'Coffee break', 2, 160, 200),
    block('LUNCH', 'Lunch shift 1', 2, 260, 320, ['A']),
    block('LUNCH', 'Lunch shift 2', 2, 280, 340, ['B']),
    block('LUNCH', 'Lunch shift 3', 2, 300, 360, ['C', 'D']),
    block('CLOSING', 'Closing', 2, 500, 540),
  ];
  return new GridSpec([...DEFAULT_ROOMS], SLOT_MINUTES, DAY_START_MINUTE, { ...DEFAULT_DAY_SLOTS }, blocks);
}

/** Assignable (day, room, start) cells — 152 on the default grid. */
export function gridCellCount(grid: GridSpec): number {
  let total = 0;
  for (const day of grid.day_numbers()) {
    for (const room of grid.rooms) {
      let count = 0;
      for (let s = 0; s < grid.slots_per_day[day]; s += 1) if (grid.is_assignable(day, room, s)) count += 1;
      total += count;
    }
  }
  return total;
}

// --------------------------------------------------------------------------- //
// Candidate cells and reasons
// --------------------------------------------------------------------------- //

/** Why this whole cell cannot host the talk; `null` when it can. */
export function cellReason(
  grid: GridSpec,
  talk: TalkSpec,
  day: number,
  room: string,
  start: number,
): string | null {
  const needed = slotsNeeded(talk);
  const start_minute = start * grid.slot_minutes;
  const end_minute = (start + needed) * grid.slot_minutes;

  if (talk.availability.length > 0) {
    const inside = talk.availability.some(
      (w) => w.day === day && w.start_minute <= start_minute && end_minute <= w.end_minute,
    );
    if (!inside) return 'outside_availability';
  }

  for (const w of talk.unavailability) {
    if (w.day === day && start_minute < w.end_minute && w.start_minute < end_minute) {
      return 'unavailability_overlap';
    }
  }

  for (let slot = start; slot < start + needed; slot += 1) {
    const kind = grid.blocking_kind(day, room, slot);
    if (kind !== null) return kind;
  }
  return null;
}

export function allCells(grid: GridSpec, talk: TalkSpec): [number, string, number][] {
  const cells: [number, string, number][] = [];
  const needed = slotsNeeded(talk);
  for (const day of grid.day_numbers()) {
    for (const room of grid.rooms) {
      for (let start = 0; start < grid.slots_per_day[day] - needed + 1; start += 1) {
        cells.push([day, room, start]);
      }
    }
  }
  return cells;
}

export function staticCandidates(grid: GridSpec, talk: TalkSpec): [number, string, number][] {
  return allCells(grid, talk).filter((c) => cellReason(grid, talk, c[0], c[1], c[2]) === null);
}

/** A talk with at least one statically valid cell was blocked only by peers. */
export function unplacedReasons(grid: GridSpec, talk: TalkSpec): [string[], string] {
  const observed = new Set<string>();
  let validCells = 0;
  for (const cell of allCells(grid, talk)) {
    const reason = cellReason(grid, talk, cell[0], cell[1], cell[2]);
    if (reason === null) validCells += 1;
    else observed.add(reason);
  }

  if (validCells > 0) return [['no_free_slot'], 'no free slot left once the other talks were placed'];
  if (observed.size === 0) return [['no_free_slot'], 'no free slot left once the other talks were placed'];

  let diagnosis: string;
  if (observed.has('unavailability_overlap')) {
    const windows = talk.unavailability
      .map((w) => `day ${w.day} ${grid.time_label(w.start_minute)}-${grid.time_label(w.end_minute)}`)
      .join(', ');
    diagnosis = `every otherwise valid cell intersects an unavailability window (${windows})`;
  } else if (observed.has('outside_availability') && talk.availability.length > 0) {
    const windows = talk.availability
      .map((w) => `day ${w.day} ${grid.time_label(w.start_minute)}-${grid.time_label(w.end_minute)}`)
      .join(', ');
    const longest = Math.max(...talk.availability.map((w) => w.end_minute - w.start_minute));
    diagnosis =
      `availability (${windows}) cannot hold a ${talk.length_minutes} min talk; ` +
      `the longest window is ${longest} min`;
  } else if (observed.has('fixed_block')) {
    const kinds = Array.from(
      new Set(grid.fixed_blocks.filter((b) => b.room_codes.length === 0).map((b) => b.kind)),
    ).sort();
    diagnosis = `every candidate cell overlaps a fixed block (${kinds.join(', ') || 'fixed block'})`;
  } else if (observed.has('room_dark')) {
    diagnosis = "every candidate cell overlaps a room's own lunch shift, so the room is dark";
  } else {
    diagnosis = 'no free slot left once the other talks were placed';
  }

  const reasons = AVAILABILITY_REASONS.filter((code) => observed.has(code) && code !== 'pin_conflict');
  const overlapIndex = reasons.indexOf('unavailability_overlap');
  if (overlapIndex > 0) {
    reasons.splice(overlapIndex, 1);
    reasons.unshift('unavailability_overlap');
  }
  return [reasons.length > 0 ? reasons : ['no_free_slot'], diagnosis];
}

// --------------------------------------------------------------------------- //
// Scoring
// --------------------------------------------------------------------------- //

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export type PlacedCell = [TalkSpec, number, string, number];

export function scorePlacements(
  grid: GridSpec,
  config: ScoringConfig,
  placed: PlacedCell[],
  pinnedIds: Set<number> = new Set(),
): ScoreBreakdown {
  const placements: Placement[] = [];
  let totalContrib = 0;
  const perSlot = new Map<string, number>();
  let heavyLate = 0;

  for (const [talk, day, room, start] of placed) {
    const rhythm = grid.rhythm(day, room, start, config);
    const contribution = talk.interest * rhythm;
    totalContrib += contribution;
    const endSlot = start + slotsNeeded(talk);
    placements.push({
      talk_id: talk.id,
      title: talk.title,
      speaker_name: talk.speaker_name,
      room_code: room,
      day,
      start_slot: start,
      end_slot: endSlot,
      start_time: grid.time_label(start * grid.slot_minutes),
      end_time: grid.time_label(endSlot * grid.slot_minutes),
      interest: talk.interest,
      rhythm,
      contribution,
      pinned: pinnedIds.has(talk.id),
    });
    if (talk.interest >= 4) {
      const key = `${day}:${start}`;
      perSlot.set(key, (perSlot.get(key) ?? 0) + 1);
    }
    if (talk.heavy && grid.heavy_late_slots(day, room).has(start)) heavyLate += 1;
  }

  let collisionUnits = 0;
  perSlot.forEach((n) => {
    collisionUnits += (n * (n - 1)) / 2;
  });
  const penaltyCollision = config.collision_penalty * collisionUnits;
  const penaltyHeavy = config.heavy_late_penalty * heavyLate;
  placements.sort((a, b) =>
    a.day !== b.day
      ? a.day - b.day
      : a.start_slot !== b.start_slot
        ? a.start_slot - b.start_slot
        : a.room_code !== b.room_code
          ? a.room_code < b.room_code
            ? -1
            : 1
          : a.talk_id - b.talk_id,
  );
  return {
    talks: placements,
    penalty_collision: round6(penaltyCollision),
    penalty_heavy: round6(penaltyHeavy),
    objective_total: round6(totalContrib - penaltyCollision - penaltyHeavy),
  };
}

// --------------------------------------------------------------------------- //
// Pin validation
// --------------------------------------------------------------------------- //

export function validatePins(grid: GridSpec, talks: TalkSpec[], pins: Pin[]): PinProblem[] {
  const byId = new Map<number, TalkSpec>(talks.map((t) => [t.id, t]));
  const roomUsed = new Map<string, Set<number>>();
  const speakerUsed = new Map<string, Set<number>>();
  const problems: PinProblem[] = [];

  for (const pin of pins) {
    const talk = byId.get(pin.talk_id);
    if (talk === undefined) {
      problems.push({ ...pin, problem: 'does_not_fit' });
      continue;
    }

    const endSlot = pin.start_slot + slotsNeeded(talk);
    if (!(pin.day in grid.slots_per_day) || !grid.rooms.includes(pin.room_code)) {
      problems.push({ ...pin, problem: 'does_not_fit' });
      continue;
    }
    if (pin.start_slot < 0 || endSlot > grid.slots_per_day[pin.day]) {
      problems.push({ ...pin, problem: 'does_not_fit' });
      continue;
    }

    const span: number[] = [];
    for (let s = pin.start_slot; s < endSlot; s += 1) span.push(s);
    const startMinute = pin.start_slot * grid.slot_minutes;
    const endMinute = endSlot * grid.slot_minutes;
    let code: string | null = null;

    if (
      talk.availability.length > 0 &&
      !talk.availability.some(
        (w) => w.day === pin.day && w.start_minute <= startMinute && endMinute <= w.end_minute,
      )
    ) {
      code = 'outside_availability';
    } else if (
      talk.unavailability.some(
        (w) => w.day === pin.day && startMinute < w.end_minute && w.start_minute < endMinute,
      )
    ) {
      code = 'unavailability_overlap';
    } else if (span.some((s) => !grid.is_assignable(pin.day, pin.room_code, s))) {
      code = 'room_dark';
    } else {
      const roomKey = `${pin.day}:${pin.room_code}`;
      const used = roomUsed.get(roomKey);
      if (used && span.some((s) => used.has(s))) code = 'cell_occupied';
      else {
        const speakerSpans = speakerUsed.get(talk.speaker_name);
        if (speakerSpans && span.some((s) => speakerSpans.has(pin.day * SLOTS_IN_DAY + s))) {
          code = 'speaker_double_booked';
        }
      }
    }

    if (code !== null) {
      problems.push({ ...pin, problem: code });
      continue;
    }

    const roomKey = `${pin.day}:${pin.room_code}`;
    const roomSpans = roomUsed.get(roomKey) ?? new Set<number>();
    span.forEach((s) => roomSpans.add(s));
    roomUsed.set(roomKey, roomSpans);
    const speakerSpans = speakerUsed.get(talk.speaker_name) ?? new Set<number>();
    span.forEach((s) => speakerSpans.add(pin.day * SLOTS_IN_DAY + s));
    speakerUsed.set(talk.speaker_name, speakerSpans);
  }

  return problems;
}

// --------------------------------------------------------------------------- //
// Search: DFS + branch and bound with bitmask occupancy
// --------------------------------------------------------------------------- //

const EPS = 1e-9;

function better(candidate: [number, number], incumbent: [number, number] | null): boolean {
  if (incumbent === null) return true;
  if (candidate[0] !== incumbent[0]) return candidate[0] > incumbent[0];
  return candidate[1] > incumbent[1] + EPS;
}

// BigInt: a day-2 mask sits above bit 64, past Number's 53-bit precision.
// Written with BigInt() calls, not literals, so the source needs no ES2020 target.
const B0 = BigInt(0);
const B1 = BigInt(1);

function slotMask(day: number, start: number, slots: number): bigint {
  return ((B1 << BigInt(slots)) - B1) << BigInt(day * SLOTS_IN_DAY + start);
}

type Candidate = [day: number, room: string, start: number, mask: bigint, contribution: number];

class Searcher {
  nodes = 0;
  capped = false;
  timedOut = false;
  bestKey: [number, number] | null = null;
  bestAssign: PlacedCell[] | null = null;
  roomBits = new Map<string, bigint>();
  speakerBits = new Map<string, bigint>();

  constructor(
    private readonly grid: GridSpec,
    private readonly config: ScoringConfig,
    private readonly order: TalkSpec[],
    private readonly candidates: Map<number, Candidate[]>,
    private readonly nodeCap: number,
    private readonly deadline: number | null,
  ) {}

  private free(cell: Candidate, speaker: string): boolean {
    const [day, room, , mask] = cell;
    const roomBits = this.roomBits.get(`${day}:${room}`) ?? B0;
    const speakerMask = this.speakerBits.get(speaker) ?? B0;
    return (roomBits & mask) === B0 && (speakerMask & mask) === B0;
  }

  private apply(cell: Candidate, speaker: string, on: boolean): void {
    const [day, room, , mask] = cell;
    const key = `${day}:${room}`;
    const roomBits = this.roomBits.get(key) ?? B0;
    this.roomBits.set(key, on ? roomBits | mask : roomBits & ~mask);
    const speakerMask = this.speakerBits.get(speaker) ?? B0;
    this.speakerBits.set(speaker, on ? speakerMask | mask : speakerMask & ~mask);
  }

  run(preplaced: PlacedCell[], pinnedContribution: number): void {
    const remaining = this.order.length;
    const suffixBest = new Array<number>(remaining + 1).fill(0);
    const bestOf = new Map<number, number>();
    for (const talk of this.order) {
      const cells = this.candidates.get(talk.id) ?? [];
      bestOf.set(talk.id, cells.reduce((acc, c) => Math.max(acc, c[4]), 0));
    }
    for (let i = remaining - 1; i >= 0; i -= 1) {
      suffixBest[i] = suffixBest[i + 1] + (bestOf.get(this.order[i].id) ?? 0);
    }
    this.dfs(0, 0, pinnedContribution, [...preplaced], suffixBest);
  }

  private dfs(
    index: number,
    placed: number,
    partial: number,
    assign: PlacedCell[],
    suffixBest: number[],
  ): void {
    this.nodes += 1;
    if (this.nodes > this.nodeCap) {
      this.capped = true;
      return;
    }
    if (this.deadline !== null && this.nodes % 64 === 0 && Date.now() >= this.deadline) {
      this.timedOut = true;
      return;
    }

    if (index === this.order.length) {
      const key: [number, number] = [
        placed,
        scorePlacements(this.grid, this.config, assign).objective_total,
      ];
      if (better(key, this.bestKey)) {
        this.bestKey = key;
        this.bestAssign = [...assign];
      }
      return;
    }

    // Optimistic bound: every remaining talk takes its best cell, no penalty.
    const bound: [number, number] = [placed + (this.order.length - index), partial + suffixBest[index]];
    if (this.bestKey !== null) {
      if (bound[0] < this.bestKey[0]) return;
      if (bound[0] === this.bestKey[0] && bound[1] <= this.bestKey[1] + EPS) return;
    }

    const talk = this.order[index];
    for (const cell of this.candidates.get(talk.id) ?? []) {
      if (!this.free(cell, talk.speaker_name)) continue;
      this.apply(cell, talk.speaker_name, true);
      assign.push([talk, cell[0], cell[1], cell[2]]);
      this.dfs(index + 1, placed + 1, partial + cell[4], assign, suffixBest);
      assign.pop();
      this.apply(cell, talk.speaker_name, false);
      if (this.timedOut || this.capped) return;
    }

    // Unplaced is tried only after every placement, so count wins first.
    this.dfs(index + 1, placed, partial, assign, suffixBest);
  }
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

export function solve(
  solveInput: SolveInput,
  nodeCap = 200_000,
  timeLimitSeconds: number | null = null,
): SolveResult {
  const grid = solveInput.grid;
  const config = solveInput.config ?? DEFAULT_SCORING;
  const talks = [...solveInput.talks];
  const pins = solveInput.pins ?? [];

  const pinProblems = validatePins(grid, talks, pins);
  if (pinProblems.length > 0) {
    const empty: ScoreBreakdown = {
      talks: [],
      penalty_collision: 0,
      penalty_heavy: 0,
      objective_total: 0,
    };
    return {
      status: 'failed',
      placements: [],
      unplaced: [],
      score: empty,
      pin_problems: pinProblems,
      placed_count: 0,
      notes: ['pin_conflict'],
      timed_out: false,
      capped: false,
    };
  }

  const candidates = new Map<number, Candidate[]>();
  for (const talk of talks) {
    const usable: Candidate[] = staticCandidates(grid, talk).map(([day, room, start]) => [
      day,
      room,
      start,
      slotMask(day, start, slotsNeeded(talk)),
      talk.interest * grid.rhythm(day, room, start, config),
    ]);
    // Best contribution first, then a fixed grid order: deterministic and greedy-friendly.
    usable.sort(
      (a, b) =>
        b[4] - a[4] ||
        a[0] - b[0] ||
        (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) ||
        a[2] - b[2],
    );
    candidates.set(talk.id, usable);
  }

  const pinnedCells = new Map<number, [number, string, number]>();
  for (const pin of pins) pinnedCells.set(pin.talk_id, [pin.day, pin.room_code, pin.start_slot]);
  const pinnedIds = new Set(pinnedCells.keys());

  const preplaced: PlacedCell[] = [];
  let pinnedContribution = 0;
  const variables: TalkSpec[] = [];
  for (const talk of talks) {
    const cell = pinnedCells.get(talk.id);
    if (cell !== undefined) {
      preplaced.push([talk, cell[0], cell[1], cell[2]]);
      pinnedContribution += talk.interest * grid.rhythm(cell[0], cell[1], cell[2], config);
    } else if ((candidates.get(talk.id) ?? []).length > 0) {
      variables.push(talk);
    }
  }

  variables.sort(
    (a, b) =>
      (candidates.get(a.id) ?? []).length - (candidates.get(b.id) ?? []).length ||
      b.interest - a.interest ||
      a.id - b.id,
  );

  const searcher = new Searcher(
    grid,
    config,
    variables,
    candidates,
    nodeCap,
    timeLimitSeconds === null ? null : Date.now() + Math.max(timeLimitSeconds, 0) * 1000,
  );
  for (const [talk, day, room, start] of preplaced) {
    const mask = slotMask(day, start, slotsNeeded(talk));
    const roomKey = `${day}:${room}`;
    searcher.roomBits.set(roomKey, (searcher.roomBits.get(roomKey) ?? B0) | mask);
    searcher.speakerBits.set(talk.speaker_name, (searcher.speakerBits.get(talk.speaker_name) ?? B0) | mask);
  }

  searcher.run(preplaced, pinnedContribution);

  const chosen = searcher.bestAssign !== null ? searcher.bestAssign : [...preplaced];
  const score = scorePlacements(grid, config, chosen, pinnedIds);
  const placedIds = new Set(score.talks.map((p) => p.talk_id));

  const unplaced: UnplacedTalk[] = talks
    .filter((talk) => !placedIds.has(talk.id))
    .map((talk) => {
      const [reasons, diagnosis] = unplacedReasons(grid, talk);
      return {
        talk_id: talk.id,
        title: talk.title,
        speaker_name: talk.speaker_name,
        reasons,
        diagnosis,
      };
    });

  const everyTalkPlaced = placedIds.size === talks.length;
  const notes: string[] = [];
  let status: SolveResult['status'];
  if (searcher.timedOut) {
    status = everyTalkPlaced ? 'solved' : 'failed';
    notes.push('timed_out');
  } else if (searcher.capped) {
    status = everyTalkPlaced ? 'solved' : 'infeasible';
    notes.push('search_capped');
  } else {
    status = everyTalkPlaced ? 'solved' : 'infeasible';
  }

  return {
    status,
    placements: score.talks,
    unplaced,
    score,
    pin_problems: [],
    placed_count: score.talks.length,
    notes,
    timed_out: searcher.timedOut,
    capped: searcher.capped,
  };
}
