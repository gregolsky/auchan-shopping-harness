# Stage 4: Local App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local page (`npm run app`) that runs a shopping trip as a six-step wizard, with Claude (`claude -p`, no tools) proposing in whole-trip context and the app validating and applying only what the user clicks.

**Architecture:** Pure modules for the trip (state, operations, fallback parsing) under `src/app/`, a Claude runner with an injected process spawner, a service that composes the existing planner, store, fill and sync code behind injected deps, and a `node:http` server with token/Host/Origin checks, JSON routes, SSE and static files from `public/`. The page is plain HTML/JS whose pure helpers are ES-module functions tested in Node.

**Tech Stack:** Node 26 running TypeScript directly, `node:http`, `node:child_process`, `node:test`, existing `zod`. No new dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-11-15-stage-4-local-app-design.md` (parent: `docs/superpowers/specs/2026-10-31-auchan-harness-design.md`).

## Global Constraints

- Test-first for every behaviour; tests never spawn the real `claude`, the browser, or the network (the user asked for tests for everything).
- Server binds `127.0.0.1` only; a 32-hex-char token per start, required on every request (`?t=` for the page and SSE, `x-app-token` header for API calls); `Host` must be `127.0.0.1:<port>`; POST needs `Origin` equal to `http://127.0.0.1:<port>` (or no Origin with `Sec-Fetch-Site: same-origin`); JSON bodies only, max 64 KB.
- Response headers on every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Claude call: `claude -p --output-format json --json-schema <schema> --tools "" --no-session-persistence --model sonnet`, system prompt via `--append-system-prompt`, 60 s timeout; the whole trip state in the prompt; no `--resume`.
- Operations are a closed set: `add`, `choose`, `remove`, `setQuantity` (integer 1..20), `ask` (≤3 options, all candidates of that line), `unmatched`, `say`. Invalid ones are dropped and counted.
- Auchan text goes through `cleanText` (src/parse.ts) server-side and is rendered with `textContent` only. No `innerHTML` with data.
- No checkout request; the pay link is `https://zakupy.auchan.pl/checkout`, opened by the user's browser. Cookies and the CSRF token never reach the page, logs or errors. 403 stops with no rerun advice.
- Fill from the app uses the same lock (`.state/fill.lock`), login and report rules as `npm run fill`. Quantities integer 1..20, no duplicate products.
- `.state/trip.json` mode 600, no cookies. One trip at a time.
- `src/mcp.ts` must not import anything new (its import-graph test stays strict). Don't touch `perf/zakupy-benchmarks.md`, `.mcp.json`, `.claude/settings.local.json`.
- Money in integer grosze; shown as `12,59 zł` (`zl` from src/fill-cli.ts).
- Commit messages end with a blank line and `Claude-Session: https://claude.ai/code/session_01TjAfTmTcEMZJsaVgktXDkB`.

## Review Focus

1. **Claude proposes a product id that is not a candidate, or a quantity of 50.** Expected: dropped, the page says "pominięto N nieprawidłowych zmian". → Task 1 `validateOps drops ...` tests.
2. **`claude` is not installed or hangs.** Expected: fallback mode within 60 s, the page says so, every low/medium line is asked. → Task 3 `timeout falls back`, Task 4 `note in fallback mode asks every doubtful line`.
3. **Another website in the user's browser POSTs to the app.** Expected: 403 (no token / wrong Origin / wrong Host). → Task 5 security tests.
4. **The user clicks approve twice, or a CLI fill is running.** Expected: second fill refused with the busy text; no double add. → Task 4 `approve refuses while the lock is held`.
5. **The app restarts mid-trip.** Expected: the trip resumes from `.state/trip.json`; a fill in progress is not resumed automatically (the user reruns; the fill is idempotent). → Task 2 persistence tests, Task 4 `startup resumes the trip but not a fill`.

---

### Task 1: Operations and the fallback note parser (pure)

**Files:**
- Create: `src/app/ops.ts`, `src/app/fallback.ts`
- Test: `tests/app-ops.test.ts`, `tests/app-fallback.test.ts`

