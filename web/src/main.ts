// Squeek Supply Station: the existing ss-2.0.0 game, wired to the real game API and to the
// SqueekSupplyBoard deployment that ./imd-deployment.json describes.
import "./style.css";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { api } from "./api";
import { API_BASE, loadDeployment, type Deployment } from "./config";
import { Chainlink, errorCode, short } from "./chain";
import { ConnectSheet } from "./sheet";
import { Sim, INPUT, RULES_VERSION, MAX_TICKS, W, WEATHER } from "./game/engine.js";
import { practiceConfig } from "./game/challenge.js";
import { Renderer, ballIcon } from "./game/render.js";
import { t, toggleLang, applyI18n } from "./game/i18n.js";
import { sfx } from "./game/audio.js";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const roundLabel = (v: unknown) => String(v).replace(/^(\d+)–\1$/, "$1");
// crypto.randomUUID exists only in secure contexts; a plain-http gateway preview still gets a seed.
const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x" + "0".repeat(64);
const SOUND_ON =
  '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
const SOUND_OFF =
  '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6M22 9l-6 6"/></svg>';

const state: any = {
  view: "lobby",
  challenge: null,
  challengeError: null, // the failed /v1/challenges/today request, kept so a language switch can retranslate it
  address: null as string | null, // signed-in API session address (lowercase)
  sim: null,
  run: null,
  mode: null,
  playing: false,
  starting: false,
  ending: false,
  submitting: false,
  aim: 200,
  inputs: [] as [number, number | undefined][],
  renderer: null,
  result: null,
  payload: null,
  txHash: null,
  apiConfig: null as any,
};
let d: Deployment | null = null;
let chain: Chainlink | null = null;
let deploymentError = "";
let raf = 0,
  lastTime = 0,
  accumulator = 0,
  lastPhase = -1,
  lastQueue = "",
  pinTimer: any = null;

const text = (id: string, value: unknown) => {
  const el = $(id);
  if (el && el.textContent !== String(value)) el.textContent = String(value);
};
function toast(message: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}
function errorMessage(e: any) {
  if (e?.status === 401) {
    state.address = null;
    updateWallet();
  }
  const code = e?.code && typeof e.code === "string" && e.status !== undefined ? e.code : errorCode(e);
  const msg = t(code);
  return msg === code && code.startsWith("revert:") ? code.slice(7) : msg;
}
function show(view: string) {
  state.view = view;
  document.body.dataset.view = view;
  for (const id of ["lobby", "gameView", "boardView", "contractView"]) $("#" + id).hidden = id !== view;
  for (const [btn, v] of [["#lobbyBtn", "lobby"], ["#boardBtn", "boardView"], ["#contractBtn", "contractView"]])
    $(btn).setAttribute("aria-current", v === view || (v === "lobby" && view === "gameView") ? "page" : "false");
  window.scrollTo({ top: 0 });
}

// ---------- wallet + API session ----------
const sheet = new ConnectSheet(
  () => chain?.connectors ?? [],
  async (connector) => {
    if (!chain) throw new Error("deployment_missing");
    try {
      await chain.connect(connector);
    } catch (e) {
      throw new Error(errorCode(e) === "user_rejected" ? "user_rejected" : "connect_failed");
    }
    await signIn();
  },
);
function updateWallet() {
  const btn = $("#walletBtn");
  const a = chain?.state.address;
  btn.textContent = a ? short(a) + " · " + t("disconnect") : t("connect");
  btn.title = a ?? "";
  text("#entryHint", state.address ? t("ranked") : t("anonymousHint"));
  const wrong = !!a && !!chain && !chain.onRightChain;
  $("#chainBanner").hidden = !wrong;
  text("#switchBtn", t("switchTo") + " " + (d?.network.name ?? "Sepolia"));
  renderOwnerPanel();
}
/** Sign the API's login message with the connected wallet (needed before a ranked run). */
async function signIn() {
  if (!chain?.state.address) return false;
  try {
    await chain.ensureChain();
    const address = chain.state.address;
    const result = await api.login(address, (m) => chain!.sign(m));
    if (chain.state.address?.toLowerCase() !== result.address) throw new Error("sessionChanged");
    state.address = result.address;
    updateWallet();
    refreshChain();
    return true;
  } catch (e) {
    api.logout();
    state.address = null;
    updateWallet();
    toast(errorMessage(e));
    return false;
  }
}
async function connect() {
  if (!chain) {
    toast(t(deploymentError || "deployment_missing"));
    return false;
  }
  if (chain.state.address) return signIn();
  sheet.open();
  return false;
}
$("#walletBtn").onclick = async () => {
  if (chain?.state.address) {
    api.logout();
    state.address = null;
    await chain.disconnect();
    updateWallet();
    renderPlayerFacts();
  } else connect();
};
$("#switchBtn").onclick = async () => {
  try {
    await chain?.ensureChain();
  } catch (e) {
    toast(errorMessage(e));
  }
};

