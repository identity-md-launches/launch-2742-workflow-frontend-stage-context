# Squeek Supply Station: static website

The existing bilingual (中文 / English) HTML/Canvas game, packaged as a static site for IPFS/ENS.
Same ss-2.0.0 engine, daily challenge, free practice, three 60-second missions, server replay
verification and real leaderboard, connected to the game API `https://api.btc-psbt.fun:9443` and to
the deployed `SqueekSupplyBoard` on Sepolia (`0x21384e42f851956fa673459297d76dfe8e778c5d`).

Stack: Vite + TypeScript. The game modules under `src/game/` are the original vanilla JS files
(engine, rules, challenge, render, audio, i18n) copied from `squeek-drop-frontend/squeek-drop/js/`;
only `i18n.js` changed (new strings, sentence-case labels). React was not added: the brief asks to
publish the existing game, and its DOM/Canvas code runs unchanged. Wallets use `@wagmi/core` +
`viem` (EIP-6963 injected wallets, Coinbase Wallet / Smart Wallet, "Open in" links on phones; no
relay, no project ID).

## Configuration (one place)

- `src/config.ts`: the game API origin, site metadata, and the loader for `./imd-deployment.json`.
- `dist/imd-deployment.json` is the runtime deployment configuration: chain id, contract address,
  ABI path/hash, the `network` block (public RPC URLs, explorer) and `walletAddChain`, copied from the
  attested handoff (`web/deployment/deployment.json`) and `network.json` (`web/deployment/network.json`).
  The app fetches it at start, loads `abi/SqueekSupplyBoard.json`, and refuses transactions when the
  ABI's canonical keccak differs from the handoff's `abiHash` or the address has no code on Sepolia.
- No private keys, API keys or private RPC URLs are in the source or export.

## Build

```sh
cd web
npm ci --legacy-peer-deps    # @wagmi/connectors pins an exact @wagmi/core peer
npm run build                # tsc --noEmit, vite build -> ../dist, then writes dist/imd-deployment.json
npm run preview              # serves ../dist
```

`npm run manifest` rewrites `dist/imd-deployment.json` (SHA-256 of every exported file) after any
change to `dist/`. `HANDOFF=` / `NETWORK=` override the handoff paths.

## Validation

```sh
npm run typecheck
npm test                     # vitest: manifest/ABI hash checks, connector list rules
NODE_USE_ENV_PROXY=1 IMD_PLAYWRIGHT=/path/to/playwright/index.mjs node test/e2e.mjs
```

`test/e2e.mjs` drives the built export in Chromium with a scripted EIP-6963 wallet. Game-API reads
and Sepolia RPC go to the real services; login, run creation and run finishing are answered by the
test (they need a real signature and a real played run). Results: `../docs/frontend-validation.md`.

## What the site does

- Lobby: today's frozen challenge with its three source settlement transactions, Play daily
  challenge, Free practice, sign-in hint.
- Game: the original three-stage, 180-second board (tap/arrows/space, E deliver, C pouch, X shake).
- Results: server replay verification, rank, and **Pin on Sepolia** (`pinScore`), enabled for a
  server-verified new personal best once the API reports `attestationConfigured`; it simulates the
  call first and shows the decoded revert (`NotHigher`, `Expired`, `AlreadyPinned`, `BadSignature`).
- Leaderboard: the API's per-day board with replay evidence and pin status.
- Contract: live reads (owner, pending owner, signer vs. the API's signer, previous signer and grace
  window, EIP-712 domain, your on-chain best for today, today's config lock). The connected owner
  gets `setSigner`, `replaceSigner`, `revokePreviousSigner`, `clearChallengeConfig`,
  `transferOwnership`; a pending owner gets `acceptOwnership`. `renounceOwnership` is disabled in the
  contract and has no control.

## After publication (backend operator)

The API currently answers browsers without an `Access-Control-Allow-Origin` header for foreign
origins. Add the published gateway/ENS origins (for example the `*.eth.limo` name and the IPFS
gateway subdomain) to the server's `CORS_ORIGINS`, or the hosted page cannot read the API.