**Interfaces:**
- Produces in `src/app/ops.ts`:
  ```ts
  export type Op =
    | { op: 'add'; term: string; quantity: number; note?: string }
    | { op: 'choose'; lineKey: string; productId: string }
    | { op: 'remove'; lineKey: string }
    | { op: 'setQuantity'; lineKey: string; quantity: number }
    | { op: 'ask'; lineKey: string; question: string; options: string[] }
    | { op: 'unmatched'; term: string; hint: string }
    | { op: 'say'; text: string };
  export interface LineView { lineKey: string; candidateIds: string[] }
  export function validateOps(raw: unknown, lines: LineView[]): { ops: Op[]; dropped: number };
  export const OPS_JSON_SCHEMA: object; // { type:'object', properties:{ ops:{ type:'array', items:{ anyOf:[...one per op] } } }, required:['ops'] }
  ```
- Produces in `src/app/fallback.ts`: `export function parseNote(note: string): { term: string; quantity: number; note: string }[]`.

- [ ] **Step 1: Write the failing tests.**
  - `validateOps keeps valid operations of every kind` (one of each, against lines `[{lineKey:'t:ser zolty', candidateIds:['A','B']}]`).
  - `validateOps drops ...`, one assertion each, `dropped` counts them: unknown `op`; `choose` with a productId not in that line's candidates; unknown `lineKey`; `setQuantity` 0, 21, 1.5; `add` with quantity 0/21/1.5 or empty term or term > 100 chars; `ask` with 4 options or an option not a candidate; `say` text > 2000 chars; non-object input → `{ops:[],dropped:0}` for `null`, and `raw` without `ops` array.
  - Strings are trimmed and run through `cleanText`; a `say` containing `\u001b[31m` comes out without it.
  - `parseNote`: `"- cukier 2 \n- mąka 2\n\n- ryż  \n• ser żółty  duża paczka gouda albo edam\nkoncentrat pomidorowy 3"` → `[{term:'cukier',quantity:2,note:''},{term:'mąka',quantity:2,note:''},{term:'ryż',quantity:1,note:''},{term:'ser żółty duża paczka gouda albo edam',quantity:1,note:''},{term:'koncentrat pomidorowy',quantity:3,note:''}]` (bullets `-`, `*`, `•` and extra spaces stripped; a trailing integer 1..20 is the quantity; `x3`/`3x` also accepted; a trailing number > 20 stays part of the term); empty note → `[]`; at most 100 items.
- [ ] **Step 2: Run** `node --test tests/app-ops.test.ts tests/app-fallback.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Validation is hand-written (no zod needed, but zod is allowed); `OPS_JSON_SCHEMA` mirrors the ranges.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: validate Claude's proposed operations and parse a note without Claude`.

### Task 2: Trip state (pure + persistence)

**Files:**
- Create: `src/app/trip.ts`
- Test: `tests/app-trip.test.ts`

