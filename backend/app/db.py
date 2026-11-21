"""SQLAlchemy models and session plumbing — the seven tables from SDS §2."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    select,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "agenda.db"
DB_URL = os.environ.get("AGENDA_DB_URL", f"sqlite:///{DB_PATH}")


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Conference(Base):
    __tablename__ = "conference"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    days: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    slot_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    scoring_config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    rooms: Mapped[list["Room"]] = relationship(back_populates="conference", cascade="all, delete-orphan")
    talks: Mapped[list["Talk"]] = relationship(back_populates="conference", cascade="all, delete-orphan")
    fixed_blocks: Mapped[list["FixedBlock"]] = relationship(
        back_populates="conference", cascade="all, delete-orphan"
    )


class Room(Base):
    __tablename__ = "room"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conference_id: Mapped[int] = mapped_column(ForeignKey("conference.id"), nullable=False)
    code: Mapped[str] = mapped_column(String(8), nullable=False)
    capacity_ignored: Mapped[int] = mapped_column(Integer, default=0)

    conference: Mapped[Conference] = relationship(back_populates="rooms")


class Speaker(Base):
    __tablename__ = "speaker"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)

    talks: Mapped[list["Talk"]] = relationship(back_populates="speaker")


class Talk(Base):
    __tablename__ = "talk"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conference_id: Mapped[int] = mapped_column(ForeignKey("conference.id"), nullable=False)
    speaker_id: Mapped[int] = mapped_column(ForeignKey("speaker.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    abstract: Mapped[str | None] = mapped_column(Text, nullable=True)
    length_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    slots_needed: Mapped[int] = mapped_column(Integer, nullable=False)
    interest: Mapped[int] = mapped_column(Integer, nullable=False)
    heavy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Who supplied the score (D-08). The solver never reads these.
    interest_source: Mapped[str] = mapped_column(String(8), nullable=False, default="manual")
    heavy_source: Mapped[str] = mapped_column(String(8), nullable=False, default="manual")
    ai_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    conference: Mapped[Conference] = relationship(back_populates="talks")
    speaker: Mapped[Speaker] = relationship(back_populates="talks")
    windows: Mapped[list["AvailabilityWindow"]] = relationship(
        back_populates="talk", cascade="all, delete-orphan"
    )


class AvailabilityWindow(Base):
    __tablename__ = "availability_window"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    talk_id: Mapped[int] = mapped_column(ForeignKey("talk.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # AVAILABLE | UNAVAILABLE
    day: Mapped[int] = mapped_column(Integer, nullable=False)
    start_minute: Mapped[int] = mapped_column(Integer, nullable=False)
    end_minute: Mapped[int] = mapped_column(Integer, nullable=False)

    talk: Mapped[Talk] = relationship(back_populates="windows")


class FixedBlock(Base):
    __tablename__ = "fixed_block"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conference_id: Mapped[int] = mapped_column(ForeignKey("conference.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    day: Mapped[int] = mapped_column(Integer, nullable=False)
    start_minute: Mapped[int] = mapped_column(Integer, nullable=False)
    end_minute: Mapped[int] = mapped_column(Integer, nullable=False)
    room_codes: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    conference: Mapped[Conference] = relationship(back_populates="fixed_blocks")


class ScheduleRun(Base):
    __tablename__ = "schedule_run"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conference_id: Mapped[int] = mapped_column(ForeignKey("conference.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    placed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    objective_total: Mapped[float | None] = mapped_column(Float, nullable=True)
    objective_breakdown: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    unplaced: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    pins_used: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    partial: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    solver_version: Mapped[str] = mapped_column(String(32), nullable=False, default="mvp-1")
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    assignments: Mapped[list["Assignment"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class Assignment(Base):
    __tablename__ = "assignment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("schedule_run.id"), nullable=False)
    talk_id: Mapped[int] = mapped_column(ForeignKey("talk.id"), nullable=False)
    room_id: Mapped[int] = mapped_column(ForeignKey("room.id"), nullable=False)
    day: Mapped[int] = mapped_column(Integer, nullable=False)
    start_slot: Mapped[int] = mapped_column(Integer, nullable=False)
    end_slot: Mapped[int] = mapped_column(Integer, nullable=False)
    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    run: Mapped[ScheduleRun] = relationship(back_populates="assignments")


def make_engine(url: str = DB_URL):
    if url.startswith("sqlite:///") and ":memory:" not in url:
        Path(url.replace("sqlite:///", "")).parent.mkdir(parents=True, exist_ok=True)
    return create_engine(url, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {})


engine = make_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


# Columns added after the first release; a database created before them is
# upgraded in place so `data/agenda.db` keeps working (D-08).
ADDED_TALK_COLUMNS = {
    "interest_source": "VARCHAR(8) NOT NULL DEFAULT 'manual'",
    "heavy_source": "VARCHAR(8) NOT NULL DEFAULT 'manual'",
    "ai_reason": "TEXT",
}


def _add_missing_talk_columns(target_engine) -> None:
    with target_engine.begin() as connection:
        existing = {column["name"] for column in inspect(connection).get_columns("talk")}
        for name, ddl in ADDED_TALK_COLUMNS.items():
            if name not in existing:
                connection.execute(text(f"ALTER TABLE talk ADD COLUMN {name} {ddl}"))


def init_db(target_engine=None) -> None:
    target = target_engine or engine
    Base.metadata.create_all(target)
    _add_missing_talk_columns(target)


def get_session() -> Session:
    return SessionLocal()


def dumps(value) -> str:
    return json.dumps(value, sort_keys=True)


def single_conference(session: Session) -> Conference | None:
    return session.scalars(select(Conference).order_by(Conference.id)).first()
