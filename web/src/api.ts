// Client for the existing game API (challenges, runs, replay verification, leaderboard, auth).
import { API_BASE } from "./config";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
interface RequestOptions {
  method?: string;
  body?: unknown;
  runToken?: string;
  publicRead?: boolean;
}
const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  },
  del: (k: string) => {
    try {
      sessionStorage.removeItem(k);
    } catch {}
  },
};
export const api = {
  base: API_BASE.replace(/\/$/, ""),
  token: store.get("ss.jwt") as string | null,
  fetcher: ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch,
  async request(path: string, { method = "GET", body, runToken, publicRead = false }: RequestOptions = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token && !publicRead) headers.authorization = "Bearer " + this.token;
    if (runToken) headers["x-run-token"] = runToken;
    let response: Response;
    try {
      response = await this.fetcher(this.base + path, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new ApiError("network_error", 0);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) this.logout();
      throw new ApiError(result.error || "request_failed", response.status);
    }
    return result;
  },
  async login(address: string, sign: (message: string) => Promise<string>) {
    const { message } = await this.request("/v1/auth/nonce", {
      method: "POST",
      body: { address },
      publicRead: true,
    });
    const signature = await sign(message);
    const result = await this.request("/v1/auth/verify", {
      method: "POST",
      body: { address, message, signature },
      publicRead: true,
    });
    this.token = result.token;
    store.set("ss.jwt", result.token);
    return result;
  },
  logout() {
    this.token = null;
    store.del("ss.jwt");
  },
};
