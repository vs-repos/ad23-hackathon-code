"""First-start seeding: one conference, four rooms, the fixed blocks, demo talks."""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import scheduler as sched
from .db import AvailabilityWindow, Conference, FixedBlock, Room, Speaker, Talk

CONFERENCE_NAME = "Analyst Days"

# The demo programme lives in JSON so the operator can edit it without touching
# code. Loaded only when the talk table is empty, so a live database is never
# duplicated or overwritten.
DEMO_TALKS_PATH = Path(__file__).with_name("demo_talks.json")


def load_demo_talks(path: Path = DEMO_TALKS_PATH) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["talks"]


def _block(conference_id: int, block: sched.FixedBlock) -> FixedBlock:
    return FixedBlock(
        conference_id=conference_id,
        kind=block.kind,
        label=block.label,
        day=block.day,
        start_minute=block.start_minute,
        end_minute=block.end_minute,
        room_codes=list(block.room_codes),
    )


def seed_if_empty(session: Session) -> None:
    if session.scalar(select(func.count()).select_from(Conference)):
        return

    grid = sched.default_grid()
    conference = Conference(
        name=CONFERENCE_NAME,
        days=2,
        slot_minutes=grid.slot_minutes,
        scoring_config=sched.ScoringConfig().to_dict(),
    )
    session.add(conference)
    session.flush()

    for code in grid.rooms:
        session.add(Room(conference_id=conference.id, code=code))
    for block in grid.fixed_blocks:
        session.add(_block(conference.id, block))
    session.flush()

    speakers: dict[str, Speaker] = {}
    for row in load_demo_talks():
        name = row["speaker_name"]
        speaker = speakers.get(name)
        if speaker is None:
            speaker = Speaker(name=name)
            session.add(speaker)
            session.flush()
            speakers[name] = speaker
        minutes = row["length_minutes"]
        talk = Talk(
            conference_id=conference.id,
            speaker_id=speaker.id,
            title=row["title"],
            abstract=row.get("abstract"),
            length_minutes=minutes,
            slots_needed=minutes // sched.SLOT_MINUTES,
            interest=row["interest"],
            heavy=row.get("heavy", False),
            interest_source=row.get("interest_source") or "manual",
            heavy_source=row.get("heavy_source") or "manual",
        )
        session.add(talk)
        session.flush()
        for kind, key in (("AVAILABLE", "availability"), ("UNAVAILABLE", "unavailability")):
            for window in row.get(key) or []:
                session.add(
                    AvailabilityWindow(
                        talk_id=talk.id,
                        kind=kind,
                        day=window["day"],
                        start_minute=window["start_minute"],
                        end_minute=window["end_minute"],
                    )
                )
    session.flush()


def sweep_draft_runs(session: Session) -> None:
    """Crash-left drafts become failed on start (SDS §3)."""
    from .db import ScheduleRun

    for run in session.scalars(select(ScheduleRun).where(ScheduleRun.status == "draft")):
        run.status = "failed"
    session.flush()