// ---------- lobby ----------
function renderChallenge() {
  const c = state.challenge;
  if (!c) {
    text("#challengeDate", "");
    $("#phaseCards").innerHTML = "";
    text("#challengeStatus", state.challengeError ? t("unavailable") + " " + errorMessage(state.challengeError) : t("loading"));
    return;
  }
  text("#challengeDate", c.day + " UTC");
  text("#challengeStatus", t("frozen"));
  const explorer = d?.network.explorer ?? "https://sepolia.etherscan.io";
  $("#phaseCards").innerHTML = c.config.phases
    .map(
      (p: any, i: number) =>
        `<article class="phase-card"><span class="hint">${t("phase")} ${i + 1} · ${t(p.weather)}</span><b>L${p.targetLevel} × ${p.quota}</b><p>${t("rounds")} ${esc(roundLabel(p.roundLabel))} · ${p.reward} / ${t("quota")}</p><a href="${esc(explorer)}/tx/${esc(c.source.records[i].transactionHash)}" target="_blank" rel="noopener">${t("viewTx")}</a></article>`,
    )
    .join("");
  $("#sourceBody").innerHTML =
    `<p>UTC ${esc(c.publishedAt)} · ${esc(c.config.rulesVersion)} · ${t("bonus")}</p><p>Config: <code>${esc(c.configHash)}</code></p><ul>${c.source.records.map((r: any) => `<li>${t("rounds")} ${esc(r.afterRound)} → ${esc(r.throughRound)} · work ${esc(r.workAdded)} · blocks ${esc(r.completedBlocks)} · ${esc(r.settledAt)}</li>`).join("")}</ul><a href="${api.base}/v1/challenges/${esc(c.challengeId)}" target="_blank" rel="noopener">JSON ↗</a>`;
}
async function loadChallenge() {
  $<HTMLButtonElement>("#dailyBtn").disabled = true;
  $("#retryChallenge").hidden = true;
  state.challengeError = null;
  text("#challengeStatus", t("loading"));
  try {
    const challenge = await api.request("/v1/challenges/today", { publicRead: true });
    if (challenge.config.rulesVersion !== RULES_VERSION) throw new Error("rules_version_mismatch");
    state.challenge = challenge;
    renderChallenge();
    $<HTMLButtonElement>("#dailyBtn").disabled = false;
    $<HTMLInputElement>("#boardDate").value = state.challenge.day;
    $<HTMLInputElement>("#challengeInput").value ||= state.challenge.challengeId;
    renderPlayerFacts();
  } catch (e) {
    state.challenge = null;
    state.challengeError = e;
    renderChallenge();
    $("#retryChallenge").hidden = false;
  }
}
$("#retryChallenge").onclick = loadChallenge;

