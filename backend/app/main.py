"""HTTP layer. Validation policy lives here and in Pydantic, never in ``scheduler``."""

from __future__ import annotations

import html
from contextlib import asynccontextmanager
from typing import Iterator

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from . import VERSION
from . import llm_score
from . import scheduler as sched
from . import services as svc
from .db import Conference, FixedBlock, ScheduleRun, Talk, init_db, make_engine, single_conference
from .schemas import (
    ApiError,
    ConferenceOut,
    ConferencePatch,
    Error,
    GridOut,
    HealthOut,
    RunOut,
    RunRequest,
    ScoreOut,
    ScoreRequest,
    SolveTimeoutOut,
    TalkIn,
    TalkList,
    TalkOut,
)
from .seed import seed_if_empty, sweep_draft_runs

ERROR_RESPONSES = {
    400: {"model": Error},
    404: {"model": Error},
    409: {"model": Error},
    422: {"model": Error},
    500: {"model": Error},
    502: {"model": Error},
    503: {"model": Error},
    504: {"model": SolveTimeoutOut},
}


def get_db(request: Request) -> Iterator[Session]:
    factory: sessionmaker = request.app.state.session_factory
    session = factory()
    try:
        yield session
    finally:
        session.close()


def _conference(session: Session, missing_status: int = 404) -> Conference:
    conference = single_conference(session)
    if conference is None:
        raise ApiError(missing_status, "NOT_FOUND", "no conference configured")
    return conference


def _conference_out(conference: Conference) -> dict:
    return {
        "id": conference.id,
        "name": conference.name,
        "days": conference.days,
        "slot_minutes": conference.slot_minutes,
        "scoring": sched.ScoringConfig.from_dict(conference.scoring_config).to_dict(),
    }


def _guard_pinned(session: Session, conference: Conference, talk_id: int) -> None:
    if talk_id in svc.pins_in_latest_run(session, conference):
        raise ApiError(
            409,
            "TALK_PINNED",
            "talk is pinned in the latest run; unpin it by omitting it from the next solve",
            [{"talk_id": talk_id, "problem": "pinned"}],
        )


def _talk_or_404(session: Session, talk_id: int) -> Talk:
    talk = session.get(Talk, talk_id)
    if talk is None:
        raise ApiError(404, "NOT_FOUND", f"talk {talk_id} not found")
    return talk


def _apply_sources(talk: Talk, payload: TalkIn) -> None:
    """D-08: an omitted source means the operator typed the value (pre-D-08 behavior)."""
    talk.interest_source = payload.interest_source or "manual"
    talk.heavy_source = payload.heavy_source or "manual"
    if talk.interest_source == "ai" or talk.heavy_source == "ai":
        talk.ai_reason = payload.ai_reason
    else:
        talk.ai_reason = None


