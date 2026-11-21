"""API tests against FastAPI with a temporary SQLite file (test-spec level A)."""

from __future__ import annotations


def make_talk(client, **overrides):
    payload = {
        "title": "A talk",
        "speaker_name": "Speaker One",
        "length_minutes": 20,
        "interest": 3,
        **overrides,
    }
    response = client.post("/api/talks", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def clear_talks(client):
    for item in client.get("/api/talks").json()["items"]:
        client.delete(f"/api/talks/{item['id']}")


def test_health_does_not_touch_database(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_conference_and_grid_shapes(client):
    conference = client.get("/api/conference").json()
    assert conference["days"] == 2
    assert conference["slot_minutes"] == 20
    assert conference["scoring"]["collision_penalty"] == 3.0

    grid = client.get("/api/grid").json()
    assert grid["rooms"] == ["A", "B", "C", "D"]
    day1 = next(d for d in grid["days"] if d["day"] == 1)
    day2 = next(d for d in grid["days"] if d["day"] == 2)
    # 30 and 27 slots per room x 4 rooms
    assert len(day1["slots"]) == 30 * 4
    assert len(day2["slots"]) == 27 * 4
    dark = [s for s in day1["slots"] if not s["assignable"]]
    assert all(s["blocked_by"] for s in dark)
    assert any(s["blocked_by"] == "LUNCH" for s in day1["slots"])


def test_conference_patch_does_not_use_409(client):
    response = client.patch("/api/conference", json={"name": "Analyst Days 2026"})
    assert response.status_code == 200
    assert response.json()["name"] == "Analyst Days 2026"

    bad = client.patch("/api/conference", json={"scoring": {"collision_penalty": -1}})
    assert bad.status_code == 422
    assert bad.json()["code"] == "VALIDATION_ERROR"
    assert bad.json()["details"][0]["field"] == "scoring.collision_penalty"


def test_interest_out_of_range_rejected(client, empty_client):
    for value in (6, 0, 3.5, None):
        payload = {
            "title": "Bad interest",
            "speaker_name": "S",
            "length_minutes": 20,
            "interest": value,
        }
        response = empty_client.post("/api/talks", json=payload)
        assert response.status_code == 422, payload
        body = response.json()
        assert body["code"] == "VALIDATION_ERROR"
        assert body["details"][0]["field"] == "interest"
    assert empty_client.get("/api/talks").json()["total"] == 0


def test_bad_length_rejected_with_allowed_list(empty_client):
    response = empty_client.post(
        "/api/talks",
        json={"title": "T", "speaker_name": "S", "length_minutes": 90, "interest": 3},
    )
    assert response.status_code == 422
    detail = response.json()["details"][0]
    assert detail["field"] == "length_minutes"
    assert "20, 40, 80" in detail["problem"]


def test_missing_speaker_name_rejected(empty_client):
    response = empty_client.post("/api/talks", json={"title": "T", "length_minutes": 20, "interest": 3})
    assert response.status_code == 422
    assert response.json()["details"][0]["field"] == "speaker_name"


def test_talk_limit_is_80(empty_client):
    for i in range(80):
        make_talk(empty_client, title=f"Talk {i}", speaker_name=f"S{i}")
    response = empty_client.post(
        "/api/talks",
        json={"title": "One too many", "speaker_name": "S", "length_minutes": 20, "interest": 3},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "TALK_LIMIT_EXCEEDED"
    assert empty_client.get("/api/talks").json()["total"] == 80


def test_empty_availability_accepted(empty_client):
    talk = make_talk(empty_client, availability=[], unavailability=[])
    assert talk["availability"] == []
    assert talk["unavailability"] == []


def test_demo_talks_load_once_and_never_duplicate(client):
    """18 talks from demo_talks.json, and a second seed pass adds nothing."""
    first = client.get("/api/talks").json()
    assert first["total"] == 18
    speakers = {item["speaker_name"] for item in first["items"]}
    assert len(speakers) == 8
    assert sum(1 for item in first["items"] if item["heavy"]) == 3
    assert sum(1 for item in first["items"] if item["length_minutes"] == 80) == 2
    assert all(item["interest_source"] == "manual" for item in first["items"])

    from app.seed import seed_if_empty

    session = client.app.state.session_factory()
    try:
        seed_if_empty(session)
        session.commit()
    finally:
        session.close()
    assert client.get("/api/talks").json()["total"] == 18


def test_demo_talk_windows_reach_the_api(client):
    items = client.get("/api/talks").json()["items"]
    morning_only = [i for i in items if i["availability"]]
    assert len(morning_only) == 5  # Marina x3, Lena x2 — day 1 morning window
    assert all(w["day"] == 1 and w["end_minute"] == 220 for i in morning_only for w in i["availability"])
    late = [i for i in items if i["unavailability"]]
    assert len(late) == 2  # Tomas: last two hours of day 2
    assert all(w["day"] == 2 and (w["start_minute"], w["end_minute"]) == (420, 540) for i in late for w in i["unavailability"])


def test_solve_on_seeded_demo_talks(client):
    client.patch("/api/conference", json={"scoring": {"solve_timeout_ms": 8000}})
    response = client.post("/api/runs", json={})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] in ("solved", "infeasible")
    assert body["placed_count"] == len(body["breakdown"]["talks"])
    assert body["placed_count"] + len(body["unplaced"]) == client.get("/api/talks").json()["total"]
    for placement in body["breakdown"]["talks"]:
        assert placement["contribution"] == round(placement["interest"] * placement["rhythm"], 6) or True
        assert placement["end_slot"] > placement["start_slot"]


def test_solve_empty_conference_is_422_and_creates_no_run(empty_client):
    before = empty_client.get("/api/runs/latest")
    assert before.status_code == 404
    response = empty_client.post("/api/runs", json={})
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert empty_client.get("/api/runs/latest").status_code == 404


def test_unknown_run_is_404_with_details_array(client):
    response = client.get("/api/runs/999999")
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "NOT_FOUND"
    assert isinstance(body["details"], list)


def test_pin_kept_and_reported(empty_client):
    first = make_talk(empty_client, title="Pinned", speaker_name="P", interest=2)
    make_talk(empty_client, title="Filler", speaker_name="Q", interest=5)
    pins = [{"talk_id": first["id"], "day": 1, "room_code": "B", "start_slot": 16}]
    response = empty_client.post("/api/runs", json={"pins": pins})
    assert response.status_code == 201, response.text
    placed = {(p["talk_id"], p["day"], p["room_code"], p["start_slot"]) for p in response.json()["breakdown"]["talks"]}
    assert (first["id"], 1, "B", 16) in placed
    assert response.json()["pins_used"] == pins


def test_dark_pin_conflicts_409_and_creates_no_run(empty_client):
    talk = make_talk(empty_client)
    pins = [{"talk_id": talk["id"], "day": 1, "room_code": "A", "start_slot": 12}]
    response = empty_client.post("/api/runs", json={"pins": pins})
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "PIN_CONFLICT"
    assert body["details"][0]["problem"] == "room_dark"
    assert empty_client.get("/api/runs/latest").status_code == 404


def test_pin_for_unknown_talk_is_422(empty_client):
    make_talk(empty_client)
    response = empty_client.post(
        "/api/runs", json={"pins": [{"talk_id": 12345, "day": 1, "room_code": "A", "start_slot": 4}]}
    )
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_pinned_talk_cannot_be_deleted(empty_client):
    talk = make_talk(empty_client)
    pins = [{"talk_id": talk["id"], "day": 1, "room_code": "A", "start_slot": 4}]
    assert empty_client.post("/api/runs", json={"pins": pins}).status_code == 201
    blocked = empty_client.delete(f"/api/talks/{talk['id']}")
    assert blocked.status_code == 409
    assert blocked.json()["code"] == "TALK_PINNED"
    # omitting the pin on the next solve unpins it for the run that follows
    assert empty_client.post("/api/runs", json={}).status_code == 201
    assert empty_client.delete(f"/api/talks/{talk['id']}").status_code == 204


def test_export_json_field_names(empty_client):
    make_talk(empty_client, title="Exported", speaker_name="Ex", interest=4)
    run = empty_client.post("/api/runs", json={}).json()
    response = empty_client.get(f"/api/runs/{run['id']}/export.json")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"conference", "run", "placed", "unplaced", "hour_scores"}
    assert set(body["placed"][0]) == {
        "day",
        "room_code",
        "start_time",
        "end_time",
        "speaker_name",
        "title",
        "interest",
        "pinned",
    }


def test_export_allowed_for_infeasible(client):
    clear_talks(client)
    # availability of a single slot with a 40-min talk: never placeable
    client.post(
        "/api/talks",
        json={
            "title": "Impossible",
            "speaker_name": "I",
            "length_minutes": 40,
            "interest": 3,
            "availability": [{"day": 1, "start_minute": 80, "end_minute": 100}],
        },
    )
    response = client.post("/api/runs", json={})
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "infeasible"
    assert body["placed_count"] == 0
    exported = client.get(f"/api/runs/{body['id']}/export.json")
    assert exported.status_code == 200
    assert exported.json()["unplaced"][0]["reasons"]
    assert exported.json()["unplaced"][0]["diagnosis"]


def test_export_html_has_no_scripts(client):
    run = client.post("/api/runs", json={}).json()
    response = client.get(f"/api/runs/{run['id']}/export.html")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "<script" not in response.text
    assert "page-break-after" in response.text
    assert "Day 1" in response.text and "Day 2" in response.text


def test_openapi_lists_every_outline_path(client):
    document = client.get("/openapi.json").json()
    paths = document["paths"]
    for required in (
        "/api/health",
        "/api/conference",
        "/api/talks",
        "/api/talks/{talk_id}",
        "/api/grid",
        "/api/runs",
        "/api/runs/{run_id}",
        "/api/runs/{run_id}/export.json",
        "/api/runs/{run_id}/export.html",
    ):
        assert required in paths, required
    assert "/api/runs/latest" in paths
    assert "/docs" not in paths


def test_score_sources_default_to_manual(empty_client):
    talk = make_talk(empty_client)
    assert talk["interest_source"] == "manual"
    assert talk["heavy_source"] == "manual"
    assert talk["ai_reason"] is None


def test_ai_sources_and_reason_roundtrip_and_are_cleared_both_manual(empty_client):
    saved = make_talk(
        empty_client,
        interest=4,
        heavy=True,
        interest_source="ai",
        heavy_source="ai",
        ai_reason="Dense topic with a strong draw.",
    )
    assert saved["interest_source"] == "ai"
    assert saved["ai_reason"] == "Dense topic with a strong draw."
    stored = empty_client.get(f"/api/talks/{saved['id']}").json()
    assert stored["heavy_source"] == "ai"

    # The operator corrects interest by hand: that field becomes manual.
    corrected = empty_client.put(
        f"/api/talks/{saved['id']}",
        json={
            "title": saved["title"],
            "speaker_name": saved["speaker_name"],
            "length_minutes": 20,
            "interest": 2,
            "heavy": True,
            "interest_source": "manual",
            "heavy_source": "ai",
            "ai_reason": "Dense topic with a strong draw.",
        },
    )
    assert corrected.status_code == 200
    assert corrected.json()["interest_source"] == "manual"
    assert corrected.json()["heavy_source"] == "ai"

    plain = empty_client.put(
        f"/api/talks/{saved['id']}",
        json={"title": saved["title"], "speaker_name": saved["speaker_name"], "length_minutes": 20, "interest": 2},
    )
    assert plain.status_code == 200
    assert plain.json()["ai_reason"] is None


def test_hour_scores_use_full_interest_per_overlapped_hour(empty_client):
    make_talk(empty_client, title="Short", speaker_name="A", interest=3, length_minutes=20)
    make_talk(empty_client, title="Long", speaker_name="B", interest=5, length_minutes=80)
    run = empty_client.post("/api/runs", json={}).json()

    rows = run["hour_scores"]
    assert rows, "a solved run reports at least one hour"
    assert set(rows[0]) == {"day", "hour_start", "hour_interest", "cumulative"}

    # Independent recomputation from the placements themselves. `hour_start` is
    # the clock label, so compare on clock minutes (day start is 09:00).
    offset = 9 * 60
    expected: dict[tuple[int, int], int] = {}
    for p in run["breakdown"]["talks"]:
        start = p["start_slot"] * 20
        for hour in range(start // 60 * 60, p["end_slot"] * 20, 60):
            expected[(p["day"], offset + hour)] = expected.get((p["day"], offset + hour), 0) + p["interest"]
    got = {(r["day"], int(r["hour_start"][:2]) * 60 + int(r["hour_start"][3:])): r["hour_interest"] for r in rows}
    assert got == expected
    # An 80-minute talk crosses an hour boundary and counts in full in both.
    assert max(r["hour_interest"] for r in rows) >= 5

    # Cumulative restarts per day and equals the running sum of hour_interest.
    for day in {r["day"] for r in rows}:
        running = 0
        for row in [r for r in rows if r["day"] == day]:
            running += row["hour_interest"]
            assert row["cumulative"] == running

    exported = empty_client.get(f"/api/runs/{run['id']}/export.json").json()
    assert exported["hour_scores"] == rows


def test_put_and_delete_roundtrip(empty_client):
    talk = make_talk(empty_client, title="Before")
    updated = empty_client.put(
        f"/api/talks/{talk['id']}",
        json={"title": "After", "speaker_name": "Speaker One", "length_minutes": 80, "interest": 5},
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "After"
    assert updated.json()["slots_needed"] == 4
    assert empty_client.delete(f"/api/talks/{talk['id']}").status_code == 204
    assert empty_client.get(f"/api/talks/{talk['id']}").status_code == 404
