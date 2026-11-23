/**
 * Wire-model validation, mirroring code/backend/app/schemas.py.
 * Validation policy lives here, never in the scheduler.
 */
import { ApiError, asInt, isPlainObject, rejectExtraKeys, ValidationFailure, type ApiErrorDetail } from './errors';
import type { Window } from './scheduler';

export const ALLOWED_LENGTHS = [20, 40, 80];

export type TalkIn = {
  title: string;
  abstract: string | null;
  speaker_name: string;
  length_minutes: number;
  interest: number;
  heavy: boolean;
  interest_source: 'ai' | 'manual' | null;
  heavy_source: 'ai' | 'manual' | null;
  ai_reason: string | null;
  availability: Window[];
  unavailability: Window[];
};

const TALK_KEYS = [
  'title',
  'abstract',
  'speaker_name',
  'length_minutes',
  'interest',
  'heavy',
  'interest_source',
  'heavy_source',
  'ai_reason',
  'availability',
  'unavailability',
];

function validateWindow(raw: unknown, index: number, field: string, failure: ValidationFailure): Window | null {
  if (!isPlainObject(raw)) {
    failure.add(`${field}.${index}`, 'Input should be a valid dictionary', null);
    return null;
  }
  rejectExtraKeys(raw, ['day', 'start_minute', 'end_minute'], failure);
  const day = asInt(raw['day']);
  const start = asInt(raw['start_minute']);
  const end = asInt(raw['end_minute']);
  let ok = true;
  if (day === null) {
    failure.add(`${field}.${index}.day`, 'Input should be a valid integer', raw['day']);
    ok = false;
  } else if (day !== 1 && day !== 2) {
    failure.add(`${field}.${index}.day`, 'Value error, day must be 1 or 2', day);
    ok = false;
  }
  if (start === null) {
    failure.add(`${field}.${index}.start_minute`, 'Input should be a valid integer', raw['start_minute']);
    ok = false;
  }
  if (end === null) {
    failure.add(`${field}.${index}.end_minute`, 'Input should be a valid integer', raw['end_minute']);
    ok = false;
  }
  if (ok && start !== null && end !== null && day !== null) {
    if (end <= start) {
      failure.add(`${field}.${index}`, 'Value error, end_minute must be greater than start_minute', null);
      ok = false;
    } else if (start < 0) {
      failure.add(`${field}.${index}`, 'Value error, start_minute must be >= 0', null);
      ok = false;
    }
  }
  return ok && day !== null && start !== null && end !== null ? { day, start_minute: start, end_minute: end } : null;
}

function validateWindows(raw: unknown, field: string, failure: ValidationFailure): Window[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    failure.add(field, 'Input should be a valid list', null);
    return [];
  }
  const out: Window[] = [];
  raw.forEach((item, index) => {
    const window = validateWindow(item, index, field, failure);
    if (window) out.push(window);
  });
  return out;
}

function validateSource(raw: unknown, field: string, failure: ValidationFailure): 'ai' | 'manual' | null {
  if (raw === undefined || raw === null) return null;
  if (raw === 'ai' || raw === 'manual') return raw;
  failure.add(field, "Input should be 'ai' or 'manual'", raw as never);
  return null;
}

