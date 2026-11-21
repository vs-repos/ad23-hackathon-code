"""First-start seeding: one conference, four rooms, the fixed blocks, demo talks."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import scheduler as sched
from .db import AvailabilityWindow, Conference, FixedBlock, Room, Speaker, Talk

CONFERENCE_NAME = "Analyst Days"

# Eight demo talks, three speakers, mixed lengths. Two interest-5 talks must not
# share a start when an alternative exists; one heavy talk; one morning-only
# speaker. Ids are left to the database.
DEMO_TALKS = [
    # (speaker, title, abstract, minutes, interest, heavy, availability, unavailability)
    ("Marina Volkov", "Requirements that survive the roadmap", "How to keep a spec alive after the kickoff.", 40, 5, False, [], []),
    ("Marina Volkov", "Stakeholder maps in practice", "Reading the room before the room reads your deck.", 20, 4, False, [], []),
    ("Ilya Petrov", "Event storming an accounting core", "A worked example from a legacy replacement.", 80, 5, True, [], []),
    ("Ilya Petrov", "Metrics the team can actually move", "Choosing three numbers and ignoring the other forty.", 40, 3, False, [(1, 120, 360)], []),
    ("Sofia Brandt", "Data contracts without a platform team", "Small-scale schema ownership that held for a year.", 20, 2, False, [], []),
    ("Sofia Brandt", "Migration postmortems, honestly told", "Two failed cutovers and what was learned.", 40, 4, False, [], []),
    ("Marina Volkov", "Analyst as translator, not gatekeeper", "Where the role actually adds leverage.", 20, 3, False, [], [(1, 260, 320)]),
    ("Ilya Petrov", "The long workshop format", "Four hours of facilitation compressed into eighty minutes.", 80, 2, True, [], []),
]


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
    for name, title, abstract, minutes, interest, heavy, availability, unavailability in DEMO_TALKS:
        speaker = speakers.get(name)
        if speaker is None:
            speaker = Speaker(name=name)
            session.add(speaker)
            session.flush()
            speakers[name] = speaker
        talk = Talk(
            conference_id=conference.id,
            speaker_id=speaker.id,
            title=title,
            abstract=abstract,
            length_minutes=minutes,
            slots_needed=minutes // sched.SLOT_MINUTES,
            interest=interest,
            heavy=heavy,
        )
        session.add(talk)
        session.flush()
        for kind, windows in (("AVAILABLE", availability), ("UNAVAILABLE", unavailability)):
            for day, start, end in windows:
                session.add(
                    AvailabilityWindow(
                        talk_id=talk.id, kind=kind, day=day, start_minute=start, end_minute=end
                    )
                )
    session.flush()


def sweep_draft_runs(session: Session) -> None:
    """Crash-left drafts become failed on start (SDS §3)."""
    from .db import ScheduleRun

    for run in session.scalars(select(ScheduleRun).where(ScheduleRun.status == "draft")):
        run.status = "failed"
    session.flush()
