'use client';

import type { Grid, HourScore, Placement } from '../lib/types';

type Props = {
  grid: Grid;
  placements: Placement[];
  hourScores: HourScore[];
  pinTalkId: number | null;
  onPick: (day: number, room: string, startSlot: number) => void;
  pinnedIds: Set<number>;
};

const SLOT_MINUTES = 20;
const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;

export default function AgendaGrid({ grid, placements, hourScores, pinTalkId, onPick, pinnedIds }: Props) {
  const byCell = new Map<string, Placement>();
  for (const placement of placements) {
    byCell.set(`${placement.day}:${placement.room_code}:${placement.start_slot}`, placement);
  }
  const covered = new Set<string>();
  for (const placement of placements) {
    for (let slot = placement.start_slot; slot < placement.end_slot; slot += 1) {
      covered.add(`${placement.day}:${placement.room_code}:${slot}`);
    }
  }

  return (
    <div className="space-y-8" id="grid">
      <p className="text-xs text-stone-500">
        Cumulative interest: running total of hourly interest across all rooms. A talk adds its full interest to
        each hour it overlaps.
      </p>
      {grid.days.map((day) => {
        const slots = Array.from(new Set(day.slots.map((s) => s.slot_index))).sort((a, b) => a - b);
        const blockedAt = (room: string, slot: number) =>
          day.slots.find((s) => s.room_code === room && s.slot_index === slot);
        const hours = new Map<string, HourScore>();
        for (const row of hourScores) {
          if (row.day === day.day) hours.set(row.hour_start, row);
        }
        return (
          <section key={day.day} className="day-block">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">
              Day {day.day} · {day.start_time}–{day.end_time}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="w-20 border border-stone-300 bg-stone-100 px-2 py-1 text-left font-medium">Time</th>
                    {grid.rooms.map((room) => (
                      <th key={room} className="border border-stone-300 bg-stone-100 px-2 py-1 text-left font-medium">
                        Hall {room}
                      </th>
                    ))}
                    <th
                      className="border border-stone-300 bg-stone-100 px-2 py-1 text-right font-medium"
                      title="Running total of hourly interest across all rooms. A talk adds its full interest to each hour it overlaps."
                    >
                      Cumulative interest
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((slot) => {
                    const startTime = blockedAt(grid.rooms[0], slot)?.start_time ?? '';
                    // The hour cell covers the 20-minute rows of one clock hour.
                    const hour = hours.get(startTime);
                    const opensHour = hour !== undefined && slot % SLOTS_PER_HOUR === 0;
                    return (
                      <tr key={slot}>
                        <td className="border border-stone-300 bg-stone-50 px-2 py-1 font-mono text-[11px] text-stone-600">
                          {startTime}
                        </td>
                        {grid.rooms.map((room) => {
                          const cell = blockedAt(room, slot);
                          const key = `${day.day}:${room}:${slot}`;
                          if (!cell?.assignable) {
                            return (
                              <td
                                key={room}
                                className="border border-stone-300 bg-stone-100 px-2 py-1 text-[11px] text-stone-400"
                              >
                                {cell?.blocked_by ?? ''}
                              </td>
                            );
                          }
                          const placement = byCell.get(key);
                          if (placement) {
                            const isPinned = pinnedIds.has(placement.talk_id);
                            return (
                              <td
                                key={room}
                                className="border border-stone-300 bg-white px-2 py-1 align-top"
                                title={`${placement.title} · ${placement.start_time}–${placement.end_time}`}
                              >
                                <div className="font-semibold leading-snug">{placement.title}</div>
                                <div className="text-stone-600">{placement.speaker_name}</div>
                                <div className="text-[11px] text-stone-500">
                                  {placement.start_time}–{placement.end_time} · i{placement.interest} · ×
                                  {placement.rhythm}
                                  {isPinned ? ' · pinned' : ''}
                                </div>
                              </td>
                            );
                          }
                          if (covered.has(key)) {
                            return <td key={room} className="border border-stone-300 bg-stone-50" />;
                          }
                          return (
                            <td
                              key={room}
                              className={`border border-stone-300 px-2 py-1 ${
                                pinTalkId ? 'cursor-pointer bg-amber-50 hover:bg-amber-100' : 'bg-white'
                              }`}
                              onClick={() => pinTalkId && onPick(day.day, room, slot)}
                            >
                              {pinTalkId ? (
                                <span className="text-[11px] text-amber-700">pin here</span>
                              ) : (
                                <span className="text-[11px] text-stone-300">·</span>
                              )}
                            </td>
                          );
                        })}
                        {opensHour ? (
                          <td
                            rowSpan={SLOTS_PER_HOUR}
                            className="border border-stone-300 bg-stone-50 px-2 py-1 text-right align-middle"
                            title={`${hour.hour_interest} interest this hour`}
                          >
                            <span className="font-mono text-sm font-semibold">{hour.cumulative}</span>
                          </td>
                        ) : hour === undefined ? (
                          <td className="border border-stone-300 bg-white px-2 py-1 text-right text-stone-300">·</td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