// ---------- game loop (unchanged ss-2.0.0 mechanics) ----------
async function start(mode: "daily" | "free") {
  if (state.starting || state.playing || state.submitting) return;
  state.starting = true;
  $<HTMLButtonElement>("#dailyBtn").disabled = true;
  $<HTMLButtonElement>("#practiceBtn").disabled = true;
  sfx.unlock();
  try {
    let config,
      run: any = null;
    if (mode === "daily") {
      if (!state.challenge) throw new Error("unavailable");
      run = await api.request("/v1/runs", {
        method: "POST",
        body: { mode, challengeId: state.challenge.challengeId, clientRulesVersion: RULES_VERSION },
      });
      config = run.challenge.config;
      run.address = state.address;
    } else config = practiceConfig("practice:" + randomId());
    state.mode = mode;
    state.run = run;
    state.result = null;
    state.payload = null;
    state.txHash = null;
    state.sim = new Sim(config);
    state.inputs = [];
    state.aim = W / 2;
    state.ending = false;
    state.playing = true;
    sessionStorage.removeItem("ss.pending");
    clearInterval(pinTimer);
    $<HTMLDialogElement>("#resultDialog").close();
    show("gameView");
    state.renderer = new Renderer($("#game"));
    lastPhase = -1;
    lastQueue = "";
    updateHUD();
    renderQueue();
    text("#runMode", t(mode === "daily" ? "today" : "practice"));
    text("#rankedLabel", t(mode === "free" ? "practiceHint" : run.ranked ? "ranked" : "unranked"));
    $("#game").focus({ preventScroll: true });
    lastTime = performance.now();
    accumulator = 0;
    raf = requestAnimationFrame(frame);
  } catch (e: any) {
    toast(errorMessage(e));
    if (e.code === "challenge_changed") await loadChallenge();
  } finally {
    state.starting = false;
    $<HTMLButtonElement>("#dailyBtn").disabled = !state.challenge;
    $<HTMLButtonElement>("#practiceBtn").disabled = false;
  }
}
$("#dailyBtn").onclick = () => start("daily");
$("#practiceBtn").onclick = () => start("free");
function frame(now: number) {
  if (!state.playing) return;
  const sim = state.sim;
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  accumulator += dt;
  let steps = 0;
  while (accumulator >= 1 / 60 && steps < 6 && !sim.over) {
    for (const [code, x] of state.inputs.splice(0)) sim.apply(code, x);
    sim.step();
    accumulator -= 1 / 60;
    steps++;
    state.renderer.onEvents(sim.events);
    for (const event of sim.events) {
      if (event.t === "drop") sfx.drop();
      else if (event.t === "merge" || event.t === "delivery") sfx.merge(event.lv);
      else if (event.t === "block") sfx.block();
      else if (event.t === "shake") sfx.shake();
      else if (event.t === "swap") sfx.swap();
    }
    sim.events.length = 0;
  }
  state.renderer.draw(sim, state.aim, dt, true);
  updateHUD();
  renderQueue();
  if (sim.over) {
    finish();
    return;
  }
  raf = requestAnimationFrame(frame);
}
document.addEventListener("visibilitychange", () => {
  lastTime = performance.now();
  accumulator = 0;
});
function updateHUD() {
  const s = state.sim;
  if (!s) return;
  const p = s.phase;
  text("#score", s.score.toLocaleString());
  text("#delivered", s.deliveries);
  const seconds = Math.ceil((MAX_TICKS - s.tick) / 60);
  text("#time", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
  text("#shakes", s.shakes);
  $("#energyBar").style.width = s.blockBar / 1e7 + "%";
  text("#fever", s.fever > 0 ? "Fever ×2" : "");
  $<HTMLButtonElement>("#deliverBtn").disabled = !s.deliveryCandidate || !state.playing;
  $<HTMLButtonElement>("#pouchBtn").disabled = s.swapLocked;
  $<HTMLButtonElement>("#shakeBtn").disabled = !s.shakes || !s.balls.length;
  text("#phaseTitle", `${t("phase")} ${s.phaseIndex + 1}/3 · ${t(p.weather)} · ${Math.ceil((p.endTick - s.tick) / 60)}s`);
  text("#missionTitle", `${t("quota")} L${p.targetLevel}`);
  text("#missionProgress", `${s.phaseDelivered[s.phaseIndex]} / ${p.quota} · ${t("quota")}`);
  text("#missionReward", `${p.reward} / ${t("quota")} · ${t("bonus")}`);
  text(
    "#deliveryHint",
    t(s.phaseDelivered[s.phaseIndex] >= p.quota ? "missionDone" : s.deliveryCandidate ? "ready" : "waiting"),
  );
  const next = s.cfg.phases[s.phaseIndex + 1];
  text("#nextMission", next ? `${t("nextStage")}: ${t(next.weather)} · L${next.targetLevel} × ${next.quota}` : t("lastStage"));
  if (lastPhase !== s.phaseIndex) {
    lastPhase = s.phaseIndex;
    $("#journey").innerHTML = s.cfg.phases
      .map(
        (phase: any, i: number) =>
          `<li class="${i === s.phaseIndex ? "active" : ""}"><b>${i + 1}. ${t(phase.weather)} · L${phase.targetLevel} × ${phase.quota}</b><span>${t("rounds")} ${esc(roundLabel(phase.roundLabel))}</span></li>`,
      )
      .join("");
  }
}
function renderQueue() {
  const s = state.sim;
  if (!s) return;
  const n = 1 + WEATHER[s.phase.weather].preview;
  const key = s.queue.slice(0, n).join(",") + ":" + s.pouch;
  if (key === lastQueue) return;
  lastQueue = key;
  $("#queue").innerHTML = "";
  s.queue.slice(0, n).forEach((lv: number) => {
    const c = document.createElement("canvas");
    c.setAttribute("aria-label", "L" + lv);
    $("#queue").append(c);
    ballIcon(c, lv, 48);
  });
  ballIcon($("#pouchIcon"), s.pouch < 0 ? 1 : s.pouch, 38);
  $("#pouchIcon").style.opacity = s.pouch < 0 ? "0.25" : "1";
}
function input(code: number) {
  if (!state.playing || state.inputs.some((a: any) => a[0] === code)) return;
  state.inputs.push([code, code === INPUT.DROP ? Math.round(Math.max(0, Math.min(W, state.aim))) : undefined]);
}
let pointer = false;
const canvas = $<HTMLCanvasElement>("#game");
canvas.onpointerdown = (e) => {
  if (!state.playing) return;
  pointer = true;
  canvas.setPointerCapture(e.pointerId);
  state.aim = state.renderer.toWorldX(e.clientX);
};
canvas.onpointermove = (e) => {
  if (state.renderer) state.aim = state.renderer.toWorldX(e.clientX);
};
canvas.onpointerup = (e) => {
  if (pointer) {
    pointer = false;
    state.aim = state.renderer.toWorldX(e.clientX);
    input(INPUT.DROP);
  }
};
canvas.onpointercancel = () => {
  pointer = false;
};
document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (!state.playing || document.querySelector("dialog[open]") || /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
  const key = e.key.toLowerCase();
  if (key === "arrowleft" || key === "a") {
    state.aim = Math.max(0, state.aim - 16);
    e.preventDefault();
  } else if (key === "arrowright" || key === "d") {
    state.aim = Math.min(W, state.aim + 16);
    e.preventDefault();
  } else if (key === " " && target.tagName !== "BUTTON") {
    input(INPUT.DROP);
    e.preventDefault();
  } else if (key === "e") {
    input(INPUT.DELIVER);
    e.preventDefault();
  } else if (key === "c") {
    input(INPUT.SWAP);
    e.preventDefault();
  } else if (key === "x") {
    input(INPUT.SHAKE);
    e.preventDefault();
  }
});
$("#deliverBtn").onclick = () => input(INPUT.DELIVER);
$("#pouchBtn").onclick = () => input(INPUT.SWAP);
$("#shakeBtn").onclick = () => input(INPUT.SHAKE);
window.addEventListener("resize", () => state.renderer?.resize());