export function validateTalkIn(payload: Record<string, unknown>): TalkIn {
  const failure = new ValidationFailure();
  rejectExtraKeys(payload, TALK_KEYS, failure);

  const title = payload['title'];
  if (typeof title !== 'string') failure.add('title', 'Input should be a valid string', title as never);
  else if (title.length < 1) failure.add('title', 'String should have at least 1 character', title);
  else if (title.length > 300) failure.add('title', 'String should have at most 300 characters', null);

  const abstract = payload['abstract'];
  let abstractOut: string | null = null;
  if (abstract === undefined || abstract === null) abstractOut = null;
  else if (typeof abstract !== 'string') failure.add('abstract', 'Input should be a valid string', abstract as never);
  else abstractOut = abstract;

  const speaker = payload['speaker_name'];
  if (typeof speaker !== 'string') failure.add('speaker_name', 'Input should be a valid string', speaker as never);
  else if (speaker.length < 1) failure.add('speaker_name', 'String should have at least 1 character', speaker);
  else if (speaker.length > 200) failure.add('speaker_name', 'String should have at most 200 characters', null);

  const lengthRaw = payload['length_minutes'];
  let length = 0;
  if (typeof lengthRaw !== 'number' || typeof lengthRaw === 'boolean') {
    failure.add('length_minutes', 'Input should be a valid integer', lengthRaw as never);
  } else if (!ALLOWED_LENGTHS.includes(lengthRaw)) {
    failure.add('length_minutes', 'Value error, allowed: 20, 40, 80', lengthRaw);
  } else {
    length = lengthRaw;
  }

  const interestRaw = payload['interest'];
  let interest = 0;
  if (typeof interestRaw !== 'number' || typeof interestRaw === 'boolean' || !Number.isInteger(interestRaw)) {
    failure.add('interest', 'Input should be a valid integer', interestRaw as never);
  } else if (interestRaw < 1 || interestRaw > 5) {
    failure.add('interest', 'Value error, must be an integer between 1 and 5', interestRaw);
  } else {
    interest = interestRaw;
  }

  const heavyRaw = payload['heavy'];
  let heavy = false;
  if (heavyRaw === undefined) heavy = false;
  else if (typeof heavyRaw !== 'boolean') failure.add('heavy', 'Input should be a valid boolean', heavyRaw as never);
  else heavy = heavyRaw;

  const interestSource = validateSource(payload['interest_source'], 'interest_source', failure);
  const heavySource = validateSource(payload['heavy_source'], 'heavy_source', failure);

  const aiReasonRaw = payload['ai_reason'];
  let aiReason: string | null = null;
  if (aiReasonRaw === undefined || aiReasonRaw === null) aiReason = null;
  else if (typeof aiReasonRaw !== 'string') failure.add('ai_reason', 'Input should be a valid string', aiReasonRaw as never);
  else if (aiReasonRaw.length > 400) failure.add('ai_reason', 'String should have at most 400 characters', null);
  else aiReason = aiReasonRaw;

  const availability = validateWindows(payload['availability'], 'availability', failure);
  const unavailability = validateWindows(payload['unavailability'], 'unavailability', failure);

  failure.throwIfAny();

  return {
    title: title as string,
    abstract: abstractOut,
    speaker_name: speaker as string,
    length_minutes: length,
    interest,
    heavy,
    interest_source: interestSource,
    heavy_source: heavySource,
    ai_reason: aiReason,
    availability,
    unavailability,
  };
}

export type ScoringOverrideIn = Partial<Record<keyof typeof SCORING_KEYS, number | null>>;

const SCORING_KEYS = {
  rhythm_early: 0,
  rhythm_late_morning: 0,
  rhythm_post_lunch: 0,
  rhythm_late_afternoon: 0,
  rhythm_last_slot: 0,
  collision_penalty: 0,
  heavy_late_penalty: 0,
  solve_timeout_ms: 0,
} as const;

