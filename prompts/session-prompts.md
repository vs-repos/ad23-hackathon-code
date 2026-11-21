# Prompt record — Analyst Days agenda MVP

A factual list of the instructions that drove this implementation, kept as the hackathon artifact
("набор промптов"). Not marketing, not a tutorial.

## Prompts and rulings actually followed

1. **Binding spec.** Read `product/docs/03-srs.md`, `04-sds.md`, `05-test-spec.md`,
   `product/contracts/openapi-outline.md`, `06-decisions.md`, `08-landing-copy.md` first; treat them
   as authoritative over any conflicting instruction in the build prompt.
2. **Locked grid.** 2 days, rooms A–D, 20-minute slots, day 1 = 30 slots, day 2 = 27 slots, 152
   assignable cells. Fixed blocks seeded from SDS §4, including the three staggered 60-minute lunch
   shifts per day (day 1: A 11–13, B 12–14, C+D 13–15; day 2: A 13–15, B 14–16, C+D 15–17).
3. **Lengths.** 20/40/80 minutes map to 1/2/4 contiguous slots in one room. A candidate cell is
   always generated as a whole block, never repaired afterwards.
4. **Lexicographic rule.** Maximise `placed_count` first, `objective = Σ(interest × rhythm) −
   collision − heavy` second. Collision penalty 3.0 per pair of interest ≥ 4 talks sharing a start;
   heavy-late 2.0 for a heavy talk in one of the last two assignable starts of its day. Rhythm bands
   0.6 / 1.0 / 1.1 / 0.8 / 0.5.
5. **Solver shape.** Depth-first branch and bound, pinned-first and most-constrained-first ordering,
   optimistic bound over remaining talks, node cap 200 000, deterministic ordering, no randomness.
   A talk is left unplaced only after every placement was tried.
6. **Pins are not a resource.** No pin table, no pin CRUD. A solve body carries `pins`; the UI's pin
   state is the latest run's `pins_used`. An illegal pin makes the run fail and names it.
7. **Export.** Allowed for `solved` and `infeasible`; 409 only for `draft` or `failed`. `placed[]`
   keys are exactly `day, room_code, start_time, end_time, speaker_name, title, interest, pinned`.
8. **Errors.** One shape `{code, message, details[]}` everywhere, including FastAPI's default
   validation errors. Wire field for the score explanation is `breakdown`; the column may be
   `objective_breakdown`.
9. **Three layers.** `scheduler.py` imports no FastAPI and no SQLAlchemy. All scheduling rules live
   there; `services.py` only maps rows to `SolveInput`/`SolveOutput` and persists.
10. **Tests.** Unit tests on the pure scheduler and API tests through `TestClient` against a
    temporary SQLite file. Implemented the cases from `05-test-spec.md` that do not need a browser;
    ran them.
11. **Frontend.** Next.js App Router + TypeScript + Tailwind. Landing copy from `08-landing-copy.md`
    verbatim, CTA label exactly `Build the agenda`. The browser only calls same-origin `/api/*`,
    proxied by `next.config.js` from a server-side env value. No scheduling logic in the frontend.
12. **No `.env`, no Docker, no deploy.** `AGENDA_DB_URL` and `BACKEND_ORIGIN` are plain process
    environment variables.

## Prompts rejected or trimmed during implementation

- *"Implement DP over the set of talks, Held-Karp style."* Rejected: the prompt itself calls
  Held-Karp too heavy, and DP over occupancy states would have to carry the penalty subtotals in the
  state to stay correct. A branch and bound whose objective is recomputed at leaves is exact for
  this instance size and far easier to explain to an organizer.
- *"Memoise on `(talk_index, hash(room_bits), hash(speaker_bits))`."* Dropped from the SDS sketch:
  the objective is not separable across that state (collision and heavy penalties depend on the whole
  assignment), so a naive memo would prune optimal branches. The bound prune alone keeps the demo
  instance under a second; the memo is the documented upgrade path if instance sizes grow.
- *"Add a `shadcn` component library."* Skipped: four Tailwind utility classes do the job for a
  two-page MVP, and a design system is out of scope.

## Corrections made after running the tests

- The rhythm function compared minute-of-day offsets against absolute clock minutes; fixed to
  offsets from 09:00 (11:00 = 120, 16:00 = 420).
- Unplaced-reason reporting first listed `outside_availability` for a talk that still had valid
  cells; fixed so a talk with any statically valid cell reports `no_free_slot`, and a blocked
  unavailability outranks "window too short" in the diagnosis text.
