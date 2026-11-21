"""Pure agenda scheduler.

No FastAPI, no SQLAlchemy, no database, no network, no logging. Everything is a
function of its arguments. ``time.monotonic`` is read only when the caller
passes ``time_limit_seconds``, and the wall-clock cap is reported, never raised.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Iterable, Sequence

SLOT_MINUTES = 20
DAY_START_MINUTE = 9 * 60  # 09:00, the origin for every minute offset
SLOTS_IN_DAY = 64  # bitmask stride: one day of slots fits in an int

EARLY_MORNING_END_MINUTE = 120      # 11:00
LATE_AFTERNOON_START_MINUTE = 420   # 16:00

DEFAULT_DAY_SLOTS = {1: 30, 2: 27}
DEFAULT_ROOMS = ("A", "B", "C", "D")

# Reasons ordered the way they are reported.
AVAILABILITY_REASONS = (
    "outside_availability",
    "unavailability_overlap",
    "fixed_block",
    "room_dark",
    "no_free_slot",
    "pin_conflict",
)


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FixedBlock:
    kind: str
    label: str
    day: int
    start_minute: int
    end_minute: int
    room_codes: tuple[str, ...] = ()  # empty = all rooms


@dataclass(frozen=True)
class ScoringConfig:
    rhythm_early: float = 0.6
    rhythm_late_morning: float = 1.0
    rhythm_post_lunch: float = 1.1
    rhythm_late_afternoon: float = 0.8
    rhythm_last_slot: float = 0.5
    collision_penalty: float = 3.0
    heavy_late_penalty: float = 2.0
    solve_timeout_ms: int = 10000

    FIELDS = (
        "rhythm_early",
        "rhythm_late_morning",
        "rhythm_post_lunch",
        "rhythm_late_afternoon",
        "rhythm_last_slot",
        "collision_penalty",
        "heavy_late_penalty",
        "solve_timeout_ms",
    )

    def to_dict(self) -> dict:
        return {name: getattr(self, name) for name in self.FIELDS}

    @classmethod
    def from_dict(cls, data: dict | None) -> "ScoringConfig":
        if not data:
            return cls()
        values = {name: data[name] for name in cls.FIELDS if data.get(name) is not None}
        return cls(**values)


@dataclass(frozen=True)
class GridSpec:
    rooms: tuple[str, ...]
    slot_minutes: int
    day_start_minute: int
    slots_per_day: dict[int, int]
    fixed_blocks: tuple[FixedBlock, ...]

    # -- geometry ----------------------------------------------------------- #

    def day_numbers(self) -> list[int]:
        return sorted(self.slots_per_day)

    def time_label(self, minute_of_day: int) -> str:
        total = self.day_start_minute + minute_of_day
        return f"{total // 60:02d}:{total % 60:02d}"

    def block_at(self, day: int, room: str, slot: int) -> FixedBlock | None:
        minute = slot * self.slot_minutes
        for block in self.fixed_blocks:
            if block.day != day:
                continue
            if block.room_codes and room not in block.room_codes:
                continue
            if block.start_minute <= minute < block.end_minute:
                return block
        return None

    def blocking_kind(self, day: int, room: str, slot: int) -> str | None:
        """``None`` when assignable, else the reason code for one slot."""
        if day not in self.slots_per_day or slot < 0 or slot >= self.slots_per_day[day]:
            return "does_not_fit"
        block = self.block_at(day, room, slot)
        if block is None:
            return None
        return "room_dark" if block.room_codes else "fixed_block"

    def is_assignable(self, day: int, room: str, slot: int) -> bool:
        return self.blocking_kind(day, room, slot) is None

    def assignable_slots(self, day: int) -> dict[str, list[int]]:
        return {
            room: [s for s in range(self.slots_per_day[day]) if self.is_assignable(day, room, s)]
            for room in self.rooms
        }

    def lunch_slots(self, day: int, room: str) -> tuple[int, int] | None:
        """``(start_slot, end_slot_exclusive)`` of the room's own lunch shift."""
        for block in self.fixed_blocks:
            if block.day != day or block.kind != "LUNCH":
                continue
            if block.room_codes and room not in block.room_codes:
                continue
            return block.start_minute // self.slot_minutes, block.end_minute // self.slot_minutes
        return None

    def last_assignable_slot(self, day: int, room: str) -> int:
        last = None
        for slot in range(self.slots_per_day[day]):
            if self.is_assignable(day, room, slot):
                last = slot
        return -1 if last is None else last

    def heavy_late_slots(self, day: int, room: str) -> set[int]:
        starts = [s for s in range(self.slots_per_day[day]) if self.is_assignable(day, room, s)]
        return set(starts[-2:])

    def rhythm(self, day: int, room: str, start_slot: int, config: ScoringConfig) -> float:
        """One multiplier per start; bands are disjoint (SDS §6.4)."""
        start_minute = start_slot * self.slot_minutes
        if start_slot == self.last_assignable_slot(day, room):
            return config.rhythm_last_slot
        if start_minute < EARLY_MORNING_END_MINUTE:
            return config.rhythm_early
        lunch = self.lunch_slots(day, room)
        if lunch is None:
            return config.rhythm_post_lunch if start_minute < LATE_AFTERNOON_START_MINUTE else config.rhythm_late_afternoon
        if start_slot < lunch[0]:
            return config.rhythm_late_morning
        if start_slot < lunch[1] or start_minute < LATE_AFTERNOON_START_MINUTE:
            return config.rhythm_post_lunch
        return config.rhythm_late_afternoon


