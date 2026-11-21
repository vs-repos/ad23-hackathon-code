/** All backend traffic goes through same-origin /api/*, proxied by next.config.js. */
import type {
  ApiErrorBody,
  Conference,
  Grid,
  Pin,
  Run,
  ScoreSource,
  ScoreSuggestion,
  Talk,
  Window,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  details: ApiErrorBody['details'];

  constructor(status: number, code: string, message: string, details: ApiErrorBody['details'] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.code ?? 'INTERNAL_ERROR',
      body?.message ?? `request failed with ${response.status}`,
      body?.details ?? [],
    );
  }
  return body as T;
}

export type TalkInput = {
  title: string;
  abstract?: string | null;
  speaker_name: string;
  length_minutes: number;
  interest: number;
  heavy: boolean;
  interest_source?: ScoreSource;
  heavy_source?: ScoreSource;
  ai_reason?: string | null;
  availability: Window[];
  unavailability: Window[];
};

export const api = {
  conference: () => request<Conference>('/api/conference'),
  grid: () => request<Grid>('/api/grid'),
  talks: () => request<{ items: Talk[]; total: number }>('/api/talks'),
  createTalk: (input: TalkInput) =>
    request<Talk>('/api/talks', { method: 'POST', body: JSON.stringify(input) }),
  updateTalk: (id: number, input: TalkInput) =>
    request<Talk>(`/api/talks/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteTalk: (id: number) => request<void>(`/api/talks/${id}`, { method: 'DELETE' }),
  score: (title: string, abstract: string | null, lengthMin: number) =>
    request<ScoreSuggestion>('/api/score', {
      method: 'POST',
      body: JSON.stringify({ title, abstract, length_min: lengthMin }),
    }),
  latestRun: () => request<Run>('/api/runs/latest'),
  solve: (pins: Pin[]) =>
    request<Run & { run?: Run }>('/api/runs', { method: 'POST', body: JSON.stringify({ pins }) }),
};
