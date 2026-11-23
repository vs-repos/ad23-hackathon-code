/**
 * OpenAI-compatible chat client for `POST /api/score` (D-08).
 * A port of code/backend/app/llm_score.py. No database access here.
 */
import { ApiError, type ApiErrorDetail } from './errors';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const TIMEOUT_MS = 20_000;
const MAX_REASON_CHARS = 400;

// Demo-only keyless fallback. Verified 200 + parseable JSON on 2026-11-21;
// the public endpoint can vanish without notice, so it is opt-in and flagged.
const DEMO_FALLBACK_URL = 'https://text.pollinations.ai/openai/chat/completions';
const DEMO_FALLBACK_MODEL = 'openai';
const DEMO_TIMEOUT_MS = 15_000;
const DEMO_REASON_PREFIX = 'demo-unverified: ';

const SYSTEM_PROMPT =
  'You score talks for a two-day analyst conference. ' +
  'Answer with JSON only, no prose and no code fence. ' +
  'The object has exactly three keys: "interest" (integer 1-5, 5 = expected to fill the room), ' +
  '"heavy" (boolean, true when the talk is dense or tiring to sit through), ' +
  'and "reason" (one short sentence explaining both values).';

type ChatMessage = { role: string; content: string };
export type ScoreResult = { interest: number; heavy: boolean; reason: string };

/** Read the environment at request time; the key is never logged. */
export function config(): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = (process.env['AGENDA_LLM_BASE_URL'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = process.env['AGENDA_LLM_API_KEY'] || process.env['GROQ_API_KEY'] || '';
  const model = process.env['AGENDA_LLM_MODEL'] || DEFAULT_MODEL;
  return { baseUrl, apiKey, model };
}

function badResponse(problem: string, received?: unknown): ApiError {
  const detail: ApiErrorDetail = { problem };
  if (received !== undefined) {
    detail.received = ['number', 'string', 'boolean'].includes(typeof received)
      ? received
      : String(received);
  }
  return new ApiError(502, 'LLM_BAD_RESPONSE', 'the scoring model did not return a usable score', [detail]);
}

function demoFallbackOn(): boolean {
  return (process.env['AGENDA_LLM_DEMO_FALLBACK'] || 'off').trim().toLowerCase() === 'on';
}

async function fetchCompletion(url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('no content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function demoCompletion(messages: ChatMessage[]): Promise<string> {
  try {
    return await fetchCompletion(
      DEMO_FALLBACK_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: DEMO_FALLBACK_MODEL, messages }),
      },
      DEMO_TIMEOUT_MS,
    );
  } catch {
    throw new ApiError(
      503,
      'LLM_NOT_CONFIGURED',
      'the demo fallback endpoint is unreachable; enter interest and heavy by hand',
      [{ problem: 'demo_fallback_unreachable' }],
    );
  }
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  try {
    return await fetchCompletion(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: 0 }),
      },
      TIMEOUT_MS,
    );
  } catch {
    throw badResponse('upstream_error');
  }
}

function messages(title: string, abstract: string | null, lengthMin: number): ChatMessage[] {
  const user =
    `Title: ${title}\n` +
    `Abstract: ${abstract || '(none)'}\n` +
    `Length: ${lengthMin} minutes\n` +
    'Return the JSON object now.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/;

function extract(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') throw badResponse('not_json', content);
  let body = content.trim();
  const fenced = FENCE.exec(body);
  if (fenced) body = fenced[1].trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw badResponse('not_an_object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw badResponse('not_json', body.slice(0, 200));
  }
}

function validated(data: Record<string, unknown>): ScoreResult {
  const details: ApiErrorDetail[] = [];

  const interest = data['interest'];
  if (!('interest' in data)) details.push({ field: 'interest', problem: 'missing' });
  else if (typeof interest === 'boolean' || typeof interest !== 'number' || !Number.isInteger(interest) || interest < 1 || interest > 5) {
    details.push({ field: 'interest', problem: 'out_of_range', received: interest as never, allowed: '1..5' });
  }

  const heavy = data['heavy'];
  if (!('heavy' in data)) details.push({ field: 'heavy', problem: 'missing' });
  else if (typeof heavy !== 'boolean') details.push({ field: 'heavy', problem: 'not_boolean', received: heavy as never });

  const reason = data['reason'];
  if (!('reason' in data)) details.push({ field: 'reason', problem: 'missing' });
  else if (typeof reason !== 'string') details.push({ field: 'reason', problem: 'not_a_string', received: reason as never });

  if (details.length > 0) {
    throw new ApiError(502, 'LLM_BAD_RESPONSE', 'the scoring model returned an invalid score', details);
  }

  return {
    interest: interest as number,
    heavy: heavy as boolean,
    reason: (reason as string).trim().slice(0, MAX_REASON_CHARS),
  };
}

export async function scoreTalk(title: string, abstract: string | null, lengthMin: number): Promise<ScoreResult> {
  const { baseUrl, apiKey, model } = config();
  const chat = messages(title, abstract, lengthMin);
  if (apiKey) return validated(extract(await chatCompletion(baseUrl, apiKey, model, chat)));
  if (demoFallbackOn()) {
    const result = validated(extract(await demoCompletion(chat)));
    result.reason = (DEMO_REASON_PREFIX + result.reason).slice(0, MAX_REASON_CHARS);
    return result;
  }
  throw new ApiError(
    503,
    'LLM_NOT_CONFIGURED',
    'no AI scoring key is configured; set AGENDA_LLM_API_KEY or GROQ_API_KEY, ' +
      'or enter interest and heavy by hand',
    [],
  );
}