def create_app(db_url: str | None = None, seed: bool = True) -> FastAPI:
    """Build the app. Tests pass their own SQLite URL for isolation."""
    engine = make_engine(db_url) if db_url else make_engine()
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        init_db(engine)
        if seed:
            session = session_factory()
            try:
                seed_if_empty(session)
                sweep_draft_runs(session)
                session.commit()
            finally:
                session.close()
        yield

    app = FastAPI(
        title="Analyst Days Agenda",
        version=VERSION,
        description="Two-day, four-room agenda builder. No auth, one conference per database.",
        lifespan=lifespan,
    )
    app.state.engine = engine
    app.state.session_factory = session_factory

    # -- error handling: one shape, always -------------------------------- #

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.body())

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = []
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
            received = err.get("input")
            details.append(
                {
                    "field": ".".join(loc) or None,
                    "problem": str(err.get("msg", "invalid")),
                    "received": received if isinstance(received, (int, float, str, type(None))) else None,
                }
            )
        return JSONResponse(
            status_code=422,
            content={"code": "VALIDATION_ERROR", "message": "request validation failed", "details": details},
        )

    @app.exception_handler(SQLAlchemyError)
    async def _db_error(request: Request, exc: SQLAlchemyError) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"code": "INTERNAL_ERROR", "message": "database error", "details": []},
        )

    # -- health, conference, grid ----------------------------------------- #

    @app.get("/api/health", tags=["health"], response_model=HealthOut, responses=ERROR_RESPONSES)
    def health() -> dict:
        """Liveness only — never touches the database."""
        return {"status": "ok", "version": VERSION}

    @app.get("/api/conference", tags=["conference"], response_model=ConferenceOut, responses=ERROR_RESPONSES)
    def read_conference(session: Session = Depends(get_db)) -> dict:
        return _conference_out(_conference(session))

    @app.patch("/api/conference", tags=["conference"], response_model=ConferenceOut, responses=ERROR_RESPONSES)
    def patch_conference(patch: ConferencePatch, session: Session = Depends(get_db)) -> dict:
        conference = _conference(session)
        if patch.name is not None:
            if not patch.name.strip():
                raise ApiError(
                    422,
                    "VALIDATION_ERROR",
                    "name must not be blank",
                    [{"field": "name", "problem": "must not be blank"}],
                )
            conference.name = patch.name.strip()
        if patch.scoring is not None:
            values = {k: v for k, v in patch.scoring.model_dump().items() if v is not None}
            details = []
            for key, value in values.items():
                if key == "solve_timeout_ms" and value < 1:
                    details.append({"field": f"scoring.{key}", "problem": "must be >= 1"})
                elif key != "solve_timeout_ms" and value < 0:
                    details.append({"field": f"scoring.{key}", "problem": "must be >= 0"})
            if details:
                raise ApiError(422, "VALIDATION_ERROR", "scoring config rejected", details)
            merged = dict(conference.scoring_config or {})
            merged.update(values)
            conference.scoring_config = merged
        session.commit()
        return _conference_out(conference)

    @app.get("/api/grid", tags=["grid"], response_model=GridOut, responses=ERROR_RESPONSES)
    def read_grid(session: Session = Depends(get_db)) -> dict:
        conference = _conference(session)
        grid = svc.load_grid(session, conference)
        blocks = list(
            session.scalars(
                select(FixedBlock).where(FixedBlock.conference_id == conference.id).order_by(FixedBlock.id)
            )
        )
        return svc.grid_payload(grid, blocks)

    # -- AI score suggestion (D-08) ---------------------------------------- #

    @app.post("/api/score", tags=["score"], response_model=ScoreOut, responses=ERROR_RESPONSES)
    def score(payload: ScoreRequest) -> dict:
        """Propose interest and heavy. No database write; the operator saves."""
        return llm_score.score_talk(payload.title.strip(), payload.abstract, payload.length_min)

    # -- talks ------------------------------------------------------------- #

    @app.get("/api/talks", tags=["talks"], response_model=TalkList, responses=ERROR_RESPONSES)
    def list_talks(limit: int | None = None, offset: int | None = None, session: Session = Depends(get_db)) -> dict:
        talks = svc.load_talks(session, _conference(session))
        start = offset or 0
        end = None if limit is None else start + limit
        return {"items": [svc.talk_payload(t) for t in talks[start:end]], "total": len(talks)}

    @app.post("/api/talks", tags=["talks"], status_code=201, response_model=TalkOut, responses=ERROR_RESPONSES)
    def create_talk(payload: TalkIn, session: Session = Depends(get_db)) -> dict:
        conference = _conference(session)
        count = session.scalar(select(func.count()).select_from(Talk).where(Talk.conference_id == conference.id))
        if count >= svc.MAX_TALKS:
            raise ApiError(
                409,
                "TALK_LIMIT_EXCEEDED",
                f"a conference holds at most {svc.MAX_TALKS} talks",
                [{"field": "talks", "problem": "limit_reached", "allowed": f"<= {svc.MAX_TALKS}"}],
            )
        speaker = svc.get_or_create_speaker(session, payload.speaker_name.strip())
        talk = Talk(
            conference_id=conference.id,
            speaker_id=speaker.id,
            title=payload.title.strip(),
            abstract=payload.abstract,
            length_minutes=payload.length_minutes,
            slots_needed=payload.length_minutes // sched.SLOT_MINUTES,
            interest=payload.interest,
            heavy=payload.heavy,
        )
        _apply_sources(talk, payload)
        session.add(talk)
        session.flush()
        svc.replace_windows(
            session,
            talk,
            [w.model_dump() for w in payload.availability],
            [w.model_dump() for w in payload.unavailability],
        )
        session.commit()
        session.refresh(talk)
        return svc.talk_payload(talk)

    @app.get("/api/talks/{talk_id}", tags=["talks"], response_model=TalkOut, responses=ERROR_RESPONSES)
    def read_talk(talk_id: int, session: Session = Depends(get_db)) -> dict:
        return svc.talk_payload(_talk_or_404(session, talk_id))

    @app.put("/api/talks/{talk_id}", tags=["talks"], response_model=TalkOut, responses=ERROR_RESPONSES)
    def replace_talk(talk_id: int, payload: TalkIn, session: Session = Depends(get_db)) -> dict:
        conference = _conference(session)
        talk = _talk_or_404(session, talk_id)
        _guard_pinned(session, conference, talk_id)
        talk.title = payload.title.strip()
        talk.abstract = payload.abstract
        talk.length_minutes = payload.length_minutes
        talk.slots_needed = payload.length_minutes // sched.SLOT_MINUTES
        talk.interest = payload.interest
        talk.heavy = payload.heavy
        _apply_sources(talk, payload)
        talk.speaker_id = svc.get_or_create_speaker(session, payload.speaker_name.strip()).id
        svc.replace_windows(
            session,
            talk,
            [w.model_dump() for w in payload.availability],
            [w.model_dump() for w in payload.unavailability],
        )
        session.commit()
        session.refresh(talk)
        return svc.talk_payload(talk)

    @app.delete("/api/talks/{talk_id}", tags=["talks"], status_code=204, responses=ERROR_RESPONSES)
    def delete_talk(talk_id: int, session: Session = Depends(get_db)) -> Response:
        conference = _conference(session)
        talk = _talk_or_404(session, talk_id)
        _guard_pinned(session, conference, talk_id)
        session.delete(talk)
        session.commit()
        return Response(status_code=204)

    # -- runs -------------------------------------------------------------- #

    @app.post("/api/runs", tags=["runs"], status_code=201, response_model=RunOut, responses=ERROR_RESPONSES)
    def create_run(payload: RunRequest, session: Session = Depends(get_db)) -> Response:
        conference = _conference(session)
        talks = svc.load_talks(session, conference)
        if not talks:
            raise ApiError(
                422,
                "VALIDATION_ERROR",
                "a run needs at least one talk",
                [{"field": "talks", "problem": "empty"}],
            )

        known = {t.id for t in talks}
        unknown = [{"talk_id": p.talk_id, "problem": "unknown_talk"} for p in payload.pins if p.talk_id not in known]
        if unknown:
            raise ApiError(422, "VALIDATION_ERROR", "pin references an unknown talk", unknown)

        pin_payloads = [p.model_dump() for p in payload.pins]
        override = payload.scoring_override.model_dump() if payload.scoring_override else None
        result, grid, _, duration_ms = svc.run_solver(session, conference, pin_payloads, override)

        if result.pin_problems:
            raise ApiError(
                409,
                "PIN_CONFLICT",
                "the pin cannot be satisfied",
                [p.as_detail() for p in result.pin_problems],
            )

        run = svc.persist_run(session, conference, result, pin_payloads, duration_ms, force_failed=result.timed_out)
        body = svc.run_payload(session, run, grid)
        session.commit()

        if result.timed_out:
            return JSONResponse(
                status_code=504,
                content={
                    "code": "SOLVE_TIMEOUT",
                    "message": "the solver hit its wall-clock cap",
                    "details": [],
                    "run": body,
                },
            )
        return JSONResponse(status_code=201, content=body)

    # Declared before ``/api/runs/{run_id}`` so "latest" is not parsed as an id.
    @app.get("/api/runs/latest", tags=["runs"], response_model=RunOut, responses=ERROR_RESPONSES)
    def read_latest_run(session: Session = Depends(get_db)) -> dict:
        conference = _conference(session)
        run = session.scalars(
            select(ScheduleRun)
            .where(ScheduleRun.conference_id == conference.id)
            .order_by(ScheduleRun.id.desc())
        ).first()
        if run is None:
            raise ApiError(404, "NOT_FOUND", "no run has been created yet")
        return svc.run_payload(session, run, svc.load_grid(session, conference))

    @app.get("/api/runs/{run_id}", tags=["runs"], response_model=RunOut, responses=ERROR_RESPONSES)
    def read_run(run_id: int, session: Session = Depends(get_db)) -> dict:
        run = session.get(ScheduleRun, run_id)
        if run is None:
            raise ApiError(404, "NOT_FOUND", f"run {run_id} not found")
        conference = session.get(Conference, run.conference_id)
        return svc.run_payload(session, run, svc.load_grid(session, conference))

    def _exportable(session: Session, run_id: int) -> tuple[ScheduleRun, Conference, sched.GridSpec]:
        run = session.get(ScheduleRun, run_id)
        if run is None:
            raise ApiError(404, "NOT_FOUND", f"run {run_id} not found")
        if run.status in ("draft", "failed"):
            raise ApiError(
                409,
                "RUN_NOT_EXPORTABLE",
                f"a run in status {run.status} cannot be exported",
                [{"field": "status", "problem": "not_exportable", "received": run.status}],
            )
        conference = session.get(Conference, run.conference_id)
        return run, conference, svc.load_grid(session, conference)

    @app.get("/api/runs/{run_id}/export.json", tags=["export"], responses=ERROR_RESPONSES)
    def export_json(run_id: int, session: Session = Depends(get_db)) -> Response:
        run, conference, grid = _exportable(session, run_id)
        return JSONResponse(content=svc.export_payload(session, conference, run, grid))

    @app.get(
        "/api/runs/{run_id}/export.html",
        tags=["export"],
        response_class=HTMLResponse,
        responses=ERROR_RESPONSES,
    )
    def export_html(run_id: int, session: Session = Depends(get_db)) -> Response:
        run, conference, grid = _exportable(session, run_id)
        payload = svc.export_payload(session, conference, run, grid)
        parts = [
            "<!DOCTYPE html><html><head><meta charset='utf-8'>",
            f"<title>{html.escape(conference.name)} — agenda</title>",
            f"<style>{EXPORT_CSS}</style></head><body>",
            f"<h1>{html.escape(conference.name)}</h1>",
            f"<div class='meta'>Run {run.id} · {html.escape(run.status)} · "
            f"{len(payload['placed'])} placed · {len(payload['unplaced'])} unplaced</div>",
        ]
        for day in grid.day_numbers():
            parts.append("<section class='day'>")
            parts.append(f"<h2>Day {day}</h2><table><thead><tr><th>Time</th>")
            for room in grid.rooms:
                parts.append(f"<th>Hall {html.escape(room)}</th>")
            parts.append("</tr></thead><tbody>")
            for slot in range(grid.slots_per_day[day]):
                slot_start = grid.time_label(slot * grid.slot_minutes)
                parts.append(f"<tr><td>{slot_start}</td>")
                for room in grid.rooms:
                    block = grid.block_at(day, room, slot)
                    if block is not None:
                        parts.append(f"<td class='dark'>{html.escape(block.label)}</td>")
                        continue
                    here = [
                        p
                        for p in payload["placed"]
                        if p["day"] == day and p["room_code"] == room and p["start_time"] == slot_start
                    ]
                    if here:
                        cell = "".join(
                            f"<div class='talk'>{html.escape(t['title'])}</div>"
                            f"<div>{html.escape(t['speaker_name'])}</div>"
                            f"<div>{t['start_time']}–{t['end_time']} · interest {t['interest']}"
                            f"{' · pinned' if t['pinned'] else ''}</div>"
                            for t in here
                        )
                        parts.append(f"<td>{cell}</td>")
                    else:
                        parts.append("<td></td>")
                parts.append("</tr>")
            parts.append("</tbody></table></section>")

        if payload["unplaced"]:
            parts.append(
                "<section><h2>Unplaced talks</h2><table><thead><tr>"
                "<th>Talk</th><th>Reasons</th><th>Diagnosis</th></tr></thead><tbody>"
            )
            for item in payload["unplaced"]:
                parts.append(
                    f"<tr><td>{html.escape(item['title'])}</td>"
                    f"<td>{html.escape(', '.join(item['reasons']))}</td>"
                    f"<td>{html.escape(item['diagnosis'])}</td></tr>"
                )
            parts.append("</tbody></table></section>")
        parts.append("</body></html>")
        return HTMLResponse(content="".join(parts))

    return app


EXPORT_CSS = """
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
"""


app = create_app()
