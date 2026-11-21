"""Shell layer: maps DB rows to the pure solver's plain structures and back.

No scheduling rule lives here — see SDS §1 (layer boundary rule).
"""

from __future__ import annotations

import time

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import scheduler as sched
from .db import (
    Assignment,
    AvailabilityWindow,
    Conference,
    FixedBlock,
    Room,
    ScheduleRun,
    Speaker,
    Talk,
)

MAX_TALKS = 80
SOLVER_VERSION = "mvp-1"


# --------------------------------------------------------------------------- #
# Grid
# --------------------------------------------------------------------------- #


def load_grid(session: Session, conference: Conference) -> sched.GridSpec:
    blocks = list(
        session.scalars(
            select(FixedBlock).where(FixedBlock.conference_id == conference.id).order_by(FixedBlock.id)
        )
    )
    rooms = tuple(sorted(r.code for r in session.scalars(select(Room).where(Room.conference_id == conference.id))))
    return sched.GridSpec(
        rooms=rooms,
        slot_minutes=conference.slot_minutes,
        day_start_minute=sched.DAY_START_MINUTE,
        slots_per_day=dict(sched.DEFAULT_DAY_SLOTS),
        fixed_blocks=tuple(
            sched.FixedBlock(
                kind=b.kind,
                label=b.label,
                day=b.day,
                start_minute=b.start_minute,
                end_minute=b.end_minute,
                room_codes=tuple(b.room_codes or ()),
            )
            for b in blocks
        ),
    )


def grid_payload(grid: sched.GridSpec, blocks: list[FixedBlock]) -> dict:
    days = []
    for day in grid.day_numbers():
        slots = []
        for room in grid.rooms:
            for slot in range(grid.slots_per_day[day]):
                block = grid.block_at(day, room, slot)
                slots.append(
                    {
                        "day": day,
                        "slot_index": slot,
                        "start_time": grid.time_label(slot * grid.slot_minutes),
                        "end_time": grid.time_label((slot + 1) * grid.slot_minutes),
                        "room_code": room,
                        "assignable": block is None,
                        "blocked_by": None if block is None else block.kind,
                    }
                )
        days.append(
            {
                "day": day,
                "start_time": grid.time_label(0),
                "end_time": grid.time_label(grid.slots_per_day[day] * grid.slot_minutes),
                "slots": slots,
                "fixed_blocks": [
                    {
                        "kind": b.kind,
                        "label": b.label,
                        "day": b.day,
                        "start_minute": b.start_minute,
                        "end_minute": b.end_minute,
                        "start_time": grid.time_label(b.start_minute),
                        "end_time": grid.time_label(b.end_minute),
                        "room_codes": list(b.room_codes or []),
                    }
                    for b in blocks
                    if b.day == day
                ],
            }
        )
    return {
        "slot_minutes": grid.slot_minutes,
        "rooms": list(grid.rooms),
        "days": days,
    }


# --------------------------------------------------------------------------- #
# Talks
# --------------------------------------------------------------------------- #


def talk_payload(talk: Talk) -> dict:
    return {
        "id": talk.id,
        "title": talk.title,
        "abstract": talk.abstract,
        "speaker_name": talk.speaker.name,
        "length_minutes": talk.length_minutes,
        "slots_needed": talk.slots_needed,
        "interest": talk.interest,
        "heavy": talk.heavy,
        "interest_source": talk.interest_source or "manual",
        "heavy_source": talk.heavy_source or "manual",
        "ai_reason": talk.ai_reason,
        "availability": [
            {"day": w.day, "start_minute": w.start_minute, "end_minute": w.end_minute}
            for w in talk.windows
            if w.kind == "AVAILABLE"
        ],
        "unavailability": [
            {"day": w.day, "start_minute": w.start_minute, "end_minute": w.end_minute}
            for w in talk.windows
            if w.kind == "UNAVAILABLE"
        ],
    }


def talk_spec(talk: Talk) -> sched.TalkSpec:
    return sched.TalkSpec(
        id=talk.id,
        title=talk.title,
        speaker_name=talk.speaker.name,
        length_minutes=talk.length_minutes,
        interest=talk.interest,
        heavy=talk.heavy,
        availability=tuple(
            sched.Window(w.day, w.start_minute, w.end_minute) for w in talk.windows if w.kind == "AVAILABLE"
        ),
        unavailability=tuple(
            sched.Window(w.day, w.start_minute, w.end_minute) for w in talk.windows if w.kind == "UNAVAILABLE"
        ),
    )


