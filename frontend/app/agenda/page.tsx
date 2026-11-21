'use client';

import { useCallback, useEffect, useState } from 'react';
import AgendaGrid from '../../components/AgendaGrid';
import TalkForm from '../../components/TalkForm';
import { ApiError, api, type TalkInput } from '../../lib/api';
import type { Conference, Grid, Pin, Run, Talk } from '../../lib/types';

function formatMinutes(minute: number): string {
  const total = 9 * 60 + minute;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function AgendaPage() {
  const [conference, setConference] = useState<Conference | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [talks, setTalks] = useState<Talk[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [pinningTalk, setPinningTalk] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [solving, setSolving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Talk | null>(null);

  const refreshTalks = useCallback(async () => {
    const list = await api.talks();
    setTalks(list.items);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [conf, gridData, list] = await Promise.all([api.conference(), api.grid(), api.talks()]);
        if (cancelled) return;
        setConference(conf);
        setGrid(gridData);
        setTalks(list.items);
        try {
          const latest = await api.latestRun();
          if (!cancelled) {
            setRun(latest);
            setPins(latest.pins_used ?? []);
          }
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'could not reach the backend');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveTalk(input: TalkInput) {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.updateTalk(editing.id, input);
        setEditing(null);
        setMessage('Talk updated. Run the agenda to re-place it.');
      } else {
        await api.createTalk(input);
        setMessage('Talk added. Run the agenda to place it.');
      }
      await refreshTalks();
    } finally {
      setBusy(false);
    }
  }

  async function removeTalk(id: number) {
    setError(null);
    try {
      await api.deleteTalk(id);
      setPins((current) => current.filter((p) => p.talk_id !== id));
      await refreshTalks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not delete the talk');
    }
  }

  async function solve() {
    setSolving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.solve(pins);
      const body = (result.run ?? result) as Run;
      setRun(body);
      setPins(body.pins_used ?? []);
      setMessage(
        body.status === 'solved'
          ? `Placed all ${body.placed_count} talks in ${body.duration_ms} ms.`
          : `Placed ${body.placed_count} of ${body.placed_count + body.unplaced.length} talks.`,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.code}: ${err.message}${err.details.length ? ` (${err.details.map((d) => d.problem ?? d.field).join(', ')})` : ''}`);
      } else {
        setError(err instanceof Error ? err.message : 'the run failed');
      }
    } finally {
      setSolving(false);
    }
  }

  function editTalk(talk: Talk) {
    setEditing(talk);
    setMessage(null);
    setError(null);
  }

  function pickCell(day: number, room: string, startSlot: number) {
    if (pinningTalk == null) return;
    setPins((current) => [
      ...current.filter((p) => p.talk_id !== pinningTalk),
      { talk_id: pinningTalk, day, room_code: room, start_slot: startSlot },
    ]);
    setPinningTalk(null);
    setMessage('Pin set. It is sent with the next run.');
  }

  const pinnedIds = new Set(pins.map((p) => p.talk_id));
  const unplacedIds = new Set((run?.unplaced ?? []).map((u) => u.talk_id));

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Build the agenda</h1>
        <p className="mt-1 text-sm text-stone-600">
          {conference
            ? `${conference.name} · ${conference.days} days · 4 halls · ${conference.slot_minutes}-minute slots`
            : 'Loading the conference…'}
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}
      {message && (
        <div className="rounded border border-stone-300 bg-white px-4 py-3 text-sm text-stone-700">{message}</div>
      )}

      <section className="grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-6">
          <TalkForm
            key={editing?.id ?? 'new'}
            grid={grid}
            talk={editing}
            onSubmit={saveTalk}
            onCancelEdit={() => setEditing(null)}
            busy={busy}
          />

          <div className="card">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-base font-semibold">Talks</h2>
              <span className="text-xs text-stone-500">{talks.length} of 80</span>
            </div>
            {!loaded && <p className="text-sm text-stone-500">Loading…</p>}
            {loaded && talks.length === 0 && <p className="text-sm text-stone-500">No talks yet.</p>}
            <ul className="divide-y divide-stone-200">
              {talks.map((talk) => (
                <li key={talk.id} className="py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium leading-snug">{talk.title}</div>
                      <div className="text-stone-600">
                        {talk.speaker_name} · {talk.length_minutes} min · interest {talk.interest}
                        {talk.heavy ? ' · heavy' : ''}
                        {talk.interest_source === 'ai' || talk.heavy_source === 'ai' ? (
                          <span className="tag ml-2" title={talk.ai_reason ?? undefined}>
                            AI
                          </span>
                        ) : (
                          <span className="tag ml-2">edited</span>
                        )}
                      </div>
                      {(talk.availability.length > 0 || talk.unavailability.length > 0) && (
                        <div className="mt-1 space-y-0.5 text-xs text-stone-500">
                          {talk.availability.length > 0 && (
                            <div>
                              available:{' '}
                              {talk.availability
                                .map((w) => `day ${w.day} ${formatMinutes(w.start_minute)}–${formatMinutes(w.end_minute)}`)
                                .join(', ')}
                            </div>
                          )}
                          {talk.unavailability.length > 0 && (
                            <div>
                              unavailable:{' '}
                              {talk.unavailability
                                .map((w) => `day ${w.day} ${formatMinutes(w.start_minute)}–${formatMinutes(w.end_minute)}`)
                                .join(', ')}
                            </div>
                          )}
                        </div>
                      )}
                      {pinnedIds.has(talk.id) && <div className="mt-1"><span className="tag">pinned</span></div>}
                      {unplacedIds.has(talk.id) && (
                        <div className="mt-1"><span className="tag text-red-700">unplaced</span></div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <button type="button" className="btn-ghost" onClick={() => editTalk(talk)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`btn-ghost ${pinningTalk === talk.id ? 'ring-1 ring-amber-500' : ''}`}
                        onClick={() => setPinningTalk(pinningTalk === talk.id ? null : talk.id)}
                      >
                        {pinnedIds.has(talk.id) ? 'Move pin' : 'Pin'}
                      </button>
                      <button type="button" className="btn-ghost text-red-700" onClick={() => removeTalk(talk.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {pinningTalk != null && (
              <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Pick a cell in the grid to pin this talk. Pinned talks are sent with the next run.
              </p>
            )}
          </div>

          <div className="card space-y-3">
            <h2 className="text-base font-semibold">Run</h2>
            <button type="button" className="btn w-full" onClick={solve} disabled={solving || talks.length === 0}>
              {solving ? 'Solving…' : 'Build the agenda'}
            </button>
            {pins.length > 0 && (
              <div className="text-xs text-stone-600">
                <div className="mb-1 font-medium text-stone-700">{pins.length} pin(s) will be sent</div>
                <ul className="space-y-0.5">
                  {pins.map((pin) => {
                    const talk = talks.find((t) => t.id === pin.talk_id);
                    return (
                      <li key={pin.talk_id}>
                        {talk?.title ?? `talk ${pin.talk_id}`} → day {pin.day}, hall {pin.room_code}, slot{' '}
                        {pin.start_slot}
                      </li>
                    );
                  })}
                </ul>
                <button type="button" className="mt-2 underline" onClick={() => setPins([])}>
                  Clear all pins
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          {run && (
            <div className="card">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold">
                  Run {run.id} · <span className="font-mono text-sm">{run.status}</span>
                </h2>
                <div className="flex items-center gap-3 text-xs text-stone-500">
                  <span>{run.duration_ms} ms</span>
                  {run.status !== 'failed' && (
                    <a
                      className="underline hover:text-stone-800"
                      href={`/api/runs/${run.id}/export.json`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download export JSON
                    </a>
                  )}
                  {run.status !== 'failed' && (
                    <a
                      className="underline hover:text-stone-800"
                      href={`/api/runs/${run.id}/export.html`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Print view
                    </a>
                  )}
                </div>
              </div>
              {run.partial && (
                <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Partial result: the solver hit its time cap. Everything below is the best assignment found.
                </p>
              )}
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="label">Placed</dt>
                  <dd className="font-mono text-lg">{run.placed_count}</dd>
                </div>
                <div>
                  <dt className="label">Objective</dt>
                  <dd className="font-mono text-lg">{run.objective_total?.toFixed(2) ?? '—'}</dd>
                </div>
                <div>
                  <dt className="label">Collision penalty</dt>
                  <dd className="font-mono text-lg">{run.breakdown?.penalty_collision.toFixed(2) ?? '—'}</dd>
                </div>
                <div>
                  <dt className="label">Heavy-late penalty</dt>
                  <dd className="font-mono text-lg">{run.breakdown?.penalty_heavy.toFixed(2) ?? '—'}</dd>
                </div>
              </dl>
            </div>
          )}

          {run?.unplaced && run.unplaced.length > 0 && (
            <div className="card">
              <h2 className="mb-3 text-base font-semibold">Unplaced talks</h2>
              <ul className="space-y-3 text-sm">
                {run.unplaced.map((item) => (
                  <li key={item.talk_id}>
                    <div className="font-medium">{item.title}</div>
                    <div className="text-xs text-stone-600">{item.diagnosis}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.reasons.map((reason) => (
                        <span key={reason} className="tag">
                          {reason}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {grid ? (
            run ? (
              <AgendaGrid
                grid={grid}
                placements={run.breakdown?.talks ?? []}
                hourScores={run.hour_scores ?? []}
                pinTalkId={pinningTalk}
                onPick={pickCell}
                pinnedIds={pinnedIds}
              />
            ) : (
              <div className="card">
                <p className="text-sm text-stone-600">
                  No run yet. Add or check the talks on the left, then press <strong>Build the agenda</strong>.
                </p>
              </div>
            )
          ) : (
            <p className="text-sm text-stone-500">Loading the grid…</p>
          )}

          {run?.breakdown && run.breakdown.talks.length > 0 && (
            <div className="card overflow-x-auto">
              <h2 className="mb-3 text-base font-semibold">Score breakdown</h2>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-stone-100">
                    <th className="border border-stone-300 px-2 py-1 text-left">Talk</th>
                    <th className="border border-stone-300 px-2 py-1 text-left">Day / hall</th>
                    <th className="border border-stone-300 px-2 py-1 text-left">Time</th>
                    <th className="border border-stone-300 px-2 py-1 text-right">Interest</th>
                    <th className="border border-stone-300 px-2 py-1 text-right">Rhythm</th>
                    <th className="border border-stone-300 px-2 py-1 text-right">Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {run.breakdown.talks.map((placement) => (
                    <tr key={placement.talk_id}>
                      <td className="border border-stone-300 px-2 py-1">
                        {placement.title}
                        {placement.pinned && <span className="tag ml-1">pinned</span>}
                      </td>
                      <td className="border border-stone-300 px-2 py-1">
                        {placement.day} / {placement.room_code}
                      </td>
                      <td className="border border-stone-300 px-2 py-1 font-mono text-[11px]">
                        {placement.start_time}–{placement.end_time}
                      </td>
                      <td className="border border-stone-300 px-2 py-1 text-right">{placement.interest}</td>
                      <td className="border border-stone-300 px-2 py-1 text-right">{placement.rhythm}</td>
                      <td className="border border-stone-300 px-2 py-1 text-right font-mono">
                        {placement.contribution.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-stone-50 font-medium">
                    <td className="border border-stone-300 px-2 py-1" colSpan={5}>
                      Sum of contributions − collision − heavy
                    </td>
                    <td className="border border-stone-300 px-2 py-1 text-right font-mono">
                      {run.breakdown.objective_total.toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
