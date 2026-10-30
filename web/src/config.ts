// The one configuration point for this site. Addresses, chain, ABIs and public RPCs are NOT
// written here: they are read at runtime from ./imd-deployment.json (the attested deployment
// handoff) so the page can never disagree with what was deployed. Only the game API origin and
// the site's own metadata live in this file. No keys, no private RPC URLs.
import { keccak256, toBytes, type Abi, type Address } from "viem";

export const API_BASE = "https://api.btc-psbt.fun:9443";
export const DEPLOYMENT_URL = "./imd-deployment.json";
export const SITE_NAME = "Squeek Supply Station";
export const SITE_DESCRIPTION =
  "A three-minute merge game built from real Squeekchain settlements, with a verified leaderboard and Sepolia score pinning.";
export const BOARD_CONTRACT = "SqueekSupplyBoard";

export interface NetworkBlock {
  chainId: number;
  name: string;
  testnet: boolean;
  rpcUrls: string[];
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  faucets?: string[];
  uniswapV4?: Record<string, string>;
}
export interface WalletAddChain {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls: string[];
}
export interface DeploymentManifest {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: { name: string; address: Address; abiHash: string; abiPath: string }[];
  assets: { path: string; sha256: string }[];
  network?: NetworkBlock;
  walletAddChain?: WalletAddChain;
}
export interface Deployment {
  manifest: DeploymentManifest;
  network: NetworkBlock;
  walletAddChain: WalletAddChain;
  chainHex: string;
  board: { address: Address; abi: Abi; abiHash: string };
}

/** Keccak over JSON with object keys sorted and no whitespace: the handoff's canonicalKeccak. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value as object)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as any)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const canonicalKeccak = (value: unknown) =>
  keccak256(toBytes(canonicalJson(value))).slice(2);

const safeRelative = (p: string) =>
  typeof p === "string" && p.length > 0 && !/^[a-z]+:|^\/|(^|\/)\.\.(\/|$)/i.test(p);

export function validateManifest(m: any): asserts m is DeploymentManifest {
  if (!m || m.version !== 1) throw new Error("deployment_invalid");
  if (!Number.isInteger(m.chainId)) throw new Error("deployment_invalid");
  if (!m.network || m.network.chainId !== m.chainId) throw new Error("deployment_chain_mismatch");
  if (!Array.isArray(m.network.rpcUrls) || !m.network.rpcUrls.length)
    throw new Error("deployment_invalid");
  for (const c of m.contracts ?? []) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.address) || !/^[0-9a-f]{64}$/.test(c.abiHash))
      throw new Error("deployment_invalid");
    if (!safeRelative(c.abiPath)) throw new Error("deployment_invalid");
  }
}

export function walletAddChainFrom(network: NetworkBlock): WalletAddChain {
  return {
    chainId: "0x" + network.chainId.toString(16),
    chainName: network.name,
    rpcUrls: network.rpcUrls,
    nativeCurrency: network.nativeCurrency,
    blockExplorerUrls: [network.explorer],
  };
}

/** Loads ./imd-deployment.json and the board ABI it names; checks the ABI hash against the handoff. */
export async function loadDeployment(
  fetcher: typeof fetch = fetch,
  base: string = DEPLOYMENT_URL,
): Promise<Deployment> {
  const res = await fetcher(base, { cache: "no-store" });
  if (!res.ok) throw new Error("deployment_missing");
  const manifest = await res.json();
  validateManifest(manifest);
  const entry = manifest.contracts.find((c) => c.name === BOARD_CONTRACT);
  if (!entry) throw new Error("deployment_missing_board");
  const abiUrl = new URL(entry.abiPath, new URL(base, location.href)).href;
  const abiRes = await fetcher(abiUrl, { cache: "no-store" });
  if (!abiRes.ok) throw new Error("abi_missing");
  const abi = (await abiRes.json()) as Abi;
  if (canonicalKeccak(abi) !== entry.abiHash) throw new Error("abi_hash_mismatch");
  const network = manifest.network!;
  return {
    manifest,
    network,
    walletAddChain: manifest.walletAddChain ?? walletAddChainFrom(network),
    chainHex: "0x" + manifest.chainId.toString(16),
    board: { address: entry.address, abi, abiHash: entry.abiHash },
  };
}