// ---------- results, replay verification, pinScore ----------
function savePending() {
  if (state.run)
    sessionStorage.setItem(
      "ss.pending",
      JSON.stringify({ run: state.run, mode: state.mode, payload: state.payload, result: state.result, txHash: state.txHash }),
    );
}
async function finish() {
  if (state.ending) return;
  state.ending = true;
  state.playing = false;
  cancelAnimationFrame(raf);
  state.payload = { inputs: state.sim.inputs, endTick: state.sim.tick, clientSummary: state.sim.summary() };
  savePending();
  showResult();
  if (state.run) await submit();
}
function showResult() {
  const s = state.payload.clientSummary;
  text("#resultScore", s.score.toLocaleString());
  text(
    "#resultStats",
    `${t("delivered")} ${s.deliveries} · ${t("missions")} ${s.completedMissions}/3 · ${s.maxLevel ? "L" + s.maxLevel : "L0"}`,
  );
  text("#resultRank", "");
  text("#chainStatus", "");
  $("#txLink").hidden = true;
  $("#pinBtn").hidden = true;
  $<HTMLButtonElement>("#pinBtn").disabled = false;
  $("#retryFinish").hidden = true;
  text("#resultStatus", t(state.run ? "verifying" : "localComplete"));
  $("#resultStatus").className = "";
  $("#resultConnect").hidden = !state.run?.ranked || state.address === state.run?.address;
  const dlg = $<HTMLDialogElement>("#resultDialog");
  if (!dlg.open) dlg.showModal();
  if (state.result) renderResult();
}
async function submit() {
  if (state.submitting) return;
  state.submitting = true;
  $<HTMLButtonElement>("#againBtn").disabled = true;
  $("#retryFinish").hidden = true;
  text("#resultStatus", t("verifying"));
  try {
    state.result = await api.request(`/v1/runs/${state.run.runId}/finish`, {
      method: "POST",
      body: state.payload,
      runToken: state.run.runToken,
      publicRead: !state.run.ranked,
    });
    savePending();
    renderResult();
  } catch (e) {
    text("#resultStatus", errorMessage(e));
    $("#resultStatus").className = "bad";
    $("#retryFinish").hidden = false;
    $("#resultConnect").hidden = !state.run.ranked;
  } finally {
    state.submitting = false;
    $<HTMLButtonElement>("#againBtn").disabled = false;
  }
}
/** Why pinning is unavailable right now, or "" when the pin control may be used. */
export function pinBlocker(): string {
  if (!d || !chain) return deploymentError || "deployment_missing";
  if (!chain.codeVerified) return "contract_unverified";
  const cfg = state.apiConfig;
  if (cfg?.contracts?.board && cfg.contracts.board.toLowerCase() !== d.board.address.toLowerCase()) return "boardMismatch";
  if (!cfg?.attestationConfigured) return "pinDisabledApi";
  return "";
}
function renderResult() {
  const r = state.result;
  if (!r) return;
  text("#resultStatus", r.status === "verified" ? t("verified") : `${t("rejected")} · ${r.reason}`);
  $("#resultStatus").className = r.status === "verified" ? "ok" : "bad";
  text("#resultRank", r.ranked ? (r.rank ? `${t("rank")} #${r.rank}` : "") : t("anonResult"));
  const eligible = r.status === "verified" && r.ranked && r.isNewBest && r.summary.score > 0;
  const blocker = pinBlocker();
  // The pin control is always shown for a ranked verified run, disabled with its reason when unavailable.
  $("#pinBtn").hidden = !(r.status === "verified" && r.ranked);
  $<HTMLButtonElement>("#pinBtn").disabled = !eligible || !!blocker || !!state.txHash;
  if (r.ranked && r.status === "verified") text("#chainStatus", blocker ? t(blocker) : eligible ? "" : t("pinNotBest"));
  if (state.txHash) {
    showTx();
    pollPin();
    clearInterval(pinTimer);
    pinTimer = setInterval(pollPin, 15000);
  }
}
function showTx() {
  text("#chainStatus", t("pending"));
  $<HTMLButtonElement>("#pinBtn").disabled = true;
  const link = $<HTMLAnchorElement>("#txLink");
  link.hidden = false;
  link.href = chain ? chain.explorer("tx", state.txHash) : "#";
}
async function pollPin() {
  if (!state.txHash || !state.run || !api.token) return;
  try {
    const result = await api.request(`/v1/runs/${state.run.runId}/pin`, { method: "POST", body: { txHash: state.txHash } });
    text("#chainStatus", t(result.status === "confirmed" ? "confirmed" : "pending"));
    if (result.status === "confirmed") {
      clearInterval(pinTimer);
      refreshChain();
    }
  } catch (e: any) {
    text("#chainStatus", errorMessage(e));
    if (e.code === "invalid_pin_transaction") {
      clearInterval(pinTimer);
      state.txHash = null;
      savePending();
      $<HTMLButtonElement>("#pinBtn").disabled = false;
    }
  }
}
$("#pinBtn").onclick = async () => {
  if (!chain || !state.address || state.address !== state.run.address) {
    toast(t("loginFirst"));
    return;
  }
  const blocker = pinBlocker();
  if (blocker) {
    text("#chainStatus", t(blocker));
    return;
  }
  $<HTMLButtonElement>("#pinBtn").disabled = true;
  try {
    await chain.ensureChain();
    if (chain.state.address?.toLowerCase() !== state.run.address) throw new Error("loginFirst");
    const att = await api.request(`/v1/runs/${state.run.runId}/attestation`, { method: "POST" });
    text("#chainStatus", t("loading"));
    state.txHash = await chain.write("pinScore", [
      att.runId as Hex,
      att.challengeId as Hex,
      att.configHash as Hex,
      BigInt(att.score),
      Number(att.deliveries),
      BigInt(att.deadline),
      att.signature as Hex,
    ]);
    savePending();
    showTx();
    await pollPin();
    clearInterval(pinTimer);
    pinTimer = setInterval(pollPin, 15000);
  } catch (e) {
    text("#chainStatus", errorMessage(e));
    $<HTMLButtonElement>("#pinBtn").disabled = false;
  }
};
$("#quitBtn").onclick = finish;
$("#retryFinish").onclick = submit;
$("#resultConnect").onclick = async () => {
  if (await connect()) {
    $("#resultConnect").hidden = state.address === state.run?.address;
    if (!state.result && state.address === state.run?.address) await submit();
  }
};
$("#againBtn").onclick = () => {
  const mode = state.mode;
  $<HTMLDialogElement>("#resultDialog").close();
  start(mode);
};
$("#resultHome").onclick = () => {
  $<HTMLDialogElement>("#resultDialog").close();
  show("lobby");
};

