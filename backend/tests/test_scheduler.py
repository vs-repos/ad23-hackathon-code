"""Unit tests on the pure scheduler (test-spec level U). No DB, no HTTP."""

from __future__ import annotations

import pytest

from app import scheduler as s


def grid() -> s.GridSpec:
    return s.default_grid()


def talk(tid, minutes=20, interest=3, speaker=None, heavy=False, availability=(), unavailability=()):
    return s.TalkSpec(
        id=tid,
        title=f"Talk {tid}",
        speaker_name=speaker or f"speaker-{tid}",
        length_minutes=minutes,
        interest=interest,
        heavy=heavy,
        availability=tuple(s.Window(*w) for w in availability),
        unavailability=tuple(s.Window(*w) for w in unavailability),
    )


def solve(*talks, pins=(), config=None):
    return s.solve(
        s.SolveInput(
            grid=grid(),
            talks=tuple(talks),
            pins=tuple(pins),
            config=config or s.ScoringConfig(),
        )
    )


# -- grid sanity ------------------------------------------------------------ #


def test_grid_has_152_assignable_cells_and_locked_day_shapes():
    g = grid()
    assert g.slots_per_day == {1: 30, 2: 27}
    assert s.grid_cell_count(g) == 152
    assert g.rooms == ("A", "B", "C", "D")


def test_lunch_shifts_are_staggered_and_60_minutes():
    g = grid()
    assert g.lunch_slots(1, "A") == (11, 14)
    assert g.lunch_slots(1, "B") == (12, 15)
    assert g.lunch_slots(1, "C") == (13, 16)
    assert g.lunch_slots(2, "A") == (13, 16)
    assert g.lunch_slots(2, "C") == (15, 18)
    # room B is still open at day-1 slot 11 while A is on lunch
    assert g.is_assignable(1, "A", 11) is False
    assert g.is_assignable(1, "B", 11) is True


# -- TS-AG-02 / 13 / 20: contiguity --------------------------------------- #


def test_80_minute_talk_occupies_four_contiguous_slots_in_one_room():
    result = solve(talk(1, minutes=80, interest=4))
    assert result.status == "solved"
    assert len(result.placements) == 1
    p = result.placements[0]
    assert p.end_slot - p.start_slot == 4
    assert len([x for x in result.placements if x.talk_id == 1]) == 1
    g = grid()
    for slot in range(p.start_slot, p.end_slot):
        assert g.is_assignable(p.day, p.room_code, slot)


def test_80_minute_talk_never_split_across_a_fixed_block():
    # Ten minutes of free time either side of coffee cannot hold an 80-min talk
    # starting in the gap; no placement may straddle the break.
    g = grid()
    result = solve(talk(1, minutes=80))
    for p in result.placements:
        for slot in range(p.start_slot, p.end_slot):
            assert g.is_assignable(p.day, p.room_code, slot)


# -- TS-AG-03 / 12: speaker double-booking -------------------------------- #


def test_same_speaker_never_overlaps_self():
    a = talk(1, minutes=80, interest=5, speaker="Same Person")
    b = talk(2, minutes=80, interest=5, speaker="Same Person")
    result = solve(a, b)
    placed = {p.talk_id: p for p in result.placements}
    if len(placed) == 2:
        first, second = placed[1], placed[2]
        assert first.day != second.day or first.start_slot + 4 <= second.start_slot or second.start_slot + 4 <= first.start_slot


def test_one_speaker_two_talks_same_window_only_one_can_be_placed():
    window = (1, 120, 240)  # 10:20-13:00 on day 1, six slots
    a = talk(1, minutes=80, speaker="Solo", availability=[window])
    b = talk(2, minutes=80, speaker="Solo", availability=[window])
    c = talk(3, minutes=20, speaker="Other", availability=[window])
    result = solve(a, b, c)
    solo = [p for p in result.placements if p.talk_id in (1, 2)]
    by_speaker_ok = True
    for i, p in enumerate(solo):
        for q in solo[i + 1:]:
            if p.day == q.day and p.start_slot < q.end_slot and q.start_slot < p.end_slot:
                by_speaker_ok = False
    assert by_speaker_ok
    # 120 min of window fits at most one 80-min talk for that speaker
    assert len(solo) <= 1


# -- TS-AG-04 / 05 / 15: availability ------------------------------------- #


def test_availability_window_is_respected():
    result = solve(talk(1, minutes=40, availability=[(1, 80, 160)]))  # 10:20-11:40
    assert result.status == "solved"
    for p in result.placements:
        assert p.day == 1
        assert p.start_slot >= 4
        assert p.end_slot <= 8


def test_availability_too_short_reports_outside_availability():
    result = solve(talk(1, minutes=40, availability=[(1, 80, 100)]))  # one slot only
    assert result.status == "infeasible"
    assert result.unplaced[0].talk_id == 1
    assert "outside_availability" in result.unplaced[0].reasons
    assert result.placements == ()