@dataclass(frozen=True)
class Window:
    day: int
    start_minute: int
    end_minute: int


@dataclass(frozen=True)
class TalkSpec:
    id: int
    title: str
    speaker_name: str
    length_minutes: int
    interest: int
    heavy: bool = False
    availability: tuple[Window, ...] = ()
    unavailability: tuple[Window, ...] = ()

    @property
    def slots_needed(self) -> int:
        return self.length_minutes // SLOT_MINUTES


@dataclass(frozen=True)
class Pin:
    talk_id: int
    day: int
    room_code: str
    start_slot: int


@dataclass(frozen=True)
class SolveInput:
    grid: GridSpec
    talks: tuple[TalkSpec, ...]
    pins: tuple[Pin, ...] = ()
    config: ScoringConfig = ScoringConfig()


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Placement:
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


@dataclass(frozen=True)
class UnplacedTalk:
    talk_id: int
    title: str
    speaker_name: str
    reasons: tuple[str, ...]
    diagnosis: str


@dataclass(frozen=True)
class ScoreBreakdown:
    talks: tuple[Placement, ...]
    penalty_collision: float
    penalty_heavy: float
    objective_total: float


@dataclass(frozen=True)
class PinProblem:
    talk_id: int
    day: int
    room_code: str
    start_slot: int
    problem: str

    def as_detail(self) -> dict:
        return {
            "talk_id": self.talk_id,
            "day": self.day,
            "room_code": self.room_code,
            "start_slot": self.start_slot,
            "problem": self.problem,
        }


@dataclass(frozen=True)
class SolveResult:
    status: str  # solved | infeasible | failed
    placements: tuple[Placement, ...]
    unplaced: tuple[UnplacedTalk, ...]
    score: ScoreBreakdown
    pin_problems: tuple[PinProblem, ...] = ()
    placed_count: int = 0
    notes: tuple[str, ...] = ()
    timed_out: bool = False
    capped: bool = False


# --------------------------------------------------------------------------- #
# The seeded Analyst Days grid (SDS §4)
# --------------------------------------------------------------------------- #


def default_grid() -> GridSpec:
    blocks = (
        FixedBlock("REGISTRATION", "Registration", 1, 0, 60),
        FixedBlock("OPENING", "Opening", 1, 60, 80),
        FixedBlock("LUNCH", "Lunch shift 1", 1, 220, 280, ("A",)),
        FixedBlock("LUNCH", "Lunch shift 2", 1, 240, 300, ("B",)),
        FixedBlock("LUNCH", "Lunch shift 3", 1, 260, 320, ("C", "D")),
        FixedBlock("COFFEE", "Coffee break", 1, 380, 420),
        FixedBlock("EVENING", "Evening program", 1, 540, 600),
        FixedBlock("COFFEE", "Coffee break", 2, 160, 200),
        FixedBlock("LUNCH", "Lunch shift 1", 2, 260, 320, ("A",)),
        FixedBlock("LUNCH", "Lunch shift 2", 2, 280, 340, ("B",)),
        FixedBlock("LUNCH", "Lunch shift 3", 2, 300, 360, ("C", "D")),
        FixedBlock("CLOSING", "Closing", 2, 500, 540),
    )
    return GridSpec(
        rooms=DEFAULT_ROOMS,
        slot_minutes=SLOT_MINUTES,
        day_start_minute=DAY_START_MINUTE,
        slots_per_day=dict(DEFAULT_DAY_SLOTS),
        fixed_blocks=blocks,
    )


