# Frontend validation (worker run, 2026-10-30)

Export: `dist/` (Vite, base `./`, 11 files, about 1.27 MB). Manifest: `dist/imd-deployment.json`
(launch 334bd55d-94b0-4a08-93ca-4b0d3d263cfa, Sepolia 11155111, source commit ac4a5c7, contract
SqueekSupplyBoard 0x21384e42f851956fa673459297d76dfe8e778c5d, abiHash 1378c693…9322 recomputed from
`abi/SqueekSupplyBoard.json` with sorted-key canonical JSON keccak and matched).

## Commands and results

| Check | Result |
| --- | --- |
| `npm run typecheck` (tsc strict, noImplicitAny off for the ported game shell) | pass |
| `npm run build` | pass; manifest written, 10 assets hashed |
| `npm test` (vitest, 7 tests) | 7/7 pass |
| `node test/e2e.mjs` (Chromium, 390 px, scripted EIP-6963 wallet) | 19/20 pass, see below |
| Revision reproduction script (Chromium and WebKit, see "Revision 2") | all pass on the new export; 8 fail on the previous export |
| design probe `taste.mjs` on `dist/` | 16/16 checks pass |
| On-chain: `eth_getCode` / `signer()` / `owner()` via the public Sepolia RPC | code present; signer 0x2Dc8…8653, owner 0x5140…2575, as the brief states |
| Real API `/v1/config` | board 0x21384e…8c5d (matches the handoff), attestationConfigured true, signer matches the contract |

e2e checks that passed: daily challenge loads from the real API (3 phases); main action, wallet
control and headline inside the first 390x844 screen; no sideways scroll at 390 and 320; practice
run plays and finishes locally; connect sheet lists the EIP-6963 wallet and Coinbase Wallet and never
"Injected"; on the wrong chain `wallet_switchEthereumChain` fails with 4902, then
`wallet_addEthereumChain` is sent with parameters byte-equal to network.json's `walletAddChain`, then
switch again; API sign-in with `personal_sign`; live contract reads (owner, signer, code) through the
public RPC; the connected player's on-chain best and today's config lock; owner panel shown to the
owner address; owner input validation; wrong-chain banner with one "Switch to Sepolia" control and
transaction buttons disabled; the switch control restores the chain; leaderboard loads from the
real API; pin control shown for a verified ranked run and disabled with its reason (a 0-point run is
not a pinnable best).

Failed: "no page errors". One unhandled rejection with an `undefined` reason is raised during the
scripted wallet session (no message or stack; nothing visible on the page and every flow completes).
It was not traced to its source in this run; likely a wagmi/Coinbase connector probe against the
minimal mock provider. Recorded as open.

## Not tested (needs a real wallet, funds or the hosted origin)

- A real `pinScore` transaction, owner transactions and receipt/12-confirmation tracking: no
  transaction was broadcast. The code path simulates before signing and is exercised up to the
  enabled/disabled decision only.
- Real wallet signatures accepted by `/v1/auth/verify`, and a real ranked run submitted to
  `/v1/runs/*/finish` (the test answers those endpoints itself).
- The hosted page reaching the API: the API currently sends no `Access-Control-Allow-Origin` for
  foreign origins, so the backend must list the published IPFS/ENS origins in `CORS_ORIGINS`.
- Coinbase Smart Wallet and the phone "Open in" links (no device here).

## Better Interface review (six domains)

Coverage: source review of `web/index.html`, `web/src/style.css`, `web/src/main.ts`,
`web/src/sheet.ts`, plus rendered checks through the probe and e2e at 320/390/1440.

- Accessibility: skip link, labelled nav with `aria-current`, `role=status` regions for async
  results, wallet sheet as a native modal `<dialog>` (top layer, page behind it inert) with
  Escape/backdrop/× close, focus on the first row and back on the trigger when it closes, 2 px focus
  ring. Fixed: emoji sound toggle replaced with an SVG and a translated `aria-label`
  (`web/src/main.ts`, `renderMute`).
