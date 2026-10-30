// Wallets and the score board contract. Everything chain-specific comes from the loaded
// imd-deployment.json (see config.ts); this file only wires it to wagmi/viem.
import {
  createConfig,
  connect as wagmiConnect,
  disconnect as wagmiDisconnect,
  fallback,
  getAccount,
  http,
  injected,
  reconnect,
  signMessage,
  simulateContract,
  waitForTransactionReceipt,
  watchAccount,
  watchConnectors,
  writeContract,
  type Config,
  type Connector,
} from "@wagmi/core";
import { coinbaseWallet } from "@wagmi/connectors";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  defineChain,
  getAddress,
  UserRejectedRequestError,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { SITE_NAME, type Deployment } from "./config";

export const short = (a?: string | null) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

export function chainFromDeployment(d: Deployment): Chain {
  const n = d.network;
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: n.nativeCurrency,
    rpcUrls: { default: { http: n.rpcUrls } },
    blockExplorers: { default: { name: "Explorer", url: n.explorer } },
    testnet: n.testnet,
  });
}

export interface ChainState {
  address: Address | null;
  chainId: number | null;
  connector: Connector | null;
}
type Listener = (s: ChainState) => void;

export class Chainlink {
  d: Deployment;
  chain: Chain;
  wagmi: Config;
  client: PublicClient;
  codeVerified = false;
  private listeners = new Set<Listener>();
  state: ChainState = { address: null, chainId: null, connector: null };

  constructor(d: Deployment) {
    this.d = d;
    this.chain = chainFromDeployment(d);
    const transport = fallback(d.network.rpcUrls.map((u) => http(u)));
    this.wagmi = createConfig({
      chains: [this.chain],
      // EIP-6963 discovery lists every installed extension under its own name.
      multiInjectedProviderDiscovery: true,
      connectors: [injected(), coinbaseWallet({ appName: SITE_NAME })],
      transports: { [this.chain.id]: transport },
    });
    this.client = createPublicClient({ chain: this.chain, transport }) as PublicClient;
    watchAccount(this.wagmi, {
      onChange: (a) => {
        this.state = {
          address: a.address ? (getAddress(a.address) as Address) : null,
          chainId: a.chainId ?? null,
          connector: a.connector ?? null,
        };
        this.listeners.forEach((fn) => fn(this.state));
      },
    });
  }
  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onConnectors(fn: () => void) {
    return watchConnectors(this.wagmi, { onChange: fn });
  }
  async reconnect() {
    await reconnect(this.wagmi).catch(() => {});
    const a = getAccount(this.wagmi);
    if (a.address)
      this.state = { address: getAddress(a.address), chainId: a.chainId ?? null, connector: a.connector ?? null };
    return this.state;
  }
  get connectors() {
    return this.wagmi.connectors;
  }
  get onRightChain() {
    return this.state.chainId === this.d.manifest.chainId;
  }
  async connect(connector: Connector) {
    const r = await wagmiConnect(this.wagmi, { connector });
    return getAddress(r.accounts[0]);
  }
  async disconnect() {
    await wagmiDisconnect(this.wagmi).catch(() => {});
  }

  /** wallet_switchEthereumChain, then wallet_addEthereumChain with network.json's exact parameters. */
  async ensureChain() {
    const connector = this.state.connector;
    if (!connector) throw new Error("no_provider");
    const provider: any = await connector.getProvider();
    const hex = this.d.chainHex;
    const current = await provider.request({ method: "eth_chainId" });
    if (String(current).toLowerCase() === hex) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e: any) {
      const code = e?.code ?? e?.data?.originalError?.code;
      const unknown = code === 4902 || /unrecognized|unknown chain|not added/i.test(String(e?.message));
      if (!unknown) throw e;
      await provider.request({ method: "wallet_addEthereumChain", params: [this.d.walletAddChain] });
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    }
    const after = await provider.request({ method: "eth_chainId" });
    if (String(after).toLowerCase() !== hex) throw new Error("wrong_chain");
  }

  sign(message: string) {
    return signMessage(this.wagmi, { message, account: this.state.address! });
  }

  async verifyCode() {
    const code = await this.client.getCode({ address: this.d.board.address });
    this.codeVerified = !!code && code !== "0x";
    return this.codeVerified;
  }

  read<T = unknown>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({
      address: this.d.board.address,
      abi: this.d.board.abi,
      functionName,
      args,
    } as any) as Promise<T>;
  }

  /** Simulate, then ask the wallet to sign. Throws a decoded revert name before any prompt. */
  async write(functionName: string, args: readonly unknown[] = []): Promise<Hex> {
    if (!this.codeVerified) throw new Error("contract_unverified");
    if (!this.state.address) throw new Error("not_connected");
    await this.ensureChain();
    const { request } = await simulateContract(this.wagmi, {
      address: this.d.board.address,
      abi: this.d.board.abi,
      functionName,
      args,
      account: this.state.address,
      chainId: this.chain.id,
    } as any);
    return writeContract(this.wagmi, request as any);
  }
  async wait(hash: Hex) {
    const r = await waitForTransactionReceipt(this.wagmi, { hash, chainId: this.chain.id });
    if (r.status !== "success") throw new Error("transaction_reverted");
    return r;
  }
  explorer(kind: "tx" | "address", value: string) {
    return this.d.network.explorer.replace(/\/$/, "") + "/" + kind + "/" + value;
  }
}

/** A short code for any wallet/contract error, for the i18n table. */
export function errorCode(e: any): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "user_rejected";
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) return "revert:" + (revert.data?.errorName ?? revert.reason ?? "unknown");
    if (/rejected|denied/i.test(e.shortMessage)) return "user_rejected";
    return e.shortMessage || e.message;
  }
  if (e?.code === 4001) return "user_rejected";
  return e?.code && typeof e.code === "string" ? e.code : e?.message || "request_failed";
}
