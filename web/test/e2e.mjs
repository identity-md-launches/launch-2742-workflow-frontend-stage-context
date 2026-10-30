// Browser interaction check of the built export (../dist). Serves dist from disk at http://site.test,
// injects a scripted EIP-6963 wallet, and passes game-API GETs and Sepolia RPC through to the real
// services (adding a CORS header only for this test origin). Auth, run creation and run finishing
// are answered by the test. Run with NODE_USE_ENV_PROXY=1 behind a proxy, because they need a real wallet signature and a played run.
//   IMD_PLAYWRIGHT=.../playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=... node test/e2e.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.IMD_PLAYWRIGHT || "playwright");
const dist = resolve(fileURLToPath(new URL("../../dist", import.meta.url)));
const API = "https://api.btc-psbt.fun:9443";
const network = JSON.parse(readFileSync(join(dist, "imd-deployment.json"), "utf8"));
const ACCOUNT = "0x51404e4a699e4e338e143fb2a45c5cdc96392575"; // the board owner, to exercise the owner panel (reads only)
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e?.stack || e?.message || JSON.stringify(e))));
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST" };
let realChallenge = null;
await page.route("http://site.test/**", (route) => {
  let p = decodeURIComponent(new URL(route.request().url()).pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = join(dist, p);
  if (!f.startsWith(dist) || !existsSync(f)) return route.fulfill({ status: 404, body: "" });
  route.fulfill({ status: 200, body: readFileSync(f), contentType: types[extname(f)] || "application/octet-stream" });
});
await page.route(API + "/**", async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const json = (body, status = 200) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (path === "/v1/auth/nonce") return json({ message: "test login message" });
  if (path === "/v1/auth/verify") return json({ token: "test-token", address: ACCOUNT });
  if (path === "/v1/me") return json({ address: ACCOUNT });
  if (path === "/v1/runs" && req.method() === "POST")
    return json({ runId: "0x" + "11".repeat(32), runToken: "t", ranked: true, challenge: realChallenge });
  if (/\/v1\/runs\/.*\/finish$/.test(path)) {
    const body = req.postDataJSON();
    return json({ status: "verified", ranked: true, isNewBest: true, rank: 1, summary: body.clientSummary });
  }
  const res = await fetch(req.url(), { method: req.method(), headers: { "content-type": "application/json" } });
  const body = await res.text();
  if (path === "/v1/challenges/today" && res.ok) realChallenge = JSON.parse(body);
  route.fulfill({ status: res.status, headers: { ...cors, "content-type": "application/json" }, body });
});
// Public Sepolia RPCs from network.json, fetched from Node (the browser in this sandbox has no direct route).
for (const rpc of network.network.rpcUrls)
  await page.route(rpc + "**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await fetch(req.url(), { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
    route.fulfill({ status: res.status, headers: { ...cors, "content-type": "application/json" }, body: await res.text() });
  });
await page.addInitScript(({ account, chainHex }) => {
  const listeners = {};
  const log = (window.__walletLog = []);
  let chainId = "0x1"; // starts on the wrong chain
  let knowsSepolia = false;
  let authorized = false;
  const provider = {
    request: async ({ method, params }) => {
      log.push({ method, params });
      if (method === "eth_requestAccounts") { authorized = true; return [account]; }
      if (method === "eth_accounts") return authorized ? [account] : [];
      if (method === "wallet_revokePermissions") { authorized = false; return null; }
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_switchEthereumChain") {
        if (params[0].chainId === chainHex && !knowsSepolia) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        chainId = params[0].chainId;
        (listeners.chainChanged || []).forEach((f) => f(chainId));
        return null;
      }
      if (method === "wallet_addEthereumChain") { knowsSepolia = true; return null; }
      if (method === "personal_sign") return "0x" + "ab".repeat(65);
      if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
      throw Object.assign(new Error("unsupported " + method), { code: 4200 });
    },
    on: (e, f) => ((listeners[e] ||= []).push(f), provider),
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); return provider; },
  };
  window.__setChain = (c) => { chainId = c; (listeners.chainChanged || []).forEach((f) => f(c)); };
  const info = { uuid: "0b1c4b4e-5c2d-4c3e-9e1a-000000000001", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><rect width='28' height='28' fill='%23236e58'/></svg>", rdns: "test.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, { account: ACCOUNT, chainHex: network.walletAddChain.chainId });

