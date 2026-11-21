# Analyst Days — Agenda Builder (hackathon MVP)

A three-layer web app for the Analyst Days organizer: enter talks, run the scheduler, read the
grid and the score breakdown, pin a talk and re-run, export JSON or print.

- **Backend** — Python 3.12, FastAPI, SQLAlchemy, one SQLite file.
- **Scheduler** — a pure Python module with no framework imports. This is where every scheduling
  rule lives; the HTTP layer only maps rows in and out.
- **Frontend** — Next.js (App Router) + TypeScript + Tailwind. The browser calls only same-origin
  `/api/*`; Next.js rewrites that to the backend origin.

No Docker, no auth, no external optimizer.

## Layout

```text
code/
  backend/
    app/scheduler.py   pure solver: grid, candidates, scoring, DFS + branch and bound
    app/db.py          seven SQLAlchemy tables, in-place column upgrade
    app/services.py    DB <-> SolveInput/SolveOutput mapping, persistence, export payloads, hour scores
    app/main.py        FastAPI app factory, every endpoint, the single error shape
    app/schemas.py     Pydantic wire models
    app/seed.py        first-start conference, rooms, fixed blocks; loads demo_talks.json
    app/demo_talks.json  18 fictional demo talks (len/interest/heavy/availability)
    app/llm_score.py   OpenAI-compatible client for POST /api/score (never imported by scheduler.py)
    tests/             pytest: unit tests on the pure solver + API tests + mocked LLM tests
    data/agenda.db     created on first start (gitignored)
    .env.example       the three LLM variable names, empty values
  frontend/
    app/page.tsx       landing page
    app/agenda/page.tsx  the tool
    components/        talk form, grid table
    lib/               typed API client
```

## Requirements

- Python 3.11+ (developed on 3.11, code targets 3.12 syntax where it matters — `X | None`, slots)
- Node 20+ and npm

## Run the backend

```bash
cd code/backend
python -m venv .venv            # optional
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

The import path is `app.main:app`. On first start the app creates `code/backend/data/agenda.db`
and seeds one conference, four rooms, the fixed blocks, and 18 demo talks, so the UI is not
blank. Demo talks load from `backend/app/demo_talks.json` on first start, and only when the talk
table is empty — an existing database is never reseeded or duplicated. An existing `agenda.db`
from before D-08 is upgraded in place: on startup `init_db` adds the three missing `talk` columns
if they are absent. No table is dropped and no row is deleted.

- Swagger UI: <http://127.0.0.1:8000/docs>
- OpenAPI JSON: <http://127.0.0.1:8000/openapi.json>
- Liveness: <http://127.0.0.1:8000/api/health>

To use a different database file, set `AGENDA_DB_URL` (a SQLAlchemy URL). That is a process
environment variable, not a `.env` file — this project has no `.env` and does not read one.

The AI score button (`POST /api/score`, D-08) reads three more process variables, and works with
any free OpenAI-compatible chat endpoint:

| Variable | Default | Note |
|---|---|---|
| `AGENDA_LLM_BASE_URL` | `https://api.groq.com/openai/v1` | base URL, `/chat/completions` is appended |
| `AGENDA_LLM_API_KEY` | unset | preferred; falls back to `GROQ_API_KEY`. Never logged |
| `AGENDA_LLM_MODEL` | `llama-3.1-8b-instant` | Groq's free tier |

Groq's free tier is the default. OpenRouter example: `AGENDA_LLM_BASE_URL=https://openrouter.ai/api/v1`,
`AGENDA_LLM_MODEL=meta-llama/llama-3.2-3b-instruct:free`, key in `AGENDA_LLM_API_KEY`. With no key the
endpoint answers 503 `LLM_NOT_CONFIGURED` and the form still accepts a hand-typed score — the operator
is always the authority. `code/backend/.env.example` lists the three names with empty values; copy the
names into your shell or platform config, this repo ships no `.env` file.

| Variable | Default | Note |
|---|---|---|
| `AGENDA_LLM_DEMO_FALLBACK` | `off` | set `on` to allow the keyless demo endpoint when no key is set |

Demo fallback (opt-in, no key needed): with `AGENDA_LLM_DEMO_FALLBACK=on` and no API key, the score
button calls `https://text.pollinations.ai/openai/chat/completions`, an anonymous public chat endpoint.
It returned HTTP 200 with parseable JSON when probed on 2026-11-21, but it is third-party, unversioned
and can vanish or rate-limit without notice. Every suggestion from this path has a `reason` starting
with `demo-unverified: ` so the UI and the operator can see it did not come from a keyed provider. If
the endpoint is unreachable the response is 503 `LLM_NOT_CONFIGURED`; if it returns unusable JSON the
response is 502 `LLM_BAD_RESPONSE`. No score is ever invented, and manual entry always works.