def get_or_create_speaker(session: Session, name: str) -> Speaker:
    speaker = session.scalars(select(Speaker).where(Speaker.name == name)).first()
    if speaker is None:
        speaker = Speaker(name=name)
        session.add(speaker)
        session.flush()
    return speaker


def replace_windows(session: Session, talk: Talk, availability: list, unavailability: list) -> None:
    for window in list(talk.windows):
        session.delete(window)
    talk.windows.clear()
    session.flush()
    for kind, windows in (("AVAILABLE", availability), ("UNAVAILABLE", unavailability)):
        for w in windows:
            session.add(
                AvailabilityWindow(
                    talk_id=talk.id,
                    kind=kind,
                    day=w["day"],
                    start_minute=w["start_minute"],
                    end_minute=w["end_minute"],
                )
            )
    session.flush()


def load_talks(session: Session, conference: Conference) -> list[Talk]:
    return list(
        session.scalars(select(Talk).where(Talk.conference_id == conference.id).order_by(Talk.id))
    )


# --------------------------------------------------------------------------- #
# Hour scores (D-09)
# --------------------------------------------------------------------------- #


def hour_scores(grid: sched.GridSpec, talks: dict[int, Talk], talks_out: list[dict]) -> list[dict]:
    """Per clock hour of each day: interest of every talking room, then a running total.

    A talk contributes its full interest to every hour block it overlaps, never
    a prorated share (D-09). Hours with no placed talk are absent.
    """
    per_hour: dict[tuple[int, int], int] = {}
    for t in talks_out:
        talk = talks.get(t["talk_id"])
        if talk is None:
            continue
        start_minute = t["start_slot"] * grid.slot_minutes
        end_minute = t["end_slot"] * grid.slot_minutes
        for hour in range(start_minute // 60 * 60, end_minute, 60):
            key = (t["day"], hour)
            per_hour[key] = per_hour.get(key, 0) + talk.interest

    scores: list[dict] = []
    running = 0
    for day in sorted({day for day, _ in per_hour}):
        for hour in sorted(hour for d, hour in per_hour if d == day):
            running += per_hour[(day, hour)]
            scores.append(
                {
                    "day": day,
                    "hour_start": grid.time_label(hour),
                    "hour_interest": per_hour[(day, hour)],
                    "cumulative": running,
                }
            )
    return scores


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #



def run_solver(
    session: Session,
    conference: Conference,
    pins: list[dict],
    scoring_override: dict | None,
) -> tuple[sched.SolveResult, sched.GridSpec, dict[int, Talk], int]:
    grid = load_grid(session, conference)
    config_data = dict(conference.scoring_config or {})
    if scoring_override:
        config_data.update({k: v for k, v in scoring_override.items() if v is not None})
    config = sched.ScoringConfig.from_dict(config_data)

    talks = load_talks(session, conference)
    specs = tuple(talk_spec(t) for t in talks)
    pin_specs = tuple(
        sched.Pin(talk_id=p["talk_id"], day=p["day"], room_code=p["room_code"], start_slot=p["start_slot"])
        for p in pins
    )

    started = time.monotonic()
    result = sched.solve(
        sched.SolveInput(grid=grid, talks=specs, pins=pin_specs, config=config),
        time_limit_seconds=config.solve_timeout_ms / 1000.0,
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    return result, grid, {t.id: t for t in talks}, duration_ms


def persist_run(
    session: Session,
    conference: Conference,
    result: sched.SolveResult,
    pin_payloads: list[dict],
    duration_ms: int,
    force_failed: bool = False,
) -> ScheduleRun:
    status = "failed" if force_failed else result.status
    breakdown = None
    if result.placements:
        breakdown = {
            "penalty_collision": result.score.penalty_collision,
            "penalty_heavy": result.score.penalty_heavy,
            "objective_total": result.score.objective_total,
        }
    run = ScheduleRun(
        conference_id=conference.id,
        status=status,
        placed_count=result.placed_count,
        objective_total=None if breakdown is None else result.score.objective_total,
        objective_breakdown=breakdown,
        unplaced=[
            {
                "talk_id": u.talk_id,
                "title": u.title,
                "speaker_name": u.speaker_name,
                "reasons": list(u.reasons),
                "diagnosis": u.diagnosis,
            }
            for u in result.unplaced
        ],
        pins_used=[
            {
                "talk_id": p["talk_id"],
                "day": p["day"],
                "room_code": p["room_code"],
                "start_slot": p["start_slot"],
            }
            for p in pin_payloads
        ],
        partial=result.timed_out,
        solver_version=SOLVER_VERSION,
        duration_ms=duration_ms,
    )
    session.add(run)
    session.flush()

    rooms = {r.code: r.id for r in session.scalars(select(Room).where(Room.conference_id == conference.id))}
    for p in result.placements:
        session.add(
            Assignment(
                run_id=run.id,
                talk_id=p.talk_id,
                room_id=rooms[p.room_code],
                day=p.day,
                start_slot=p.start_slot,
                end_slot=p.end_slot,
                pinned=p.pinned,
            )
        )
    session.flush()
    return run


def pins_in_latest_run(session: Session, conference: Conference) -> set[int]:
    latest = session.scalars(
        select(ScheduleRun).where(ScheduleRun.conference_id == conference.id).order_by(ScheduleRun.id.desc())
    ).first()
    if latest is None:
        return set()
    return {int(p["talk_id"]) for p in (latest.pins_used or [])}


def run_payload(session: Session, run: ScheduleRun, grid: sched.GridSpec) -> dict:
    talk_rows = {t.id: t for t in session.scalars(select(Talk).where(Talk.conference_id == run.conference_id))}
    rooms = {r.id: r.code for r in session.scalars(select(Room).where(Room.conference_id == run.conference_id))}
    conference = session.get(Conference, run.conference_id)
    config = sched.ScoringConfig.from_dict(conference.scoring_config if conference else None)

    talks_out = []
    for a in sorted(run.assignments, key=lambda x: (x.day, x.start_slot, x.room_id, x.talk_id)):
        talk = talk_rows.get(a.talk_id)
        if talk is None:
            continue
        rhythm = grid.rhythm(a.day, rooms[a.room_id], a.start_slot, config)
        talks_out.append(
            {
                "talk_id": a.talk_id,
                "title": talk.title,
                "speaker_name": talk.speaker.name,
                "room_code": rooms[a.room_id],
                "day": a.day,
                "start_slot": a.start_slot,
                "end_slot": a.end_slot,
                "start_time": grid.time_label(a.start_slot * grid.slot_minutes),
                "end_time": grid.time_label(a.end_slot * grid.slot_minutes),
                "interest": talk.interest,
                "rhythm": rhythm,
                "contribution": round(talk.interest * rhythm, 6),
                "pinned": a.pinned,
            }
        )

    breakdown = None
    if run.objective_breakdown is not None:
        breakdown = {
            "talks": talks_out,
            "penalty_collision": run.objective_breakdown.get("penalty_collision", 0.0),
            "penalty_heavy": run.objective_breakdown.get("penalty_heavy", 0.0),
            "objective_total": run.objective_breakdown.get("objective_total", 0.0),
        }

    return {
        "id": run.id,
        "status": run.status,
        "placed_count": run.placed_count,
        "objective_total": run.objective_total,
        "breakdown": breakdown,
        "unplaced": run.unplaced or [],
        "pins_used": run.pins_used or [],
        "partial": run.partial,
        "duration_ms": run.duration_ms,
        "hour_scores": hour_scores(grid, talk_rows, talks_out),
        "created_at": run.created_at.isoformat() if run.created_at else None,
    }


def export_payload(session: Session, conference: Conference, run: ScheduleRun, grid: sched.GridSpec) -> dict:
    payload = run_payload(session, run, grid)
    talks = payload["breakdown"]["talks"] if payload["breakdown"] else []
    return {
        "conference": {
            "name": conference.name,
            "days": conference.days,
            "slot_minutes": conference.slot_minutes,
        },
        "run": {
            "id": run.id,
            "status": run.status,
            "objective_total": payload["objective_total"],
            "partial": run.partial,
        },
        "placed": [
            {
                "day": t["day"],
                "room_code": t["room_code"],
                "start_time": t["start_time"],
                "end_time": t["end_time"],
                "speaker_name": t["speaker_name"],
                "title": t["title"],
                "interest": t["interest"],
                "pinned": t["pinned"],
            }
            for t in talks
        ],
        "hour_scores": payload["hour_scores"],
        "unplaced": [
            {
                "talk_id": u["talk_id"],
                "title": u["title"],
                "speaker_name": u.get("speaker_name", ""),
                "reasons": u["reasons"],
                "diagnosis": u["diagnosis"],
            }
            for u in payload["unplaced"]
        ],
    }