**Interfaces:**
- Consumes: `Op`, `LineView` (Task 1); `Draft`, `DraftLine` (src/draft.ts); `Confidence` (src/candidates.ts).
- Produces:
  ```ts
  export type Step = 'dane' | 'szkic' | 'doprecyzowanie' | 'zatwierdzenie' | 'koszyk' | 'platnosc';
  export interface Candidate { productId: string; name: string; lineCostGrosze: number; confidence: Confidence }
  export interface TripLine { lineKey: string; term: string | null; note: string; productId: string; name: string; quantity: number; lineCostGrosze: number; reason: string; confidence: Confidence; confidenceReason: string; candidates: Candidate[]; proposedProductId: string; question: { text: string; options: string[] } | null; included: boolean; kind: 'item' | 'suggestion' }
  export interface Proposal { id: string; ops: Op[]; dropped: number; source: 'claude' | 'fallback' }
  export interface Trip { note: string; step: Step; mode: 'claude' | 'fallback'; lines: TripLine[]; unmatched: { term: string; hint: string }[]; messages: string[]; proposal: Proposal | null; updatedAt: string }
  export interface Correction { term: string; proposedProductId: string | null; chosenProductId: string | null; reason?: string }
  export function emptyTrip(now: Date): Trip;
  export function lineKeyFor(term: string | null, productId: string): string; // 't:'+normaliseTerm(term) or 'p:'+productId
  export function tripFromDraft(trip: Trip, draft: Draft, notes: Record<string, string>): Trip; // items → kind 'item' included; stockUps/promotions/addOns → kind 'suggestion' not included; candidates = the chosen product + alternatives; unmatched terms → trip.unmatched (hint '')
  export function lineViews(trip: Trip): LineView[];
  export function applyOps(trip: Trip, ops: Op[]): { trip: Trip; corrections: Correction[]; addTerms: { term: string; quantity: number; note: string }[] }; // 'add' is returned for the service to draft; 'choose' different from proposedProductId → correction; 'remove' on a term line → correction with chosen null; 'ask' sets line.question; 'say' appends to messages
  export function answer(trip: Trip, lineKey: string, productId: string | null): { trip: Trip; corrections: Correction[] }; // null removes the line
  export function setIncluded(trip: Trip, lineKey: string, included: boolean): Trip;
  export function openQuestions(trip: Trip): TripLine[]; // included lines with question !== null
  export function needsQuestion(line: TripLine): boolean; // confidence !== 'high'
  export function approvedLines(trip: Trip): { term: string | null; productId: string; quantity: number }[]; // included lines; refuses duplicates by merging is NOT done — throws if a product appears twice
  export function totalGrosze(trip: Trip): number;
  export function saveTrip(file: string, trip: Trip): void; // temp file 'wx' 0o600 + rename
  export function loadTrip(file: string): Trip | null; // null when missing or not a valid trip shape
  ```