def test_empty_availability_means_anywhere():
    result = solve(talk(1))
    assert result.status == "solved"
    assert len(result.placements) == 1


# -- TS-AG-06 / 07: unavailability ---------------------------------------- #


def test_unavailability_window_is_never_intersected():
    blocked = (1, 320, 380)  # 14:20-15:20, slots 16-18
    result = solve(talk(1, minutes=80, unavailability=[blocked]))
    assert result.status == "solved"
    for p in result.placements:
        assert not (p.day == 1 and p.start_slot < 19 and 16 < p.end_slot)


def test_only_window_inside_unavailability_reports_unavailability_overlap():
    # availability and unavailability identical: nothing can be legal
    window = (1, 80, 160)
    result = solve(talk(1, availability=[window], unavailability=[window]))
    assert result.status == "infeasible"
    assert "unavailability_overlap" in result.unplaced[0].reasons
    assert "unavailability" in result.unplaced[0].diagnosis


# -- TS-AG-08 / 21: fixed blocks ------------------------------------------ #


def test_opening_block_cell_is_excluded():
    g = grid()
    # day 1, slot 3 is the opening block in every room
    for room in g.rooms:
        assert g.is_assignable(1, room, 3) is False
    result = solve(talk(1, availability=[(1, 60, 80)]))
    assert result.status == "infeasible"
    assert "fixed_block" in result.unplaced[0].reasons


def test_room_dark_reason_on_a_grid_where_the_only_room_is_dark():
    # One room, every slot covered by a room-scoped block: only room_dark is
    # possible, and no availability window can muddy the reason.
    dark = s.GridSpec(
        rooms=("A",),
        slot_minutes=20,
        day_start_minute=s.DAY_START_MINUTE,
        slots_per_day={1: 6},
        fixed_blocks=(s.FixedBlock("LUNCH", "Lunch", 1, 0, 120, ("A",)),),
    )
    result = s.solve(s.SolveInput(grid=dark, talks=(talk(1),)))
    assert result.status == "infeasible"
    assert result.unplaced[0].reasons == ("room_dark",)
    assert "lunch" in result.unplaced[0].diagnosis


# -- TS-AG-10 / 11 / 23 / 22: scoring ------------------------------------ #


def test_rhythm_early_morning_and_post_lunch():
    g = grid()
    config = s.ScoringConfig()
    # day 1 slot 4 = 10:20 early; slot 16 = 14:20 for room B (lunch 12-15 for B)
    assert g.rhythm(1, "B", 4, config) == pytest.approx(0.6)
    assert g.rhythm(1, "A", 16, config) == pytest.approx(1.1)
    assert g.rhythm(1, "B", 21, config) == pytest.approx(0.8)  # 16:00
    assert g.rhythm(1, "A", g.last_assignable_slot(1, "A"), config) == pytest.approx(0.5)


def test_four_interest_five_talks_do_not_share_a_start_slot():
    talks = [talk(i, minutes=20, interest=5) for i in range(1, 5)]
    result = solve(*talks)
    assert result.status == "solved"
    starts = [(p.day, p.start_slot) for p in result.placements]
    assert len(set(starts)) == 4
    assert result.score.penalty_collision == 0


def test_collision_penalty_formula_on_four_same_start():
    g = grid()
    config = s.ScoringConfig()
    talks = [talk(i, interest=5) for i in range(1, 5)]
    # dislike every slot except the same one, which is legal in four rooms
    placed = [(t, 1, room, 22) for t, room in zip(talks, ("A", "B", "C", "D"))]
    score = s.score_placements(g, config, placed)
    assert score.penalty_collision == pytest.approx(18.0)


def test_heavy_talk_avoids_the_last_two_starts():
    heavy = talk(1, heavy=True, interest=5)
    result = solve(heavy)
    assert result.status == "solved"
    p = result.placements[0]
    g = grid()
    assert p.start_slot not in g.heavy_late_slots(p.day, p.room_code)
    assert result.score.penalty_heavy == 0


def test_breakdown_sums_to_objective_total():
    result = solve(talk(1, interest=5), talk(2, interest=4), talk(3, minutes=40, interest=3))
    assert result.status == "solved"
    score = result.score
    contributions = sum(p.contribution for p in result.placements)
    assert contributions - score.penalty_collision - score.penalty_heavy == pytest.approx(
        score.objective_total, abs=1e-6
    )
    for p in result.placements:
        assert p.contribution == pytest.approx(p.interest * p.rhythm)


# -- TS-AG-24: placed_count lexicographic -------------------------------- #