// ---------- navigation + leaderboard ----------
async function navigate(view: string) {
  if (state.playing) {
    await finish();
    return;
  }
  show(view);
  if (view === "boardView") loadBoard();
  if (view === "contractView") refreshChain();
}
$("#homeBtn").onclick = () => navigate("lobby");
$("#lobbyBtn").onclick = () => navigate("lobby");
$("#boardBtn").onclick = () => navigate("boardView");
$("#contractBtn").onclick = () => navigate("contractView");
let boardRequest = 0;
async function loadBoard() {
  const request = ++boardRequest;
  $("#boardBody").innerHTML = `<tr><td class="empty" colspan="5">${t("loading")}</td></tr>`;
  try {
    const date = $<HTMLInputElement>("#boardDate").value || "today";
    const r = await api.request("/v1/leaderboards/" + encodeURIComponent(date));
    if (request !== boardRequest) return;
    $("#boardBody").innerHTML = r.entries.length
      ? r.entries
          .map(
            (e: any) =>
              `<tr class="${e.you ? "you" : ""}"><td>${Number(e.rank)}</td><td title="${esc(e.address)}">${e.you ? t("you") + " · " : ""}${esc(short(e.address))}</td><td>${Number(e.score).toLocaleString()}</td><td>${Number(e.deliveries)}</td><td><a href="${api.base}/v1/proofs/${esc(e.runId)}" target="_blank" rel="noopener">${t("replay")}</a><small>${t(e.pinned ? "confirmed" : e.pinStatus === "pending" ? "pending" : "notPinned")}</small></td></tr>`,
          )
          .join("")
      : `<tr><td class="empty" colspan="5">${t("empty")}</td></tr>`;
  } catch (e) {
    if (request === boardRequest) $("#boardBody").innerHTML = `<tr><td class="empty" colspan="5">${esc(errorMessage(e))}</td></tr>`;
  }
}
$("#refreshBoard").onclick = loadBoard;
$("#boardDate").onchange = loadBoard;

