export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { exportable } from '../../../../../lib/exportRun';
import { handleRoute } from '../../../../../lib/http';
import { exportPayload } from '../../../../../lib/services';
import { resolvePathId } from '../../../../../lib/wire';

const EXPORT_CSS = `
@page { margin: 14mm; }
body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 0; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 18px 0 6px; page-break-after: avoid; }
.meta { font-size: 12px; color: #555; margin-bottom: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 11px; }
th, td { border: 1px solid #999; padding: 3px 4px; vertical-align: top; }
th { background: #eee; text-align: left; }
.day { page-break-after: always; }
.day:last-of-type { page-break-after: auto; }
.dark { background: #f2f2f2; color: #777; }
.talk { font-weight: bold; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#x27;');
}

type Placed = {
  day: number;
  room_code: string;
  start_time: string;
  end_time: string;
  speaker_name: string;
  title: string;
  interest: number;
  pinned: boolean;
};

export async function GET(
  _request: Request,
  { params }: { params: { run_id: string } },
): Promise<Response> {
  return handleRoute((db) => {
    const runId = resolvePathId(params.run_id);
    const { run, conference, grid, interests } = exportable(db, runId);
    const payload = exportPayload(db, conference, run, grid, interests) as {
      placed: Placed[];
      unplaced: { title: string; reasons: string[]; diagnosis: string }[];
    };

    const parts: string[] = [
      "<!DOCTYPE html><html><head><meta charset='utf-8'>",
      `<title>${escapeHtml(conference.name)} — agenda</title>`,
      `<style>${EXPORT_CSS}</style></head><body>`,
      `<h1>${escapeHtml(conference.name)}</h1>`,
      `<div class='meta'>Run ${run.id} · ${escapeHtml(run.status)} · ` +
        `${payload.placed.length} placed · ${payload.unplaced.length} unplaced</div>`,
    ];

    for (const day of grid.day_numbers()) {
      parts.push("<section class='day'>");
      parts.push(`<h2>Day ${day}</h2><table><thead><tr><th>Time</th>`);
      for (const room of grid.rooms) parts.push(`<th>Hall ${escapeHtml(room)}</th>`);
      parts.push('</tr></thead><tbody>');
      for (let slot = 0; slot < grid.slots_per_day[day]; slot += 1) {
        const slotStart = grid.time_label(slot * grid.slot_minutes);
        parts.push(`<tr><td>${slotStart}</td>`);
        for (const room of grid.rooms) {
          const block = grid.block_at(day, room, slot);
          if (block !== null) {
            parts.push(`<td class='dark'>${escapeHtml(block.label)}</td>`);
            continue;
          }
          const here = payload.placed.filter(
            (p) => p.day === day && p.room_code === room && p.start_time === slotStart,
          );
          if (here.length > 0) {
            const cell = here
              .map(
                (t) =>
                  `<div class='talk'>${escapeHtml(t.title)}</div>` +
                  `<div>${escapeHtml(t.speaker_name)}</div>` +
                  `<div>${t.start_time}–${t.end_time} · interest ${t.interest}` +
                  `${t.pinned ? ' · pinned' : ''}</div>`,
              )
              .join('');
            parts.push(`<td>${cell}</td>`);
          } else {
            parts.push('<td></td>');
          }
        }
        parts.push('</tr>');
      }
      parts.push('</tbody></table></section>');
    }

    if (payload.unplaced.length > 0) {
      parts.push(
        '<section><h2>Unplaced talks</h2><table><thead><tr>' +
          '<th>Talk</th><th>Reasons</th><th>Diagnosis</th></tr></thead><tbody>',
      );
      for (const item of payload.unplaced) {
        parts.push(
          `<tr><td>${escapeHtml(item.title)}</td>` +
            `<td>${escapeHtml(item.reasons.join(', '))}</td>` +
            `<td>${escapeHtml(item.diagnosis)}</td></tr>`,
        );
      }
      parts.push('</tbody></table></section>');
    }
    parts.push('</body></html>');

    return new Response(parts.join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });
}