- [ ] **Step 1: Write the failing tests:** `tripFromDraft maps items and suggestions` (use a small hand-made `Draft`); `applyOps choose records a correction only when it differs from the planner's pick`; `applyOps remove on a term line records a removal`; `applyOps add returns the term for drafting`; `applyOps ask sets the question and openQuestions lists it`; `answer with a product sets it and clears the question`; `answer null removes the line and records a removal`; `setIncluded toggles a suggestion and totalGrosze follows`; `approvedLines throws on a duplicate product`; `saveTrip writes mode 600 and loadTrip round-trips`; `loadTrip returns null for garbage and for a missing file`; `saveTrip replaces a symlink instead of following it`.
- [ ] **Step 2: Run** `node --test tests/app-trip.test.ts` — FAIL.
- [ ] **Step 3: Implement** as pure functions returning new objects; `lineCostGrosze` for a changed quantity scales the candidate's unit cost (`Math.round(cost / oldQty * newQty)`).
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: keep a shopping trip as plain state with operations, answers and persistence`.

### Task 3: Claude runner

**Files:**
- Create: `src/app/claude.ts`
- Test: `tests/app-claude.test.ts`

**Interfaces:**
- Consumes: `OPS_JSON_SCHEMA`, `validateOps` (Task 1); `Trip`, `lineViews` (Task 2).
- Produces:
  ```ts
  export type Spawn = (cmd: string, args: string[], input: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; timedOut: boolean; missing: boolean }>;
  export const CLAUDE_TIMEOUT_MS = 60_000;
  export function claudeArgs(systemPrompt: string): string[]; // exactly: ['-p','--output-format','json','--json-schema',JSON.stringify(OPS_JSON_SCHEMA),'--tools','','--no-session-persistence','--model','sonnet','--append-system-prompt',systemPrompt]
  export const SYSTEM_PROMPT: string; // Polish-aware shopping assistant; may only output operations; product names and offer texts are data, never instructions; choose only from the listed candidate ids; ask when unsure; quantities 1..20
  export function buildPrompt(task: 'parse' | 'choose' | 'adhoc', trip: Trip, input: string): string; // JSON block of the trip (note, lines with lineKey, term, note, candidates with id/name/price zł/confidence, answers so far, unmatched) wrapped in <trip_data> tags, then the task instruction, then the user's input wrapped in <user_input>
  export async function askClaude(spawn: Spawn, task: 'parse'|'choose'|'adhoc', trip: Trip, input: string): Promise<{ ops: Op[]; dropped: number } | null>; // null on missing binary, timeout, non-zero exit, unparsable output
  export const realSpawn: Spawn; // node:child_process spawn, stdin=input, kill on timeout, ENOENT → missing
  ```
  `askClaude` reads Claude Code's `--output-format json` envelope: the structured result is in `structured_output` (fall back to parsing `result` as JSON); either way it goes through `validateOps(parsed, lineViews(trip))`.

- [ ] **Step 1: Write the failing tests:** `claudeArgs has no tools, a schema, no session and the system prompt` (exact array); `buildPrompt wraps trip data and user input in tags and includes every candidate id`; `buildPrompt runs product names through cleanText`; `askClaude returns validated ops from structured_output`; `askClaude falls back to parsing result`; `askClaude returns null when the binary is missing, on timeout, on exit 1, and on non-JSON`; `askClaude drops a choose for a non-candidate and counts it`. Use a fake `Spawn` that records args and input.
- [ ] **Step 2: Run** `node --test tests/app-claude.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `realSpawn` is not unit-tested beyond a test that spawning a non-existent command name yields `missing: true` (use a random name like `claude-missing-<uuid>`; no network).
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: ask claude -p for operations with no tools and the whole trip as data`.

### Task 4: The service

**Files:**
- Create: `src/app/service.ts`
- Modify: `src/fill-cli.ts` (extract `runFill`), `src/cli.ts` (export `runSync`)
- Test: `tests/app-service.test.ts`, existing `tests/fill-cli.test.ts`, `tests/cli.test.ts` stay green

**Interfaces:**
- Consumes: Tasks 1–3; `buildDraft`; `Store` methods `productFacts`, `intentRules`, `recordCorrection`, `setBrandFixed`, `deleteRule`, `approveBasket`, `latestApprovedBasket`, `lastSyncFinishedAt`; `withLogin`, `describeFailure`; `fillCart`; lock helpers in src/lock.ts; `formatReport` data (`FillReport`).
- Produces:
  - In `src/fill-cli.ts`: `export async function runFill(deps: FillDeps, hooks: { log(line: string): void; progress(sent: number, total: number): void }): Promise<{ code: number; report: (FillReport & { sent: number }) | null; substitutes: Record<string, string[]> }>` — the body of today's `main` (lock, basket check, plan total line, withLogin, report data); `main` becomes a thin wrapper that prints via `console`. All existing fill-cli tests stay green unchanged.
  - In `src/cli.ts`: `export async function runSync(which, worker, store, paceMs)` (the existing internal function) and `export async function syncAll(deps: Deps, log: (line: string) => void): Promise<number>` used by `main` (same output).
  - In `src/app/service.ts`:
    ```ts
    export type AppEvent = { type: 'log'; text: string } | { type: 'progress'; sent: number; total: number } | { type: 'report'; report: unknown } | { type: 'state' } | { type: 'done'; code: number };
    export interface ServiceDeps { openStore(): Store; spawn: Spawn; fillDeps: FillDeps; syncDeps: Deps; tripFile: string; now(): Date; emit(e: AppEvent): void }
    export function createService(d: ServiceDeps): {
      state(): { trip: Trip; freshness: { ordersAt: string | null; promotionsAt: string | null; ageHours: number | null }; busy: 'sync' | 'fill' | null };
      note(input: { note: string; includeUsual: boolean; budgetGrosze?: number }): Promise<Trip>;
      ask(text: string): Promise<Trip>;
      apply(proposalId: string): Trip; reject(proposalId: string): Trip;
      answer(lineKey: string, productId: string | null): Trip;
      line(lineKey: string, change: { quantity?: number; remove?: true; included?: boolean }): Trip;
      approve(): Promise<{ started: boolean; reason?: string }>;
      sync(): Promise<{ started: boolean; reason?: string }>;
      rules(): IntentRule[]; deleteRule(term: string): void; clearBrand(term: string): void;
      reset(): Trip;
    };
    ```
  - `note`: `askClaude('parse')` → `add` ops (fallback `parseNote` when null, mode 'fallback') → `buildDraft` for the terms (+ includeUsual) → `tripFromDraft` → in claude mode `askClaude('choose')` as a pending proposal; in fallback mode every line with `needsQuestion` gets `question` with its candidates (≤3, high first). Step becomes `doprecyzowanie` if questions or a proposal exist, else `zatwierdzenie`.
  - `apply`: `applyOps`; record each correction via `store.recordCorrection`; draft any `addTerms` and merge them in; persist.
  - `approve`: refuses when `openQuestions` is non-empty or nothing is included; `approveBasket(approvedLines, unmatched terms)`; then `runFill` in the background with hooks → `emit` progress/log/report/done; step `koszyk` then `platnosc`. Refuses when busy or when the lock is held (busy text from fill-cli).
  - Every mutation persists with `saveTrip` and emits `{type:'state'}`. Startup: `loadTrip(tripFile)` or `emptyTrip`; a trip loaded at step `koszyk` is moved back to `zatwierdzenie` with a message "Wypełnianie przerwane — uruchom ponownie; doda tylko brakujące".

- [ ] **Step 1: Write the failing tests** with a temp DB seeded like tests/draft.test.ts, a fake Spawn, the Task-5 fake cart from tests/helpers/fake-cart.ts wrapped as a worker, and temp lock/trip files:
  `note in claude mode drafts the parsed terms and holds Claude's choose proposal`; `note in fallback mode asks every doubtful line`; `apply records corrections for changed choices`; `ask returns a proposal and a say message`; `answer clears the question and approve then succeeds`; `approve refuses with open questions`; `approve refuses while the lock is held`; `approve fills the fake cart and emits progress then report then done`; `a second approve during a fill is refused`; `startup resumes the trip but not a fill`; `sync refuses during a fill`; `rules lists, deletes a rule and clears a brand`; `reset clears the trip file`. Plus: fill-cli and cli tests unchanged and green after the extraction.
