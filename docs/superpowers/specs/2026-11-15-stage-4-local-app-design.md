# Stage 4: Local App — Design

Parent spec: `docs/superpowers/specs/2026-10-31-auchan-harness-design.md` (its Run flow, Cart safety and Error handling still bind). Decisions below were made with the user on 2026-11-15.

## Intent

One local page that runs a whole shopping trip as a seven-step wizard: **Dane → Lista → Przegląd → Doprecyzowanie → Zatwierdzenie → Koszyk → Płatność** (Szkic was split into Lista and Przegląd on 2026-11-16). Claude helps with the whole trip in context (it sees the note, the draft and the answers), through `claude -p`, but only proposes; the app validates every proposal and the user clicks to apply. The chat wizard (`auchan-plan` skill) stays as the fallback.

Success: the user pastes a list like the 2026-11-15 one, answers one round of questions, approves once, watches the cart fill, and gets the report with the pay link — without opening a terminal chat.

## Decisions

1. **Stack:** `node:http` server and one page of plain HTML, CSS and JS served by the same process. No new dependencies, no build step. `npm run app` starts it and prints the URL.
2. **Access:** listens on `127.0.0.1` only. Default port 47474 (`APP_PORT` overrides it). A random token (32 hex chars) is created once, kept in `.state/app-token` (mode 600) and reused on every start; it is part of the printed URL; every request without it gets 403. Requests must also have `Host: 127.0.0.1:<port>` (DNS rebinding) and, for POST, `Origin` equal to the app's origin or absent with `Sec-Fetch-Site: same-origin`. JSON bodies only, max 64 KB.
3. **Claude with whole-trip context:** each call is `claude -p` with `--output-format json`, `--json-schema <schema>`, `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, `--no-session-persistence`, `--model sonnet`, spawned with no shell in a fresh empty temporary directory (never `--bare`, which breaks the user's login; the isolation flags matter because the repo's MCP servers include a logged-in browser), a fixed system prompt, and the full trip state in the prompt (note, current lines with candidate ids, names, prices, confidence, the user's answers). No session is resumed; the state is passed in every time. Product names and offer texts are marked as data in the prompt. The call has a 60 s timeout.
4. **Claude only proposes.** Output is a list of operations from a closed set:
   - `add { term, quantity, note? }` — run the planner for a new term
   - `choose { lineKey, productId }` — productId must be one of that line's candidates
   - `remove { lineKey }`, `setQuantity { lineKey, quantity }` (integer 1..20)
   - `ask { lineKey, question, options: productId[] }` (≤3 options, all candidates of that line)
   - `unmatched { term, hint }` — "add this yourself on Auchan"
   - `say { text }` — an answer to a question, shown as text
   The server validates every operation against the current trip (ids, keys, ranges) and drops invalid ones, saying how many were dropped. Valid ones are shown as a proposal; nothing changes until the user clicks "Zastosuj".
5. **Three Claude moments:** (a) note → items (`add` operations) with notes like "duża paczka, gouda albo edam"; (b) after the draft: choose per line using the notes, and `ask` only where it cannot decide; (c) an "ad hoc" box on every step: "Powiedz, co zmienić" — free text, answered with operations or `say`.
6. **Fallback without Claude:** if `claude` is missing, times out, or returns invalid JSON, the note is split by lines (trailing integer = quantity, the rest = term), the draft uses the planner and match confidence only, and every low/medium line is asked. The page says which mode it is in.
7. **Everything else reuses existing code:** `buildDraft`, match confidence, `recordCorrection`, `setBrandFixed`, `approveBasket`, `fillCart` with the same login and lock rules as `npm run fill`, `formatReport` data, the sync from `src/cli.ts`.
8. **User choices teach the planner:** applying a `choose` that differs from the planner's proposal, picking an option in Doprecyzowanie, or removing a term line records a correction (as the skill does today).
9. **Sync from the app:** "Odśwież dane" runs the orders+promotions sync in-process; if a login is needed the browser window opens as today and the page says "Zaloguj się w oknie przeglądarki i zostaw je otwarte".
10. **Fill from the app:** "Zatwierdź i dodaj do koszyka" calls `approveBasket`, then runs the fill in-process under the fill lock. Progress streams to the page over Server-Sent Events (`sent/total`, then the report). Only one fill at a time (the lock); a second click is refused.
11. **Payment hand-off:** the last step shows the report groups (check before paying, out of stock / partially added with substitutes, add by hand, already in the cart, small rises, total) and a link `https://zakupy.auchan.pl/checkout` that opens in the user's browser. The server never requests it.
12. **Rules tab:** lists learned rules (`intentRules`) with a delete button each (`deleteRule`), and fixed brands with a clear button (`setBrandFixed(term, null)`). It also searches the local catalog to add or remove product blocks. Blocks are saved in the local database and applied during drafting, approval and cart filling.
13. **Trip state** lives in server memory (one trip at a time) and is mirrored to `.state/trip.json` (mode 600) after every change so a restart resumes it. "Nowe zakupy" clears it.

