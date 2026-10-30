// Writes dist/imd-deployment.json after the static export: identifiers, contracts and poolKey
// copied from the deployment handoff, network/walletAddChain copied from network.json, and the
// SHA-256 of every other exported file. Run after `vite build`.
//   HANDOFF=path/to/deployment.json NETWORK=path/to/network.json node scripts/write-manifest.mjs
// Defaults: ../.imd/reads/{deployment,network}.json when present, else web/deployment/*.json.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";

const web = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(web, "../dist");
const pick = (env, a, b) => process.env[env] || (existsSync(a) ? a : b);
const handoffPath = pick("HANDOFF", resolve(web, "../.imd/reads/deployment.json"), resolve(web, "deployment/deployment.json"));
const networkPath = pick("NETWORK", resolve(web, "../.imd/reads/network.json"), resolve(web, "deployment/network.json"));
const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
const networkFile = existsSync(networkPath) ? JSON.parse(readFileSync(networkPath, "utf8")) : null;

export const canonical = (v) =>
  Array.isArray(v)
    ? "[" + v.map(canonical).join(",") + "]"
    : v && typeof v === "object"
      ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"
      : JSON.stringify(v);

const contracts = handoff.contracts.map((c) => {
  const abiPath = `abi/${c.name}.json`;
  const abi = JSON.parse(readFileSync(join(dist, abiPath), "utf8"));
  const hash = keccak256(toBytes(canonical(abi))).slice(2);
  if (hash !== c.abiHash) throw new Error(`${c.name}: ABI hash ${hash} != handoff ${c.abiHash}`);
  return { name: c.name, address: c.address, abiHash: c.abiHash, abiPath };
});

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(dist, p).split(sep).join("/"));
  }
};
walk(dist);
const assets = files
  .filter((f) => f !== "imd-deployment.json")
  .map((path) => {
    const bytes = readFileSync(join(dist, path));
    if (bytes.length > 8 * 1024 * 1024) throw new Error(`${path} exceeds 8 MiB`);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
if (assets.length > 128) throw new Error(`too many assets: ${assets.length}`);
if (!assets.some((a) => a.path === "index.html")) throw new Error("index.html missing from export");

const manifest = {
  version: 1,
  launchId: handoff.launchId,
  chainId: handoff.chainId,
  sourceCommit: handoff.sourceCommit,
  attestationHash: handoff.attestationHash,
  contracts,
  assets,
};
if (handoff.poolKey) manifest.poolKey = handoff.poolKey;
if (networkFile?.network) manifest.network = networkFile.network;
if (networkFile?.walletAddChain) manifest.walletAddChain = networkFile.walletAddChain;
writeFileSync(join(dist, "imd-deployment.json"), JSON.stringify(manifest, null, 2) + "\n");
const total = assets.reduce((n, a) => n + statSync(join(dist, a.path)).size, 0);
console.log(`imd-deployment.json: ${assets.length} assets, ${total} bytes`);