- [ ] **Step 2: Run** `node --test tests/app-service.test.ts` — FAIL.
- [ ] **Step 3: Implement** the extraction first (run fill-cli/cli tests green), then the service.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: run a whole trip in a service over the planner, Claude, the fill and the sync`.

### Task 5: HTTP server and `npm run app`

**Files:**
- Create: `src/app/server.ts`
- Modify: `package.json` (`"app": "node src/app/server.ts"`)
- Test: `tests/app-server.test.ts`

**Interfaces:**
- Consumes: `createService` (Task 4).
- Produces: `export function createAppServer(o: { service: ReturnType<typeof createService>; token: string; publicDir: string }): http.Server` and `export function subscribe(...)` for SSE; `main()` builds live deps (same as fill-cli/cli live deps, `realSpawn`, `.state/trip.json`), listens on `127.0.0.1` port 0 (or `APP_PORT`), prints `Zakupy: http://127.0.0.1:<port>/?t=<token>` once.
- Routes exactly as the spec's API list; `GET /` serves `public/index.html`, `GET /app.js`, `GET /app.css` (only these three files; anything else 404). Token: `?t=` query for `GET /`, static files and `GET /api/events`; header `x-app-token` for every other `/api/*`. Errors → JSON `{error: string}` with fixed texts; no stack traces.

- [ ] **Step 1: Write the failing tests** (server on port 0, real `fetch` to 127.0.0.1 — local only, a fake service):
  `requests without the token get 403 and no body detail`; `a wrong Host gets 403`; `a POST with a foreign Origin gets 403`; `a POST without Origin but Sec-Fetch-Site same-origin is allowed`; `a body over 64 KB gets 413`; `non-JSON body gets 400`; `every response carries the security headers`; `GET / serves index.html with the CSP`; `an unknown path gets 404 and no file outside public is served (../ attempts)`; `each API route calls the service and returns its JSON` (one test per route); `the events stream sends state and progress events as SSE`; `service errors come back as a fixed message, never a stack`.