## Pages and API

One page, seven step tabs (later steps disabled until reached), a progress line like the chat wizard, the "Powiedz, co zmienić" box on steps 2–4, and a Rules tab.

API (all JSON, all need the token):
- `GET /api/state` — trip state, data freshness, mode (claude/fallback)
- `POST /api/sync` — start a sync (SSE progress at `GET /api/events`)
- `POST /api/note { note, includeUsual, budgetGrosze? }` — parse + draft + Claude choose/ask → proposal
- `POST /api/ask { text }` — ad hoc instruction → proposal
- `POST /api/apply { proposalId }` / `POST /api/reject { proposalId }`
- `POST /api/answer { lineKey, productId | null }` — a clarification answer (null = skip/remove)
- `POST /api/line { lineKey, quantity | remove | included }` — manual edits
- `POST /api/line/by-hand { lineKey }` — move a line to the add-by-hand list
- `POST /api/unmatched/remove { term }` — drop an add-by-hand term
- `POST /api/proposal/op { proposalId, index, accept }` — include or leave out one operation of a proposal
- `POST /api/search { terms?, force? }` (≤10 terms) — search Auchan for terms the local data does not know (SSE progress), with the same pacing and 24 h block as `npm run search-auchan`
- `POST /api/approve` — approve and start the fill (SSE progress)
- `GET /api/rules`, `POST /api/rules/delete { term }`, `POST /api/rules/brand { term, brand: null }`
- `GET /api/blocked` — the blocked products, `[{ productId, name }]`
- `POST /api/blocked/search { query }` (2–100 characters) — catalogue products to block, `[{ productId, name }]`
- `POST /api/blocked/add { productId }` / `POST /api/blocked/remove { productId }` — answer `{ changed: true }`; 409 while a fill or sync runs or the cart lock is held; a change invalidates the current draft
- `POST /api/trip/reset`

The Szymanowska flour rule is a brand rule tied to its seeded blacklist row ("Wszystkie mąki Szymanowskie"): it blocks every flour of that brand, and "Odblokuj" on that row lifts the whole rule.

## Safety

- Same rules as the CLI: no checkout request, only the existing worker POSTs, 403 stops with no rerun advice, cookies and the CSRF token never reach the page, logs or errors.
- Claude has no tools; its output is data validated against the trip; it can't approve or fill.
- Auchan text is passed through `cleanText` and rendered with `textContent` only (no `innerHTML` with data).
- The page sets `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https://zakupy.auchan.pl; frame-ancestors 'none'`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- The token never appears in logs other than the one startup line (and the "already running" line); `.state/trip.json` holds no cookies.

## Testing

Everything is tested offline (the user asked for tests for everything):
- server: token, Host and Origin checks, body limit, every route with fake deps (fake Claude runner, fake store, fake cart worker), SSE events;
- Claude runner: argument list (no tools, schema, no session), timeout, invalid JSON → fallback, operation validation (each invalid case dropped);
- fallback parser: lines, quantities, bullets, blank lines;
- trip state: apply/reject, answers recording corrections, persistence to `.state/trip.json` and resume;
- page: a small DOM-free test of the pure render/state helpers in `public/app.js` (kept as ES module functions), and a smoke test that the HTML references only same-origin assets;
- no test spawns the real `claude`, browser, or network.

## Out of scope

Searching Auchan without the user (it runs only on the user's click, in a visible window), editing the cart beyond adding, multiple users, remote access, mobile layout polish beyond a usable narrow view.
