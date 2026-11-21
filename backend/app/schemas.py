"""Pydantic wire models and the single error shape (openapi-outline §1, §3)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ALLOWED_LENGTHS = (20, 40, 80)


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


class ApiError(Exception):
    """Every 4xx/5xx in this app is one of these."""

    def __init__(self, status_code: int, code: str, message: str, details: list[dict] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or []

    def body(self) -> dict:
        return {"code": self.code, "message": self.message, "details": self.details}


class ErrorDetail(BaseModel):
    field: str | None = None
    talk_id: int | None = None
    problem: str | None = None
    received: object | None = None
    allowed: str | None = None
    day: int | None = None
    room_code: str | None = None
    start_slot: int | None = None


class Error(BaseModel):
    code: str
    message: str
    details: list[dict] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Common objects
# --------------------------------------------------------------------------- #


class Window(BaseModel):
    model_config = ConfigDict(extra="forbid")

    day: int
    start_minute: int
    end_minute: int

    @field_validator("day")
    @classmethod
    def _day(cls, value: int) -> int:
        if value not in (1, 2):
            raise ValueError("day must be 1 or 2")
        return value

    @model_validator(mode="after")
    def _order(self) -> "Window":
        if self.end_minute <= self.start_minute:
            raise ValueError("end_minute must be greater than start_minute")
        if self.start_minute < 0:
            raise ValueError("start_minute must be >= 0")
        return self


ScoreSource = Literal["ai", "manual"]


class TalkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    abstract: str | None = None
    speaker_name: str = Field(min_length=1, max_length=200)
    length_minutes: int
    interest: int
    heavy: bool = False
    # D-08: optional provenance. Omitted means "manual", the pre-D-08 behavior.
    interest_source: ScoreSource | None = None
    heavy_source: ScoreSource | None = None
    ai_reason: str | None = Field(default=None, max_length=400)
    availability: list[Window] = Field(default_factory=list)
    unavailability: list[Window] = Field(default_factory=list)

    @field_validator("length_minutes")
    @classmethod
    def _length(cls, value: int) -> int:
        if value not in ALLOWED_LENGTHS:
            raise ValueError("allowed: 20, 40, 80")
        return value

    @field_validator("interest")
    @classmethod
    def _interest(cls, value: int) -> int:
        if not isinstance(value, int) or not 1 <= value <= 5:
            raise ValueError("must be an integer between 1 and 5")
        return value


class TalkOut(BaseModel):
    id: int
    title: str
    abstract: str | None = None
    speaker_name: str
    length_minutes: int
    slots_needed: int
    interest: int
    heavy: bool
    interest_source: ScoreSource = "manual"
    heavy_source: ScoreSource = "manual"
    ai_reason: str | None = None
    availability: list[Window] = Field(default_factory=list)
    unavailability: list[Window] = Field(default_factory=list)


class TalkList(BaseModel):
    items: list[TalkOut]
    total: int


class ScoringConfigOut(BaseModel):
    rhythm_early: float = 0.6
    rhythm_late_morning: float = 1.0
    rhythm_post_lunch: float = 1.1
    rhythm_late_afternoon: float = 0.8
    rhythm_last_slot: float = 0.5
    collision_penalty: float = 3.0
    heavy_late_penalty: float = 2.0
    solve_timeout_ms: int = 10000


class ScoringOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rhythm_early: float | None = None
    rhythm_late_morning: float | None = None
    rhythm_post_lunch: float | None = None
    rhythm_late_afternoon: float | None = None
    rhythm_last_slot: float | None = None
    collision_penalty: float | None = None
    heavy_late_penalty: float | None = None
    solve_timeout_ms: int | None = None


class ConferenceOut(BaseModel):
    id: int
    name: str
    days: int
    slot_minutes: int
    scoring: ScoringConfigOut


class ConferencePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    scoring: ScoringOverride | None = None


class GridSlot(BaseModel):
    day: int
    slot_index: int
    start_time: str
    end_time: str
    room_code: str
    assignable: bool
    blocked_by: str | None = None


class FixedBlockOut(BaseModel):
    kind: str
    label: str
    day: int
    start_minute: int
    end_minute: int
    start_time: str | None = None
    end_time: str | None = None
    room_codes: list[str] = Field(default_factory=list)


class GridDay(BaseModel):
    day: int
    start_time: str | None = None
    end_time: str | None = None
    slots: list[GridSlot]
    fixed_blocks: list[FixedBlockOut]


class GridOut(BaseModel):
    slot_minutes: int
    rooms: list[str]
    days: list[GridDay]


class PinIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    talk_id: int
    day: int
    room_code: str
    start_slot: int


class PlacementOut(BaseModel):
    talk_id: int
    title: str
    speaker_name: str
    room_code: str
    day: int
    start_slot: int
    end_slot: int
    start_time: str
    end_time: str
    interest: int
    rhythm: float
    contribution: float
    pinned: bool


class UnplacedOut(BaseModel):
    talk_id: int
    title: str
    speaker_name: str | None = None
    reasons: list[str]
    diagnosis: str


class ScoreBreakdownOut(BaseModel):
    talks: list[PlacementOut]
    penalty_collision: float
    penalty_heavy: float
    objective_total: float


class HourScore(BaseModel):
    day: int
    hour_start: str
    hour_interest: int
    cumulative: int


class RunOut(BaseModel):
    id: int
    status: Literal["draft", "solved", "infeasible", "failed"]
    placed_count: int
    objective_total: float | None = None
    breakdown: ScoreBreakdownOut | None = None
    unplaced: list[UnplacedOut] = Field(default_factory=list)
    pins_used: list[PinIn] = Field(default_factory=list)
    partial: bool = False
    duration_ms: int = 0
    hour_scores: list[HourScore] = Field(default_factory=list)
    created_at: str | None = None


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pins: list[PinIn] = Field(default_factory=list)
    scoring_override: ScoringOverride | None = None


class SolveTimeoutOut(BaseModel):
    code: str = "SOLVE_TIMEOUT"
    message: str
    details: list[dict] = Field(default_factory=list)
    run: RunOut | None = None


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    abstract: str | None = None
    length_min: int

    @field_validator("length_min")
    @classmethod
    def _length(cls, value: int) -> int:
        if value not in ALLOWED_LENGTHS:
            raise ValueError("allowed: 20, 40, 80")
        return value


class ScoreOut(BaseModel):
    interest: int
    heavy: bool
    reason: str


class HealthOut(BaseModel):
    status: str
    version: str