## Run the frontend

```bash
cd code/frontend
npm install
npm run dev          # http://127.0.0.1:3000
```

Point the proxy at the backend with a server-side environment variable **in the frontend process**
(not in the browser):

```bash
# Windows PowerShell
$env:BACKEND_ORIGIN = "http://127.0.0.1:8000"; npm run dev
# bash
BACKEND_ORIGIN=http://127.0.0.1:8000 npm run dev
```

Default is `http://127.0.0.1:8000`, which is what the command above uses.

Production build:

```bash
cd code/frontend
npm run build
npm run start
```

## Tests

```bash
cd code/backend
python -m pytest -q
```

67 tests: unit tests over the pure scheduler (contiguity, speaker double-booking, availability and
unavailability, fixed blocks, rhythm bands, collision and heavy penalties, `placed_count`
lexicographic ordering, determinism, pins), API tests through FastAPI's `TestClient` against a
temporary SQLite file per test, and `POST /api/score` tests with the HTTP layer always mocked —
including the demo fallback path and its `off` default. No test calls a live model or endpoint.

## How the solver decides

1. **Hard constraints first**, always. A cell is a candidate only as a whole block of
   `length_minutes / 20` consecutive assignable slots in one room; the range must sit inside one
   availability window and must not touch any unavailability window or fixed block.
2. **Lexicographic rank** `(placed_count, objective)`. Placing one more talk beats any objective
   gain, so a talk with a negative marginal score is still placed — that is the rule, not a bug.
3. **Objective** = Σ `interest × rhythm` − collision − heavy-late, with the rhythm bands and both
   penalties stored in the conference's `scoring_config`, not hard-coded in the search.
4. **Search** is depth-first with an optimistic bound (every remaining talk takes its best rhythm
   with no penalty) and a 200 000-node cap. Deterministic ordering: most constrained first, then
   interest descending, then id.

Pins are not a resource. A solve request carries `pins`; the pin state shown in the UI is the
latest run's `pins_used`. An illegal pin makes the run fail with `PIN_CONFLICT` naming the pin, and
no run row is created.

## API

Every path is in `product/contracts/openapi-outline.md` and in `/docs`. Summarised:

| Method | Path | Note |
|---|---|---|
| GET | `/api/health` | never touches the database |
| GET / PATCH | `/api/conference` | PATCH does not use 409 |
| POST | `/api/score` | AI proposes `interest` + `heavy`; no DB write; 503 without a key (or an unreachable demo fallback), 502 on a bad answer |
| GET / POST | `/api/talks` | 80-talk cap, 409 `TALK_LIMIT_EXCEEDED`; carries `interest_source` / `heavy_source` / `ai_reason` |
| GET / PUT / DELETE | `/api/talks/{id}` | 409 `TALK_PINNED` while pinned |
| GET | `/api/grid` | every slot with `assignable` and `blocked_by` |
| POST | `/api/runs` | 201 solved or infeasible; 409 `PIN_CONFLICT`; 504 `SOLVE_TIMEOUT` |
| GET | `/api/runs/latest` | the newest run for the page load |
| GET | `/api/runs/{id}` | run + `breakdown` + `unplaced` |
| GET | `/api/runs/{id}/export.json` | allowed for `solved` and `infeasible`; 409 only for `draft`/`failed` |
| GET | `/api/runs/{id}/export.html` | one table per day, print stylesheet, no scripts |

Errors are always `{"code", "message", "details": []}`. The 504 body carries `details: []` and the
partial run.

## Two UI behaviors worth knowing

- **Score with AI.** The form's button posts title, abstract and length to `/api/score` and fills the
  interest and heavy fields. Nothing is stored until you press the save button. On an existing talk,
  the same button refills the form; you then choose *Save changes* to correct the stored values, so a
  saved talk is never silently overwritten. The talks list marks a row `AI` when the saved value came
  unchanged from a suggestion and `edited` otherwise; hovering the `AI` tag shows the model's
  one-sentence reason.
- **Cumulative interest.** The schedule grid has one extra column aligned to clock hours: it shows the
  running total of hourly interest across all rooms for that day.

## Grid

2 days, rooms A–D, 20-minute slots. Day 1 is 30 slots, day 2 is 27; 152 assignable cells in total.
Registration/opening sit before the first assignable slot on day 1, coffee blocks sit mid-day on
both days, three staggered 60-minute lunch shifts darken one room set each, and the evening program
and closing close each day.

## Not in this MVP

Accounts, PDF, genetic algorithms, deployment, video. Model-based scoring is *not* in the objective:
D-08 lets a model propose `interest` and `heavy` for the operator to accept or edit, and the solver
still consumes plain integers and booleans.