def grid_cell_count(grid: GridSpec) -> int:
    """Assignable (day, room, start) cells — 152 on the default grid."""
    total = 0
    for day in grid.day_numbers():
        for room in grid.rooms:
            total += len([s for s in range(grid.slots_per_day[day]) if grid.is_assignable(day, room, s)])
    return total


# --------------------------------------------------------------------------- #
# Candidate cells and reasons
# --------------------------------------------------------------------------- #


def cell_reason(grid: GridSpec, talk: TalkSpec, day: int, room: str, start: int) -> str | None:
    """Why this whole cell cannot host the talk; ``None`` when it can."""
    start_minute = start * grid.slot_minutes
    end_minute = (start + talk.slots_needed) * grid.slot_minutes

    if talk.availability:
        inside = any(
            w.day == day and w.start_minute <= start_minute and end_minute <= w.end_minute
            for w in talk.availability
        )
        if not inside:
            return "outside_availability"

    for w in talk.unavailability:
        if w.day == day and start_minute < w.end_minute and w.start_minute < end_minute:
            return "unavailability_overlap"

    for slot in range(start, start + talk.slots_needed):
        kind = grid.blocking_kind(day, room, slot)
        if kind is not None:
            return kind
    return None


def all_cells(grid: GridSpec, talk: TalkSpec) -> list[tuple[int, str, int]]:
    cells = []
    for day in grid.day_numbers():
        for room in grid.rooms:
            for start in range(grid.slots_per_day[day] - talk.slots_needed + 1):
                cells.append((day, room, start))
    return cells


def static_candidates(grid: GridSpec, talk: TalkSpec) -> list[tuple[int, str, int]]:
    return [c for c in all_cells(grid, talk) if cell_reason(grid, talk, *c) is None]


def unplaced_reasons(grid: GridSpec, talk: TalkSpec) -> tuple[list[str], str]:
    """A talk with at least one statically valid cell was blocked only by peers."""
    observed: set[str] = set()
    valid_cells = 0
    for cell in all_cells(grid, talk):
        reason = cell_reason(grid, talk, *cell)
        if reason is None:
            valid_cells += 1
        else:
            observed.add(reason)

    if valid_cells:
        return ["no_free_slot"], "no free slot left once the other talks were placed"
    if not observed:
        return ["no_free_slot"], "no free slot left once the other talks were placed"

    # An unavailability that swallows the availability window is the sharper
    # explanation, so it outranks the generic "window too short" wording.
    if "unavailability_overlap" in observed:
        windows = ", ".join(
            f"day {w.day} {grid.time_label(w.start_minute)}-{grid.time_label(w.end_minute)}"
            for w in talk.unavailability
        )
        diagnosis = f"every otherwise valid cell intersects an unavailability window ({windows})"
    elif "outside_availability" in observed and talk.availability:
        windows = ", ".join(
            f"day {w.day} {grid.time_label(w.start_minute)}-{grid.time_label(w.end_minute)}"
            for w in talk.availability
        )
        longest = max(w.end_minute - w.start_minute for w in talk.availability)
        diagnosis = (
            f"availability ({windows}) cannot hold a {talk.length_minutes} min talk; "
            f"the longest window is {longest} min"
        )
    elif "fixed_block" in observed:
        kinds = sorted({b.kind for b in grid.fixed_blocks if not b.room_codes})
        diagnosis = f"every candidate cell overlaps a fixed block ({', '.join(kinds) or 'fixed block'})"
    elif "room_dark" in observed:
        diagnosis = "every candidate cell overlaps a room's own lunch shift, so the room is dark"
    else:
        diagnosis = "no free slot left once the other talks were placed"

    reasons = [code for code in AVAILABILITY_REASONS if code in observed and code != "pin_conflict"]
    if "unavailability_overlap" in reasons:
        reasons.remove("unavailability_overlap")
        reasons.insert(0, "unavailability_overlap")
    return reasons or ["no_free_slot"], diagnosis


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #


def score_placements(
    grid: GridSpec,
    config: ScoringConfig,
    placed: Iterable[tuple[TalkSpec, int, str, int]],
    pinned_ids: frozenset[int] = frozenset(),
) -> ScoreBreakdown:
    placements: list[Placement] = []
    total_contrib = 0.0
    per_slot: dict[tuple[int, int], int] = {}
    heavy_late = 0

    for talk, day, room, start in placed:
        rhythm = grid.rhythm(day, room, start, config)
        contribution = talk.interest * rhythm
        total_contrib += contribution
        end_slot = start + talk.slots_needed
        placements.append(
            Placement(
                talk_id=talk.id,
                title=talk.title,
                speaker_name=talk.speaker_name,
                room_code=room,
                day=day,
                start_slot=start,
                end_slot=end_slot,
                start_time=grid.time_label(start * grid.slot_minutes),
                end_time=grid.time_label(end_slot * grid.slot_minutes),
                interest=talk.interest,
                rhythm=rhythm,
                contribution=contribution,
                pinned=talk.id in pinned_ids,
            )
        )
        if talk.interest >= 4:
            key = (day, start)
            per_slot[key] = per_slot.get(key, 0) + 1
        if talk.heavy and start in grid.heavy_late_slots(day, room):
            heavy_late += 1

    collision_units = sum(n * (n - 1) / 2 for n in per_slot.values())
    penalty_collision = config.collision_penalty * collision_units
    penalty_heavy = config.heavy_late_penalty * heavy_late
    placements.sort(key=lambda p: (p.day, p.start_slot, p.room_code, p.talk_id))
    return ScoreBreakdown(
        talks=tuple(placements),
        penalty_collision=round(penalty_collision, 6),
        penalty_heavy=round(penalty_heavy, 6),
        objective_total=round(total_contrib - penalty_collision - penalty_heavy, 6),
    )


# --------------------------------------------------------------------------- #
# Pin validation
# --------------------------------------------------------------------------- #


def validate_pins(grid: GridSpec, talks: Sequence[TalkSpec], pins: Sequence[Pin]) -> list[PinProblem]:
    by_id = {talk.id: talk for talk in talks}
    room_used: dict[tuple[int, str], set[int]] = {}
    speaker_used: dict[str, set[tuple[int, int]]] = {}
    problems: list[PinProblem] = []

    for pin in pins:
        talk = by_id.get(pin.talk_id)
        if talk is None:
            problems.append(PinProblem(pin.talk_id, pin.day, pin.room_code, pin.start_slot, "does_not_fit"))
            continue

        end_slot = pin.start_slot + talk.slots_needed
        if pin.day not in grid.slots_per_day or pin.room_code not in grid.rooms:
            problems.append(PinProblem(pin.talk_id, pin.day, pin.room_code, pin.start_slot, "does_not_fit"))
            continue
        if pin.start_slot < 0 or end_slot > grid.slots_per_day[pin.day]:
            problems.append(PinProblem(pin.talk_id, pin.day, pin.room_code, pin.start_slot, "does_not_fit"))
            continue

        span = range(pin.start_slot, end_slot)
        start_minute = pin.start_slot * grid.slot_minutes
        end_minute = end_slot * grid.slot_minutes
        code = None

        if talk.availability and not any(
            w.day == pin.day and w.start_minute <= start_minute and end_minute <= w.end_minute
            for w in talk.availability
        ):
            code = "outside_availability"
        elif any(
            w.day == pin.day and start_minute < w.end_minute and w.start_minute < end_minute
            for w in talk.unavailability
        ):
            code = "unavailability_overlap"
        elif any(not grid.is_assignable(pin.day, pin.room_code, s) for s in span):
            code = "room_dark"
        elif any(s in room_used.get((pin.day, pin.room_code), ()) for s in span):
            code = "cell_occupied"
        elif any((pin.day, s) in speaker_used.get(talk.speaker_name, ()) for s in span):
            code = "speaker_double_booked"

        if code is not None:
            problems.append(PinProblem(pin.talk_id, pin.day, pin.room_code, pin.start_slot, code))
            continue

        room_used.setdefault((pin.day, pin.room_code), set()).update(span)
        speaker_used.setdefault(talk.speaker_name, set()).update((pin.day, s) for s in span)

    return problems