try {
  await page.goto("http://site.test/index.html");
  await page.waitForSelector("#phaseCards .phase-card", { timeout: 30000 });
  check("daily challenge loads from the real API", (await page.locator("#phaseCards .phase-card").count()) === 3);
  const first = await page.evaluate(() => ["#dailyBtn", "#walletBtn", "h1"].map((s) => document.querySelector(s).getBoundingClientRect().bottom));
  check("main action, wallet control and headline on the first 390x844 screen", first.every((b) => b < 844), first.join(","));
  check("no horizontal scroll at 390", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // English nav labels are the widest; the last nav button must stay inside the viewport.
  await page.click("#langBtn");
  const navFit = [];
  for (const width of [320, 820]) {
    await page.setViewportSize({ width, height: 844 });
    navFit.push(await page.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth, help: Math.round(document.querySelector("#helpBtn").getBoundingClientRect().right) })));
  }
  check("English nav fits with no horizontal scroll at 320 and 820", navFit.every((m) => m.sw <= m.w && m.help <= m.w), JSON.stringify(navFit));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#langBtn");

  await page.click("#practiceBtn");
  await page.waitForSelector("#gameView:not([hidden])");
  const box = await page.locator("#game").boundingBox();
  for (let i = 0; i < 3; i++) { await page.mouse.click(box.x + box.width * (0.3 + i * 0.2), box.y + 40); await page.waitForTimeout(400); }
  await page.click("#quitBtn");
  await page.waitForSelector("#resultDialog[open]");
  check("practice run plays and finishes locally", /practice|练习/i.test(await page.textContent("#resultStatus")), await page.textContent("#resultStats"));
  await page.click("#resultHome");

  await page.click("#walletBtn");
  await page.waitForTimeout(500);
  const rows = await page.locator(".sheet .row").allTextContents();
  if (!rows.length) console.log("debug wallet:", await page.textContent("#walletBtn"), await page.evaluate(() => JSON.stringify(window.__walletLog)), "toasts:", await page.textContent("#toasts"), "sheet:", await page.locator(".sheet").count(), errors.join("|"));
  check("connect sheet lists the EIP-6963 wallet and Coinbase, no 'Injected'", rows.some((r) => r.includes("Test Wallet")) && rows.some((r) => /Coinbase/.test(r)) && !rows.some((r) => /Injected/.test(r)), rows.join(" | "));
  await page.locator(".sheet .row", { hasText: "Test Wallet" }).click();
  await page.waitForFunction(() => /0x5140/.test(document.querySelector("#walletBtn").textContent), null, { timeout: 15000 });
  // The address shows on connect; sign-in (chain switch, personal_sign, API verify) completes after it.
  await page.waitForFunction(() => /Signed in|已登录/.test(document.querySelector("#entryHint").textContent), null, { timeout: 15000 }).catch(() => {});
  const log =await page.evaluate(() => window.__walletLog.map((x) => x.method));
  const add = await page.evaluate(() => window.__walletLog.find((x) => x.method === "wallet_addEthereumChain")?.params?.[0]);
  check("wrong chain: switch fails with 4902, then wallet_addEthereumChain, then switch", log.includes("wallet_addEthereumChain") && log.lastIndexOf("wallet_switchEthereumChain") > log.indexOf("wallet_addEthereumChain"));
  check("addEthereumChain parameters equal network.json walletAddChain", JSON.stringify(add) === JSON.stringify(network.walletAddChain));
  check("API sign-in with personal_sign", log.includes("personal_sign") && /Signed in|已登录/.test(await page.textContent("#entryHint")));

  await page.click("#contractBtn");
  await page.waitForFunction(() => /0x5140/i.test(document.querySelector("#contractFacts").textContent), null, { timeout: 30000 });
  const facts = await page.textContent("#contractFacts");
  check("live contract reads (owner, signer) from Sepolia RPC", /0x51404e4a/i.test(facts) && /0x2dc8205a/i.test(facts), facts.slice(0, 160));
  await page.waitForFunction(() => /found|找到|No contract|未在/.test(document.querySelector("#codeStatus").textContent), null, { timeout: 30000 }).catch(() => {});
  check("contract code verified on chain", /found|找到/.test(await page.textContent("#codeStatus")));
  await page.waitForFunction(() => document.querySelector("#playerFacts").textContent.length > 0, null, { timeout: 30000 });
  check("connected player's on-chain best is read", /best|最佳/i.test(await page.textContent("#playerFacts")), await page.textContent("#playerFacts"));
  check("owner panel shown to the connected owner", await page.isVisible("#ownerControls"));
  await page.fill("#signerInput", "not-an-address");
  await page.click('[data-tx="setSigner"]');
  check("owner input validation", /valid|有效/.test(await page.textContent("#ownerStatus")));
  check("no horizontal scroll on contract view at 320", await (async () => { await page.setViewportSize({ width: 320, height: 700 }); return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth); })());
  await page.setViewportSize({ width: 390, height: 844 });

  await page.evaluate(() => window.__setChain("0x1"));
  await page.waitForSelector("#chainBanner:not([hidden])");
  check("wrong-chain banner with one switch control", /Sepolia/.test(await page.textContent("#switchBtn")));
  check("transactions disabled on the wrong chain", await page.locator('[data-tx="setSigner"]').isDisabled());
  await page.click("#switchBtn");
  await page.waitForSelector("#chainBanner", { state: "hidden" });
  check("switch control returns the wallet to Sepolia", true);

  await page.click("#boardBtn");
  await page.waitForFunction(() => !/Loading|正在加载/.test(document.querySelector("#boardBody").textContent), null, { timeout: 30000 });
  check("leaderboard loads from the real API", (await page.locator("#boardBody tr").count()) >= 1, (await page.textContent("#boardBody")).slice(0, 120));

  // Re-sign in (the chain change ended the API session), then a ranked daily run.
  await page.click("#lobbyBtn");
  await page.click("#walletBtn"); // connected: disconnects
  await page.click("#walletBtn");
  await page.locator(".sheet .row", { hasText: "Test Wallet" }).click();
  await page.waitForFunction(() => /Signed in|已登录/.test(document.querySelector("#entryHint").textContent), null, { timeout: 15000 });
  await page.click("#dailyBtn");
  await page.waitForSelector("#gameView:not([hidden])");
  await page.mouse.click(box.x + box.width / 2, box.y + 40);
  await page.waitForTimeout(300);
  await page.click("#quitBtn");
  await page.waitForSelector("#pinBtn:not([hidden])", { timeout: 15000 });
  const reason = await page.textContent("#chainStatus");
  check("pin control shown for a verified ranked best, disabled with the API's reason", (await page.locator("#pinBtn").isDisabled()) && reason.length > 0, reason);
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run completed", false, String(e).split("\n")[0] + " :: status=" + (await page.textContent("#challengeStatus").catch(() => "")));
  await page.screenshot({ path: process.env.E2E_SHOT || "/dev/null" }).catch(() => {});
}
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
