import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalKeccak, loadDeployment, validateManifest, walletAddChainFrom } from "../src/config";
import { listConnectors } from "../src/sheet";

const handoff = JSON.parse(readFileSync(resolve(process.cwd(), "deployment/deployment.json"), "utf8"));
const network = JSON.parse(readFileSync(resolve(process.cwd(), "deployment/network.json"), "utf8"));
const abi = JSON.parse(readFileSync(resolve(process.cwd(), "public/abi/SqueekSupplyBoard.json"), "utf8"));
const manifest = {
  version: 1,
  launchId: handoff.launchId,
  chainId: handoff.chainId,
  sourceCommit: handoff.sourceCommit,
  attestationHash: handoff.attestationHash,
  contracts: handoff.contracts.map((c: any) => ({ name: c.name, address: c.address, abiHash: c.abiHash, abiPath: `abi/${c.name}.json` })),
  assets: [],
  network: network.network,
  walletAddChain: network.walletAddChain,
};
const fakeFetch = (files: Record<string, unknown>) =>
  (async (url: string) => {
    const key = Object.keys(files).find((k) => String(url).endsWith(k));
    return key ? new Response(JSON.stringify(files[key])) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;

describe("deployment configuration", () => {
  it("bundled ABI matches the handoff's canonical keccak", () => {
    expect(canonicalKeccak(abi)).toBe(handoff.contracts[0].abiHash);
  });
  it("loads the manifest and ABI, keeping network.json's addChain parameters", async () => {
    const d = await loadDeployment(fakeFetch({ "imd-deployment.json": manifest, "abi/SqueekSupplyBoard.json": abi }), "./imd-deployment.json");
    expect(d.board.address).toBe(handoff.contracts[0].address);
    expect(d.chainHex).toBe("0xaa36a7");
    expect(d.walletAddChain).toEqual(network.walletAddChain);
  });
  it("refuses an ABI whose hash differs from the handoff", async () => {
    const tampered = abi.filter((e: any) => e.name !== "setSigner");
    await expect(
      loadDeployment(fakeFetch({ "imd-deployment.json": manifest, "abi/SqueekSupplyBoard.json": tampered }), "./imd-deployment.json"),
    ).rejects.toThrow("abi_hash_mismatch");
  });
  it("refuses a missing manifest, a chain mismatch and traversal paths", async () => {
    await expect(loadDeployment(fakeFetch({}), "./imd-deployment.json")).rejects.toThrow("deployment_missing");
    expect(() => validateManifest({ ...manifest, chainId: 1 })).toThrow("deployment_chain_mismatch");
    expect(() =>
      validateManifest({ ...manifest, contracts: [{ ...manifest.contracts[0], abiPath: "../abi.json" }] }),
    ).toThrow("deployment_invalid");
    expect(() =>
      validateManifest({ ...manifest, contracts: [{ ...manifest.contracts[0], abiPath: "https://x/abi.json" }] }),
    ).toThrow("deployment_invalid");
  });
  it("derives addChain parameters equal to network.json's when walletAddChain is absent", () => {
    expect(walletAddChainFrom(network.network)).toEqual(network.walletAddChain);
  });
});

describe("connect sheet rows", () => {
  const c = (id: string, type: string, name = id) => ({ id, type, name }) as any;
  it("hides the generic injected row when EIP-6963 named an extension", () => {
    const rows = listConnectors([c("injected", "injected"), c("io.metamask", "injected", "MetaMask"), c("coinbaseWalletSDK", "coinbaseWallet")], false);
    expect(rows.map((r) => r.id)).toEqual(["io.metamask", "coinbaseWalletSDK"]);
  });
  it("keeps the generic row when nothing was discovered, and drops injected rows on phones", () => {
    const list = [c("injected", "injected"), c("coinbaseWalletSDK", "coinbaseWallet")];
    expect(listConnectors(list, false).map((r) => r.id)).toEqual(["injected", "coinbaseWalletSDK"]);
    expect(listConnectors(list, true).map((r) => r.id)).toEqual(["coinbaseWalletSDK"]);
  });
});