- Layout: first screen at 390 now shows headline, one plain line, both play buttons and the wallet
  control (the original hero card and eyebrow labels were removed, `web/index.html` lobby). Nav
  wraps to its own row under 680 px; facts use `overflow-wrap:anywhere` so full addresses never
  scroll sideways.
- Writing: headline cut to "Today's hamster supply run"; all-caps labels ("SUPPLY RUN COMPLETE",
  "YOUR THREE-STAGE ROUTE", "SEPOLIA") changed to sentence case (`web/src/game/i18n.js`).
- Typography: six sizes (12/14/16/20/28/40), weights 400/600/800, one family plus monospace for
  hashes (`web/src/style.css` `:root`). Original letter-spaced eyebrows removed.
- Colors: original warm palette kept; muted text darkened to #6b5d4e; probe contrast 4.5:1 pass.
- UI: one connect control that becomes "0x1234…abcd · Disconnect"; wrong-chain banner with one
  switch control; transaction buttons disabled until code is verified and the chain is right;
  pin control explains why it is disabled.

Remaining limitations: two controls under the 44 px comfortable size at 390 (reported, not failed,
by the probe); the game board itself is a canvas and is described by its `aria-label` only.

## Revision 2: reviewer findings

The previous export (`git archive HEAD dist`) and the rebuilt export were both run through a
Playwright script that follows each finding's reproduction, in Chromium and WebKit at 390x844
(and 320 where noted), with the game API and RPC answered by the test.

- 4f7d25d3 (wallet picker behind the results dialog), reproduced: with a restored pending ranked
  result and no wallet, `elementFromPoint` at the first wallet row's centre was `resultDialog` and
  the click never reached the wallet; from the lobby, Tab went from the picker to BODY, the skip
  link and the nav buttons. Fixed in `web/src/sheet.ts`: the picker is now a `<dialog>` opened
  with `showModal()`, closed with `close()`, with focus returned to its trigger; connector and
  signing logic unchanged. CSS in `web/src/style.css` (wallet sheet section and the ≤680 px
  bottom sheet). After: the row is the top element, clicking it runs `eth_requestAccounts` and
  `personal_sign`; Tab only cycles through the picker's controls (and out to the browser chrome,
  as a native modal does), never to page controls; Escape and backdrop close it; it fits at 320,
  390 and 1440 with no sideways scroll.
- 605d852a (board moves when the delivery hint changes), reproduced: `.stage` top moved by
  22.39 px between the waiting copy (two lines) and the ready copy (one line) at 320 and 390.
  Fixed: the ≤680 px `#deliveryHint` rule uses `min-height: 3.2em`. After: `.stage` top is the
  same for the waiting, ready and mission-done copy in both languages. (Measured by freezing the
  HUD loop and setting each hint text, not by playing to a level-3 hamster.)
- f2fa4bed (failed challenge turns into "Loading…" on language switch), reproduced with a 503 from
  `/v1/challenges/today`: after switching language the status read "Loading…" in both languages
  with no request pending. Fixed in `web/src/main.ts`: the failed request is kept in
  `state.challengeError` and `renderChallenge()` renders loading, failed or loaded state, so the
  language switch retranslates the failure. A failed reload also clears the stale challenge so
  Daily stays disabled. After: "Daily challenge unavailable. Retry or play practice." plus the
  reason in English and Chinese, still one request; Retry with a 200 shows three phases and
  enables Daily.

Also in this round: `web/package-lock.json` was out of sync with `package.json` (`npm ci` refused
it: react, loose-envify and js-tokens missing as optional peers); `npm install` brought it in sync
and the unchanged source rebuilt byte-identical to the previous export before any edit. The e2e
"API sign-in" check read the hint before sign-in finished; it now waits for it (`web/test/e2e.mjs`).
With that, e2e is 19/20; "no page errors" still fails with the same `undefined` rejection recorded
above, and it fails the same way on the previous export. Design probe after the final build: 16/16
checks pass; the 390 screenshot shows headline, both play buttons and the wallet control on the
first screen. Not re-tested: the full played delivery cycle, real wallets, phones.