export function validateScoringOverride(
  raw: unknown,
  failure: ValidationFailure,
  prefix: string,
): Record<string, number> {
  if (!isPlainObject(raw)) {
    failure.add(prefix || null, 'Input should be a valid dictionary', null);
    return {};
  }
  rejectExtraKeys(raw, Object.keys(SCORING_KEYS), failure);
  const out: Record<string, number> = {};
  for (const key of Object.keys(SCORING_KEYS)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || Number.isNaN(value)) {
      failure.add(`${prefix ? `${prefix}.` : ''}${key}`, 'Input should be a valid number', value as never);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export type ConferencePatchIn = { name?: string; scoring?: Record<string, number> };

export function validateConferencePatch(payload: Record<string, unknown>): ConferencePatchIn {
  const failure = new ValidationFailure();
  rejectExtraKeys(payload, ['name', 'scoring'], failure);

  const result: ConferencePatchIn = {};
  const name = payload['name'];
  if (name !== undefined && name !== null) {
    if (typeof name !== 'string') failure.add('name', 'Input should be a valid string', name as never);
    else result.name = name;
  }
  if (payload['scoring'] !== undefined && payload['scoring'] !== null) {
    const scoring = validateScoringOverride(payload['scoring'], failure, 'scoring');
    if (Object.keys(scoring).length > 0) result.scoring = scoring;
  }
  failure.throwIfAny();
  return result;
}

export type PinIn = { talk_id: number; day: number; room_code: string; start_slot: number };
export type RunRequestIn = { pins: PinIn[]; scoring_override: Record<string, number> | null };

function validatePin(raw: unknown, index: number, failure: ValidationFailure): PinIn | null {
  if (!isPlainObject(raw)) {
    failure.add(`pins.${index}`, 'Input should be a valid dictionary', null);
    return null;
  }
  rejectExtraKeys(raw, ['talk_id', 'day', 'room_code', 'start_slot'], failure);
  const talkId = asInt(raw['talk_id']);
  const day = asInt(raw['day']);
  const startSlot = asInt(raw['start_slot']);
  const roomCode = raw['room_code'];
  let ok = true;
  if (talkId === null) {
    failure.add(`pins.${index}.talk_id`, 'Input should be a valid integer', raw['talk_id']);
    ok = false;
  }
  if (day === null) {
    failure.add(`pins.${index}.day`, 'Input should be a valid integer', raw['day']);
    ok = false;
  }
  if (startSlot === null) {
    failure.add(`pins.${index}.start_slot`, 'Input should be a valid integer', raw['start_slot']);
    ok = false;
  }
  if (typeof roomCode !== 'string') {
    failure.add(`pins.${index}.room_code`, 'Input should be a valid string', roomCode as never);
    ok = false;
  }
  return ok && talkId !== null && day !== null && startSlot !== null
    ? { talk_id: talkId, day, room_code: roomCode as string, start_slot: startSlot }
    : null;
}

export function validateRunRequest(payload: Record<string, unknown>): RunRequestIn {
  const failure = new ValidationFailure();
  rejectExtraKeys(payload, ['pins', 'scoring_override'], failure);

  const pins: PinIn[] = [];
  const rawPins = payload['pins'];
  if (rawPins === undefined) {
    // default: []
  } else if (!Array.isArray(rawPins)) {
    failure.add('pins', 'Input should be a valid list', null);
  } else {
    rawPins.forEach((item, index) => {
      const pin = validatePin(item, index, failure);
      if (pin) pins.push(pin);
    });
  }

  let override: Record<string, number> | null = null;
  if (payload['scoring_override'] !== undefined && payload['scoring_override'] !== null) {
    const scoring = validateScoringOverride(payload['scoring_override'], failure, 'scoring_override');
    if (Object.keys(scoring).length > 0) override = scoring;
  }

  failure.throwIfAny();
  return { pins, scoring_override: override };
}

export type ScoreRequestIn = { title: string; abstract: string | null; length_min: number };

export function validateScoreRequest(payload: Record<string, unknown>): ScoreRequestIn {
  const failure = new ValidationFailure();
  rejectExtraKeys(payload, ['title', 'abstract', 'length_min'], failure);

  const title = payload['title'];
  if (typeof title !== 'string') failure.add('title', 'Input should be a valid string', title as never);
  else if (title.length < 1) failure.add('title', 'String should have at least 1 character', title);
  else if (title.length > 300) failure.add('title', 'String should have at most 300 characters', null);

  const abstract = payload['abstract'];
  let abstractOut: string | null = null;
  if (abstract === undefined || abstract === null) abstractOut = null;
  else if (typeof abstract !== 'string') failure.add('abstract', 'Input should be a valid string', abstract as never);
  else abstractOut = abstract;

  const lengthRaw = payload['length_min'];
  let length = 0;
  if (typeof lengthRaw !== 'number' || typeof lengthRaw === 'boolean') {
    failure.add('length_min', 'Input should be a valid integer', lengthRaw as never);
  } else if (!ALLOWED_LENGTHS.includes(lengthRaw)) {
    failure.add('length_min', 'Value error, allowed: 20, 40, 80', lengthRaw);
  } else {
    length = lengthRaw;
  }

  failure.throwIfAny();
  return { title: title as string, abstract: abstractOut, length_min: length };
}

export function resolvePathId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id)) {
    const detail: ApiErrorDetail = { field: 'path', problem: 'Input should be a valid integer', received: raw };
    throw new ApiError(422, 'VALIDATION_ERROR', 'request validation failed', [detail]);
  }
  return id;
}
