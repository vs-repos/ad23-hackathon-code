'use client';

import { useState } from 'react';
import { api, type TalkInput } from '../lib/api';
import type { Grid, ScoreSuggestion, Talk, Window } from '../lib/types';

type Row = { day: number; from: number; to: number };

const emptyRow: Row = { day: 1, from: 0, to: 1 };

function slotOptions(grid: Grid | null, day: number): { slot: number; label: string }[] {
  const gridDay = grid?.days.find((d) => d.day === day);
  if (!gridDay) return [];
  const seen = new Set<number>();
  const options: { slot: number; label: string }[] = [];
  for (const slot of gridDay.slots) {
    if (seen.has(slot.slot_index)) continue;
    seen.add(slot.slot_index);
    options.push({ slot: slot.slot_index, label: slot.start_time });
  }
  return options;
}

function toWindows(rows: Row[]): Window[] {
  return rows.map((r) => ({ day: r.day, start_minute: r.from * 20, end_minute: r.to * 20 }));
}

function fromWindows(windows: Window[]): Row[] {
  return windows.map((w) => ({ day: w.day, from: w.start_minute / 20, to: w.end_minute / 20 }));
}

function WindowEditor({
  title,
  rows,
  onChange,
  grid,
}: {
  title: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  grid: Grid | null;
}) {
  return (
    <div>
      <div className="label">{title}</div>
      {rows.length === 0 && <p className="mb-2 text-xs text-stone-500">None — no restriction.</p>}
      <div className="space-y-2">
        {rows.map((row, index) => {
          const options = slotOptions(grid, row.day);
          return (
            <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
              <select
                className="input w-20"
                value={row.day}
                onChange={(e) => {
                  const next = [...rows];
                  next[index] = { ...row, day: Number(e.target.value) };
                  onChange(next);
                }}
              >
                <option value={1}>Day 1</option>
                <option value={2}>Day 2</option>
              </select>
              <select
                className="input w-24"
                value={row.from}
                onChange={(e) => {
                  const next = [...rows];
                  next[index] = { ...row, from: Number(e.target.value), to: Math.max(Number(e.target.value) + 1, row.to) };
                  onChange(next);
                }}
              >
                {options.map((o) => (
                  <option key={o.slot} value={o.slot}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="text-stone-500">to</span>
              <select
                className="input w-24"
                value={row.to}
                onChange={(e) => {
                  const next = [...rows];
                  next[index] = { ...row, to: Number(e.target.value) };
                  onChange(next);
                }}
              >
                {[...options, { slot: (options.at(-1)?.slot ?? 29) + 1, label: 'end of day' }].map((o) => (
                  <option key={o.slot} value={o.slot}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn-ghost mt-2" onClick={() => onChange([...rows, { ...emptyRow }])}>
        Add window
      </button>
    </div>
  );
}

export default function TalkForm({
  grid,
  talk,
  onSubmit,
  onCancelEdit,
  busy,
}: {
  grid: Grid | null;
  talk: Talk | null;
  onSubmit: (input: TalkInput) => Promise<void>;
  onCancelEdit: () => void;
  busy: boolean;
}) {
  const [speaker, setSpeaker] = useState(talk?.speaker_name ?? '');
  const [title, setTitle] = useState(talk?.title ?? '');
  const [abstract, setAbstract] = useState(talk?.abstract ?? '');
  const [length, setLength] = useState(talk?.length_minutes ?? 20);
  const [interest, setInterest] = useState(talk?.interest ?? 3);
  const [heavy, setHeavy] = useState(talk?.heavy ?? false);
  const [availability, setAvailability] = useState<Row[]>(fromWindows(talk?.availability ?? []));
  const [unavailability, setUnavailability] = useState<Row[]>(fromWindows(talk?.unavailability ?? []));
  const [error, setError] = useState<string | null>(null);
  const [scoring, setScoring] = useState(false);
  // D-08: the AI only proposes. `suggestion` remembers what it proposed so a
  // saved value can be labelled ai (unchanged) or manual (corrected).
  const [suggestion, setSuggestion] = useState<ScoreSuggestion | null>(
    talk && (talk.interest_source === 'ai' || talk.heavy_source === 'ai')
      ? { interest: talk.interest, heavy: talk.heavy, reason: talk.ai_reason ?? '' }
      : null,
  );

  async function scoreWithAi() {
    setScoring(true);
    setError(null);
    try {
      const result = await api.score(title, abstract || null, length);
      setSuggestion(result);
      setInterest(result.interest);
      setHeavy(result.heavy);
    } catch (err) {
      // No key, or a rejected model answer: manual entry stays available.
      setError(err instanceof Error ? err.message : 'AI scoring is unavailable; enter the values by hand');
    } finally {
      setScoring(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const interestSource = suggestion && suggestion.interest === interest ? 'ai' : 'manual';
    const heavySource = suggestion && suggestion.heavy === heavy ? 'ai' : 'manual';
    try {
      await onSubmit({
        title,
        abstract: abstract || null,
        speaker_name: speaker,
        length_minutes: length,
        interest,
        heavy,
        interest_source: interestSource,
        heavy_source: heavySource,
        ai_reason: interestSource === 'ai' || heavySource === 'ai' ? suggestion?.reason ?? null : null,
        availability: toWindows(availability),
        unavailability: toWindows(unavailability),
      });
      if (!talk) {
        setTitle('');
        setAbstract('');
        setHeavy(false);
        setAvailability([]);
        setUnavailability([]);
        setSuggestion(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not save the talk');
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">{talk ? `Edit: ${talk.title}` : 'Add a talk'}</h2>
        {talk && (
          <button type="button" className="btn-ghost" onClick={onCancelEdit}>
            Cancel edit
          </button>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="speaker">
            Speaker
          </label>
          <input
            id="speaker"
            className="input"
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
            placeholder="Marina Volkov"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="title">
            Title
          </label>
          <input
            id="title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Requirements that survive the roadmap"
            required
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="abstract">
          Abstract (optional)
        </label>
        <textarea
          id="abstract"
          className="input min-h-[64px]"
          value={abstract}
          onChange={(e) => setAbstract(e.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="length">
            Length
          </label>
          <select id="length" className="input" value={length} onChange={(e) => setLength(Number(e.target.value))}>
            <option value={20}>20 min (1 slot)</option>
            <option value={40}>40 min (2 slots)</option>
            <option value={80}>80 min (4 slots)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="interest">
            Interest
          </label>
          <select id="interest" className="input" value={interest} onChange={(e) => setInterest(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={heavy} onChange={(e) => setHeavy(e.target.checked)} />
          Heavy talk
        </label>
      </div>
      <div className="space-y-2">
        <button type="button" className="btn-ghost" onClick={scoreWithAi} disabled={scoring || !title.trim()}>
          {scoring ? 'Scoring…' : 'Score with AI'}
        </button>
        {suggestion && (
          <p className="rounded bg-stone-50 px-3 py-2 text-xs text-stone-600">
            AI proposed interest {suggestion.interest}, {suggestion.heavy ? 'heavy' : 'not heavy'}.
            {suggestion.reason ? ` ${suggestion.reason}` : ''} Edit either value before saving if you disagree.
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <WindowEditor title="Available only in" rows={availability} onChange={setAvailability} grid={grid} />
        <WindowEditor title="Unavailable in" rows={unavailability} onChange={setUnavailability} grid={grid} />
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? 'Saving…' : talk ? 'Save changes' : 'Add talk'}
      </button>
    </form>
  );
}