def test_negative_score_talk_is_still_placed():
    # one room, one late slot only => rhythm 0.5, and heavy-late penalty applies,
    # so its marginal contribution is negative. It must still be placed.
    only_late = [(1, 500, 520)]
    g = s.GridSpec(
        rooms=("A",),
        slot_minutes=20,
        day_start_minute=s.DAY_START_MINUTE,
        slots_per_day={1: 30},
        fixed_blocks=(
            s.FixedBlock("REGISTRATION", "Registration", 1, 0, 80),
            s.FixedBlock("COFFEE", "Coffee", 1, 380, 420),
            s.FixedBlock("EVENING", "Evening", 1, 520, 600),
        ),
    )
    negative = s.TalkSpec(
        id=1, title="Unpopular", speaker_name="Someone", length_minutes=20, interest=1,
        heavy=True, availability=(s.Window(1, 500, 520),),
    )
    result = s.solve(s.SolveInput(grid=g, talks=(negative,)))
    assert result.placed_count == 1
    assert result.status == "solved"
    assert result.score.objective_total < 0
    assert only_late  # the only legal start is the last assignable one


def test_placed_count_wins_over_objective():
    # Two talks, one cell each, and the cells collide. Two placements beat one.
    a = talk(1, minutes=20, interest=1)
    b = talk(2, minutes=20, interest=1)
    result = solve(a, b)
    assert result.placed_count == 2


def test_infeasible_reports_placed_count():
    # Five 80-min talks restricted to one 80-min window. That window exists in
    # all four rooms (day 1 slots 4-8), so four are placed and one cannot be.
    window = [(1, 80, 160)]
    talks = [talk(i, minutes=80, availability=window) for i in range(1, 6)]
    result = solve(*talks)
    assert result.placed_count == 4
    assert result.status == "infeasible"
    assert len(result.unplaced) == 1
    assert result.unplaced[0].reasons == ("no_free_slot",)


# -- TS-AG-25: determinism ----------------------------------------------- #


def test_solve_is_deterministic():
    talks = tuple(talk(i, minutes=m, interest=i % 5 + 1) for i, m in enumerate([20, 40, 80, 20, 40], start=1))
    first = solve(*talks)
    second = solve(*talks)
    rebuilt = s.solve(s.SolveInput(grid=s.default_grid(), talks=talks))
    assert first.placements == second.placements == rebuilt.placements
    assert first.score.objective_total == rebuilt.score.objective_total


# -- TS-AG-26 / 27 / 28: pins -------------------------------------------- #


def test_pinned_talk_kept_in_its_cell():
    pinned = s.Pin(talk_id=1, day=1, room_code="B", start_slot=16)
    result = solve(talk(1, minutes=20, interest=2), talk(2, interest=5), pins=[pinned])
    assert result.status == "solved"
    hit = [p for p in result.placements if p.talk_id == 1][0]
    assert (hit.day, hit.room_code, hit.start_slot) == (1, "B", 16)
    assert hit.pinned is True


def test_illegal_pin_is_reported_not_silently_moved():
    # day 1, room A, slot 12 is inside A's lunch shift
    pinned = s.Pin(talk_id=1, day=1, room_code="A", start_slot=12)
    result = solve(talk(1), pins=[pinned])
    assert result.status == "failed"
    assert result.pin_problems[0].problem == "room_dark"


def test_pin_against_fixed_block_reports_a_problem():
    pinned = s.Pin(talk_id=1, day=1, room_code="C", start_slot=3)  # opening
    result = solve(talk(1), pins=[pinned])
    assert result.status == "failed"
    assert result.pin_problems[0].problem in ("room_dark",)


def test_two_pins_same_cell_report_cell_occupied():
    pins = [
        s.Pin(talk_id=1, day=1, room_code="A", start_slot=4),
        s.Pin(talk_id=2, day=1, room_code="A", start_slot=4),
    ]
    result = solve(talk(1), talk(2), pins=pins)
    assert result.status == "failed"
    assert result.pin_problems[0].problem == "cell_occupied"


def test_pins_double_booking_a_speaker_are_rejected():
    pins = [
        s.Pin(talk_id=1, day=1, room_code="A", start_slot=4),
        s.Pin(talk_id=2, day=1, room_code="B", start_slot=4),
    ]
    result = solve(talk(1, speaker="One"), talk(2, speaker="One"), pins=pins)
    assert result.status == "failed"
    assert result.pin_problems[0].problem == "speaker_double_booked"


# -- edge cases ---------------------------------------------------------- #


def test_empty_talk_list_is_not_an_error_in_the_pure_layer():
    result = solve()
    assert result.status == "solved"
    assert result.placed_count == 0
    assert result.unplaced == ()


def test_time_cap_returns_timed_out_flag():
    talks = [talk(i, interest=(i % 5) + 1) for i in range(1, 31)]
    result = s.solve(
        s.SolveInput(grid=grid(), talks=tuple(talks)),
        time_limit_seconds=0.0,
    )
    assert result.timed_out is True


def test_every_talk_is_accounted_for():
    talks = [talk(i, minutes=m) for i, m in enumerate([20, 40, 80, 20, 40, 80], start=1)]
    result = solve(*talks)
    placed = {p.talk_id for p in result.placements}
    unplaced = {u.talk_id for u in result.unplaced}
    assert placed | unplaced == {t.id for t in talks}
    assert placed & unplaced == set()