// ---------- live contract state ----------
const fact = (label: string, value: string, href?: string) =>
  `<div><dt>${esc(label)}</dt><dd>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener"><code>${esc(value)}</code></a>` : value}</dd></div>`;
const addrFact = (label: string, a?: string | null) =>
  !a || a === ZERO ? fact(label, esc(t("none"))) : fact(label, a, chain!.explorer("address", a));
const chainView: any = { facts: null, player: null };
let chainRequest = 0;
async function refreshChain() {
  const request = ++chainRequest;
  if (!chain || !d) {
    $("#contractFacts").innerHTML = "";
    text("#codeStatus", t(deploymentError || "deployment_missing"));
    return;
  }
  text("#codeStatus", t("loading"));
  try {
    const ok = await chain.verifyCode();
    const [owner, pendingOwner, signer, previousSigner, validUntil, grace, domain] = await Promise.all([
      chain.read<Address>("owner"),
      chain.read<Address>("pendingOwner"),
      chain.read<Address>("signer"),
      chain.read<Address>("previousSigner"),
      chain.read<bigint>("previousSignerValidUntil"),
      chain.read<bigint>("SIGNER_GRACE_PERIOD"),
      chain.read<any[]>("eip712Domain"),
    ]);
    if (request !== chainRequest) return;
    chainView.facts = { owner, pendingOwner, signer, previousSigner, validUntil, grace, domain };
    const apiSigner = state.apiConfig?.signer as string | undefined;
    const until = Number(validUntil);
    $("#contractFacts").innerHTML = [
      fact(t("address"), d.board.address, chain.explorer("address", d.board.address)),
      fact("Chain", `${esc(d.network.name)} (${d.manifest.chainId})`),
      addrFact(t("owner"), owner),
      addrFact(t("pendingOwner"), pendingOwner),
      addrFact(t("signer"), signer),
      apiSigner
        ? fact(
            t("apiSigner"),
            `<code>${esc(short(apiSigner))}</code> · <span class="${apiSigner.toLowerCase() === signer.toLowerCase() ? "ok" : "bad"}">${t(apiSigner.toLowerCase() === signer.toLowerCase() ? "signerMatch" : "signerDiffer")}</span>`,
          )
        : "",
      addrFact(t("previousSigner"), previousSigner),
      until ? fact(t("validUntil"), esc(new Date(until * 1000).toISOString().replace(".000", ""))) : "",
      fact(t("grace"), esc(Number(grace) / 3600 + " h")),
      fact(t("domain"), esc(`${domain[1]} v${domain[2]}`)),
    ].join("");
    text("#codeStatus", t(ok ? "codeOk" : "codeMissing"));
    $("#codeStatus").className = "hint " + (ok ? "ok" : "bad");
  } catch (e) {
    text("#codeStatus", errorMessage(e));
    $("#codeStatus").className = "hint bad";
  }
  await renderPlayerFacts();
  renderOwnerPanel();
  if (state.result) renderResult();
}
async function renderPlayerFacts() {
  const a = chain?.state.address;
  const c = state.challenge;
  $("#playerHint").hidden = !!a;
  if (!chain || !a || !c) {
    $("#playerFacts").innerHTML = "";
    return;
  }
  try {
    const [[score, runId], lock] = await Promise.all([
      chain.read<[bigint, Hex]>("best", [c.challengeId, a]),
      chain.read<Hex>("challengeConfig", [c.challengeId]),
    ]);
    const lockState = lock === ZERO32 ? "lockNone" : lock.toLowerCase() === c.configHash.toLowerCase() ? "lockMatches" : "lockDiffers";
    $("#playerFacts").innerHTML = [
      fact(t("player"), a, chain.explorer("address", a)),
      fact(t("chainBest"), `<b>${Number(score).toLocaleString()}</b>${runId !== ZERO32 ? ` · <code>${esc(short(runId))}</code>` : ""}`),
      fact(t("lockedConfig"), `<span class="${lockState === "lockDiffers" ? "bad" : ""}">${t(lockState)}</span>`),
    ].join("");
  } catch (e) {
    $("#playerFacts").innerHTML = fact(t("chainBest"), esc(errorMessage(e)));
  }
}
function renderOwnerPanel() {
  const a = chain?.state.address?.toLowerCase();
  const f = chainView.facts;
  const isOwner = !!a && !!f && f.owner.toLowerCase() === a;
  const isPending = !!a && !!f && f.pendingOwner.toLowerCase() === a;
  $("#ownerControls").hidden = !isOwner;
  $("#acceptControls").hidden = !isPending;
  $("#ownerHint").hidden = isOwner || isPending;
  const disabled = !chain?.codeVerified || !chain?.onRightChain;
  document.querySelectorAll<HTMLButtonElement>("[data-tx]").forEach((b) => (b.disabled = disabled || b.dataset.busy === "1"));
}
const bytes32 = (v: string) => /^0x[0-9a-fA-F]{64}$/.test(v);
document.querySelectorAll<HTMLButtonElement>("[data-tx]").forEach((btn) => {
  btn.onclick = async () => {
    if (!chain) return;
    const fn = btn.dataset.tx!;
    let args: unknown[] = [];
    const val = (id: string) => $<HTMLInputElement>(id).value.trim();
    if (fn === "setSigner" || fn === "replaceSigner" || fn === "transferOwnership") {
      const v = val(fn === "transferOwnership" ? "#ownerInput" : "#signerInput");
      if (!isAddress(v) || v.toLowerCase() === ZERO) return text("#ownerStatus", t("invalidAddress"));
      args = [getAddress(v)];
    } else if (fn === "clearChallengeConfig") {
      const v = val("#challengeInput");
      if (!bytes32(v)) return text("#ownerStatus", t("invalidBytes32"));
      args = [v];
    }
    btn.dataset.busy = "1";
    btn.disabled = true;
    $("#ownerTx").hidden = true;
    text("#ownerStatus", t("loading"));
    try {
      const hash = await chain.write(fn, args);
      text("#ownerStatus", t("txSent"));
      const link = $<HTMLAnchorElement>("#ownerTx");
      link.href = chain.explorer("tx", hash);
      link.hidden = false;
      await chain.wait(hash);
      text("#ownerStatus", t("txConfirmed"));
      await refreshChain();
    } catch (e) {
      text("#ownerStatus", errorMessage(e));
    } finally {
      btn.dataset.busy = "";
      renderOwnerPanel();
    }
  };
});
$("#refreshChain").onclick = refreshChain;

// ---------- chrome ----------
$("#helpBtn").onclick = () => {
  $("#helpBody").innerHTML = t("helpContent");
  $<HTMLDialogElement>("#helpDialog").showModal();
};
$("#closeHelp").onclick = () => $<HTMLDialogElement>("#helpDialog").close();
function renderMute() {
  $("#muteBtn").innerHTML = sfx.muted ? SOUND_OFF : SOUND_ON;
  $("#muteBtn").setAttribute("aria-label", t(sfx.muted ? "soundOn" : "soundOff"));
}
$("#muteBtn").onclick = () => {
  sfx.unlock();
  sfx.toggle();
  renderMute();
};
$("#langBtn").onclick = () => {
  toggleLang();
  updateWallet();
  renderChallenge();
  renderMute();
  lastPhase = -1;
  updateHUD();
  $("#helpBody").innerHTML = t("helpContent");
  if (state.mode) {
    text("#runMode", t(state.mode === "daily" ? "today" : "practice"));
    text("#rankedLabel", t(state.mode === "free" ? "practiceHint" : state.run?.ranked ? "ranked" : "unranked"));
  }
  if (state.view === "boardView") loadBoard();
  if (state.view === "contractView") refreshChain();
  if (state.payload && $<HTMLDialogElement>("#resultDialog").open) showResult();
};
applyI18n();
renderMute();
ballIcon($("#brandIcon"), 2, 34);
const apiLink = $<HTMLAnchorElement>("#apiLink");
apiLink.href = API_BASE + "/v1/config";
show("lobby");
updateWallet();

async function boot() {
  try {
    d = await loadDeployment();
    chain = new Chainlink(d);
    chain.onChange((s) => {
      if (state.address && (s.address?.toLowerCase() !== state.address || s.chainId !== d!.manifest.chainId)) {
        api.logout();
        state.address = null;
        toast(t("sessionChanged"));
      }
      updateWallet();
      renderPlayerFacts();
    });
    chain.onConnectors(() => sheet.isOpen && sheet.open());
  } catch (e: any) {
    deploymentError = e?.message ?? "deployment_missing";
    toast(t(deploymentError));
  }
  const [cfg] = await Promise.allSettled([
    api.request("/v1/config", { publicRead: true }),
    chain?.verifyCode().catch(() => false),
  ]);
  if (cfg.status === "fulfilled") state.apiConfig = cfg.value;
  else toast(errorMessage(cfg.reason));
  if (chain) {
    const s = await chain.reconnect();
    if (api.token && s.address) {
      try {
        const me = await api.request("/v1/me");
        if (s.address.toLowerCase() === me.address) state.address = me.address;
        else api.logout();
      } catch {
        api.logout();
      }
    } else if (api.token) api.logout();
  } else if (api.token) api.logout();
  updateWallet();
  await loadChallenge();
  refreshChain();
  try {
    const pending = JSON.parse(sessionStorage.getItem("ss.pending") || "null");
    if (pending?.run && pending.payload) {
      Object.assign(state, pending);
      state.ending = true;
      showResult();
      if (!state.result) text("#resultStatus", t("restored"));
      $("#retryFinish").hidden = !!state.result;
    }
  } catch {
    sessionStorage.removeItem("ss.pending");
  }
}
boot();
