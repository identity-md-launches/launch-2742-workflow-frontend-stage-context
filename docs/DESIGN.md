# DESIGN: Squeek Supply Station web

Written from the final source (`web/src/style.css`, `web/index.html`, `web/src/main.ts`,
`web/src/sheet.ts`). This file lives at the frontend project root, `web/`, because this
assignment may write only `web/**`, `dist/**` and `docs/**`; the repository root is outside it.

## Tokens (`web/src/style.css` `:root`)

- Color: `--bg #fff8ed`, `--surface #fffdfa`, `--soft #f5ead7`, `--ink #38291f`,
  `--muted #6b5d4e`, `--line #e4d4bb`, `--line-strong #c3915f`, `--orange #b44d0a` (primary action),
  `--orange-dark #8f3c06` (hover, links), `--green #1f6450` (ok), `--red #a8352a` (errors).
  The palette is the original game's; the canvas art keeps its own palette in `src/game/render.js`.
- Type scale: `--fs-1 12px` (labels, HUD captions), `--fs-2 14px` (hints, tables, facts),
  `--fs-3 16px` (body), `--fs-4 20px` (h2, HUD numbers), `--fs-5 28px` (h1 under 680 px),
  `--fs-6 40px` (h1, result score).
- Weights: 400 body, 600 controls and h2/h3, 800 h1, brand and result score.
- Families: system UI stack with Chinese fallbacks (`--font`); `--mono` only for hashes/addresses.
- Radius: 8 / 12 / 16 px. No shadows; surfaces are separated by 1 px `--line` borders.

## Components

- Header: brand button, nav (Play, Leaderboard, Contract, How to play; `aria-current` on the active
  view), sound toggle (SVG), language toggle (中/EN), one wallet control. Under 680 px the nav wraps to
  a full-width second row. The English labels are about twice as wide as the Chinese ones, so in
  English (`html:lang(en)`) the nav takes its own row from 960 px down, with labels kept on one line,
  and becomes a 2×2 grid at 440 px and below.
- Wrong-chain banner: one sentence and one primary "Switch to Sepolia" button.
- Buttons: 44 px minimum, rest / hover (lighter fill, stronger border) / active / disabled 60 % /
  2 px ink focus ring with 2 px offset. Primary = orange fill, white text.
- Lobby: h1 + one-line lead + two actions + sign-in hint; challenge card with three phase tiles
  (source transaction links), collapsible sources; three rule notes.
- Game: HUD (score, delivered, time), energy bar, 400:640 canvas stage, mission card with Deliver,
  queue preview, pouch and shake tools. Unchanged mechanics.
- Leaderboard: date field and a horizontally scrollable table inside its own wrapper.
- Contract view: three cards (contract state facts, your on-chain record, owner settings with
  address/bytes32 inputs and one button per contract function).
- Result dialog: score in `--fs-6`, verification status, rank, chain status line, Pin on Sepolia,
  play again, back.
- Wallet sheet: a native modal `<dialog>` opened with `showModal()`, so it sits in the top layer
  above the result dialog and keeps focus inside it; 420 px max, 48 px rows (icon 28 px + name),
  × close, backdrop and Escape close, focus returns to the control that opened it; full-width
  bottom sheet under 680 px.
- Toasts: bottom-right stack, non-interactive.

## Responsive behaviour

- ≥1001 px: game in three columns (route, board, tools).
- 681–1000 px: route column hidden; board + tools.
- ≤960 px, English only: nav on its own full-width row under the brand and header actions.
- ≤680 px: 16 px gutters, nav on its own row, h1 28 px, phase tiles and rules stacked, game becomes
  a single column (mission, board ≤280 px wide, queue, tools), sheet becomes a bottom sheet. The
  delivery hint keeps `min-height: 3.2em` (two lines) so the board does not move when its copy
  changes between waiting, ready and done.
- ≤440 px, English only: nav as two columns of two (142 px wide buttons at 320 px).
- `body` min-width 320 px; addresses wrap with `overflow-wrap:anywhere`; the probe found no sideways
  scroll at 320, 390 or 1440.
- `prefers-reduced-motion`: transitions off.