# --------------------------------------------------------------------------- #
# Search: DFS + branch and bound with bitmask occupancy
# --------------------------------------------------------------------------- #

_EPS = 1e-9


def _better(candidate: tuple[int, float], incumbent: tuple[int, float] | None) -> bool:
    if incumbent is None:
        return True
    if candidate[0] != incumbent[0]:
        return candidate[0] > incumbent[0]
    return candidate[1] > incumbent[1] + _EPS


def _slot_mask(day: int, start: int, slots: int) -> int:
    return ((1 << slots) - 1) << (day * SLOTS_IN_DAY + start)


@dataclass
class _Searcher:
    grid: GridSpec
    config: ScoringConfig
    order: list[TalkSpec]
    candidates: dict[int, list[tuple[int, str, int, int, float]]]
    node_cap: int
    deadline: float | None
    speaker_names: list[str]
    nodes: int = 0
    capped: bool = False
    timed_out: bool = False
    best_key: tuple[int, float] | None = None
    best_contrib: float = 0.0
    best_assign: list[tuple[TalkSpec, int, str, int]] | None = None
    room_bits: dict[tuple[int, str], int] = field(default_factory=dict)
    speaker_bits: dict[str, int] = field(default_factory=dict)

    def free(self, cell: tuple[int, str, int, int, float], speaker: str) -> bool:
        day, room, _start, mask, _c = cell
        return not (self.room_bits.get((day, room), 0) & mask) and not (self.speaker_bits.get(speaker, 0) & mask)

    def apply(self, cell: tuple[int, str, int, int, float], speaker: str, on: bool) -> None:
        day, room, _start, mask, _c = cell
        key = (day, room)
        if on:
            self.room_bits[key] = self.room_bits.get(key, 0) | mask
            self.speaker_bits[speaker] = self.speaker_bits.get(speaker, 0) | mask
        else:
            self.room_bits[key] = self.room_bits.get(key, 0) & ~mask
            self.speaker_bits[speaker] = self.speaker_bits.get(speaker, 0) & ~mask

    def run(self, preplaced: list[tuple[TalkSpec, int, str, int]], pinned_contribution: float) -> None:
        remaining = len(self.order)
        suffix_best = [0.0] * (remaining + 1)
        best_of: dict[int, float] = {}
        for talk in self.order:
            best_of[talk.id] = max((c[4] for c in self.candidates[talk.id]), default=0.0)
        for i in range(remaining - 1, -1, -1):
            suffix_best[i] = suffix_best[i + 1] + best_of[self.order[i].id]

        self._dfs(0, 0, pinned_contribution, list(preplaced), suffix_best)

    def _dfs(
        self,
        index: int,
        placed: int,
        partial: float,
        assign: list[tuple[TalkSpec, int, str, int]],
        suffix_best: list[float],
    ) -> None:
        self.nodes += 1
        if self.nodes > self.node_cap:
            self.capped = True
            return
        if self.deadline is not None and self.nodes % 64 == 0 and time.monotonic() >= self.deadline:
            self.timed_out = True
            return

        if index == len(self.order):
            key = (placed, score_placements(self.grid, self.config, assign).objective_total)
            if _better(key, self.best_key):
                self.best_key = key
                self.best_contrib = partial
                self.best_assign = list(assign)
            return

        # Optimistic bound: every remaining talk takes its best cell, no penalty.
        bound = (placed + (len(self.order) - index), partial + suffix_best[index])
        if self.best_key is not None:
            if bound[0] < self.best_key[0]:
                return
            if bound[0] == self.best_key[0] and bound[1] <= self.best_key[1] + _EPS:
                return

        talk = self.order[index]
        for cell in self.candidates[talk.id]:
            if not self.free(cell, talk.speaker_name):
                continue
            self.apply(cell, talk.speaker_name, True)
            assign.append((talk, cell[0], cell[1], cell[2]))
            self._dfs(index + 1, placed + 1, partial + cell[4], assign, suffix_best)
            assign.pop()
            self.apply(cell, talk.speaker_name, False)
            if self.timed_out or self.capped:
                return

        # Unplaced is tried only after every placement, so count wins first.
        self._dfs(index + 1, placed, partial, assign, suffix_best)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def solve(
    solve_input: SolveInput,
    node_cap: int = 200_000,
    time_limit_seconds: float | None = None,
) -> SolveResult:
    grid = solve_input.grid
    config = solve_input.config
    talks = list(solve_input.talks)

    pin_problems = validate_pins(grid, talks, solve_input.pins)
    if pin_problems:
        empty = ScoreBreakdown(talks=(), penalty_collision=0.0, penalty_heavy=0.0, objective_total=0.0)
        return SolveResult(
            status="failed",
            placements=(),
            unplaced=(),
            score=empty,
            pin_problems=tuple(pin_problems),
            notes=("pin_conflict",),
        )

    candidates: dict[int, list[tuple[int, str, int, int, float]]] = {}
    for talk in talks:
        usable = []
        for day, room, start in static_candidates(grid, talk):
            contribution = talk.interest * grid.rhythm(day, room, start, config)
            usable.append((day, room, start, _slot_mask(day, start, talk.slots_needed), contribution))
        # Best contribution first, then a fixed grid order: deterministic and greedy-friendly.
        usable.sort(key=lambda c: (-c[4], c[0], c[1], c[2]))
        candidates[talk.id] = usable

    pinned_cells = {pin.talk_id: (pin.day, pin.room_code, pin.start_slot) for pin in solve_input.pins}
    pinned_ids = frozenset(pinned_cells)

    preplaced: list[tuple[TalkSpec, int, str, int]] = []
    pinned_contribution = 0.0
    variables: list[TalkSpec] = []
    for talk in talks:
        cell = pinned_cells.get(talk.id)
        if cell is not None:
            preplaced.append((talk, cell[0], cell[1], cell[2]))
            pinned_contribution += talk.interest * grid.rhythm(cell[0], cell[1], cell[2], config)
        elif candidates[talk.id]:
            variables.append(talk)

    variables.sort(key=lambda t: (len(candidates[t.id]), -t.interest, t.id))

    searcher = _Searcher(
        grid=grid,
        config=config,
        order=variables,
        candidates=candidates,
        node_cap=node_cap,
        deadline=None if time_limit_seconds is None else time.monotonic() + max(time_limit_seconds, 0.0),
        speaker_names=sorted({t.speaker_name for t in talks}),
    )
    for talk, day, room, start in preplaced:
        mask = _slot_mask(day, start, talk.slots_needed)
        searcher.room_bits[(day, room)] = searcher.room_bits.get((day, room), 0) | mask
        searcher.speaker_bits[talk.speaker_name] = searcher.speaker_bits.get(talk.speaker_name, 0) | mask

    searcher.run(preplaced, pinned_contribution)

    chosen = searcher.best_assign if searcher.best_assign is not None else list(preplaced)
    score = score_placements(grid, config, chosen, pinned_ids)
    placed_ids = {p.talk_id for p in score.talks}

    unplaced = [
        UnplacedTalk(talk.id, talk.title, talk.speaker_name, *(_unplaced_for(grid, talk)))
        for talk in talks
        if talk.id not in placed_ids
    ]

    every_talk_placed = len(placed_ids) == len(talks)
    notes: list[str] = []
    if searcher.timed_out:
        status = "solved" if every_talk_placed else "failed"
        notes.append("timed_out")
    elif searcher.capped:
        status = "solved" if every_talk_placed else "infeasible"
        notes.append("search_capped")
    else:
        status = "solved" if every_talk_placed else "infeasible"

    return SolveResult(
        status=status,
        placements=score.talks,
        unplaced=tuple(unplaced),
        score=score,
        pin_problems=(),
        placed_count=len(score.talks),
        notes=tuple(notes),
        timed_out=searcher.timed_out,
        capped=searcher.capped,
    )


def _unplaced_for(grid: GridSpec, talk: TalkSpec) -> tuple[tuple[str, ...], str]:
    reasons, diagnosis = unplaced_reasons(grid, talk)
    return tuple(reasons), diagnosis