- [ ] **Step 2: Run** `node --test tests/app-server.test.ts` — FAIL.
- [ ] **Step 3: Implement** with `node:http` only; token compare with `crypto.timingSafeEqual`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: serve the shopping app on 127.0.0.1 with a token, origin checks and SSE`.

### Task 6: The page

**Files:**
- Create: `public/index.html`, `public/app.css`, `public/app.js`
- Test: `tests/app-page.test.ts`

**Interfaces:**
- Consumes: the API (Task 5) and the `Trip` shape (Task 2).
- Produces in `public/app.js` (ES module; DOM code only inside `start()`):
  ```js
  export const STEPS = ['Dane','Szkic','Doprecyzowanie','Zatwierdzenie','Koszyk','Płatność'];
  export function progressLine(stepIndex) // '[1 Dane ✓] → [2 Szkic ✓] → [3 Doprecyzowanie •] → [4 Zatwierdzenie] → [5 Koszyk] → [6 Płatność]'
  export function zl(grosze) // '12,59 zł'
  export function viewModel(state) // { stepIndex, freshnessText, lines:[{key,name,qty,price,badge,reason,question,options}], suggestions, unmatched, total, canApprove, proposalText }
  export function describeOp(op, linesByKey) // Polish one-line description, e.g. 'Zamień „Ser żółty…” na „Ser Gouda…”'
  export function start() // wires the DOM: fetch with x-app-token from location ?t=, EventSource('/api/events?t=…'), renders with textContent only
  ```
  UI: step tabs with the progress line; Dane (freshness + "Odśwież dane"); Szkic (note textarea, "to co zwykle" checkbox, budget field, lines with confidence badges, suggestions with "dodaj" toggles); Doprecyzowanie (one card per question with option buttons and "pomiń"); Zatwierdzenie (summary, total, "Zatwierdź i dodaj do koszyka"); Koszyk (progress bar from SSE, log lines); Płatność (report groups, pay link `https://zakupy.auchan.pl/checkout` with `target="_blank" rel="noopener noreferrer"`). "Powiedz, co zmienić" box on steps 2–4 showing the proposal with "Zastosuj"/"Odrzuć" and dropped count. A Rules tab. Narrow-screen usable.

- [ ] **Step 1: Write the failing tests:** `progressLine marks done and current steps` (index 2 gives the exact string above); `zl formats grosze`; `viewModel marks approve disabled while questions are open`; `viewModel computes the total from included lines`; `describeOp describes each operation kind in Polish`; `index.html loads only same-origin app.js and app.css, has no inline script or style`; `app.js never uses innerHTML, outerHTML, insertAdjacentHTML or document.write` (static text check).
- [ ] **Step 2: Run** `node --test tests/app-page.test.ts` — FAIL.
- [ ] **Step 3: Implement** the page.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS. Then start `npm run app` locally with a fake-free smoke: open the printed URL is the user's step (Task 7); the controller only checks the server starts and `GET /?t=` returns 200 via curl to 127.0.0.1.
- [ ] **Step 5: Commit** `feat: the six-step shopping page`.

### Task 7: Docs and hand-over

**Files:**
- Modify: `README.md`, `.claude/skills/auchan-plan/SKILL.md` (one line: the app is the main way, this wizard is the fallback), `.claude/commands/zakupy.md`
- Modify: parent spec Build order (stage 4 done note)

- [ ] **Step 1:** README: `npm run app` (what it does, the token URL, Claude use with no tools, fallback mode, it never pays), keep `npm run fill`.
- [ ] **Step 2:** Skill and `/zakupy`: one line each pointing to `npm run app` as the main way.
- [ ] **Step 3:** Run `npm test && npm run typecheck`; commit `docs: the local app is the main way to shop; the chat wizard is the fallback`.
- [ ] **Step 4 (user):** the user runs `! npm run app`, opens the URL and tries a list; findings go back into the ledger.
