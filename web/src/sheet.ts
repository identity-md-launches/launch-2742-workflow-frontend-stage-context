// The one connect control's wallet sheet: EIP-6963 extensions by name and icon, then Coinbase
// Wallet; on a phone browser without an extension, "Open in" links, then Coinbase Smart Wallet.
import type { Connector } from "@wagmi/core";
import { WALLET_ICONS } from "./wallet-icons";
import { t } from "./game/i18n.js";

/** Each link is the one its vendor documents; none needs a project ID or a server. */
export const OPEN_IN: ReadonlyArray<{ id: string; name: string; href: (url: string) => string }> = [
  // https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks
  { id: "metamask", name: "MetaMask", href: (url) => `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, "")}` },
  // https://docs.cdp.coinbase.com/wallet-sdk/docs/deep-link
  { id: "coinbase", name: "Coinbase Wallet", href: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
  // https://docs.phantom.com/phantom-deeplinks/other-methods/browse
  {
    id: "phantom",
    name: "Phantom",
    href: (url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(url).origin)}`,
  },
];
export const isMobileBrowser = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !(window as any).ethereum;

export function listConnectors(connectors: readonly Connector[], mobile: boolean) {
  const named = connectors.some((c) => c.type === "injected" && c.id !== "injected");
  return [...connectors.filter((c) => c.type === "injected"), ...connectors.filter((c) => c.type !== "injected")]
    .filter((c) => !(c.id === "injected" && named))
    .filter((c) => !mobile || c.type !== "injected");
}
export const connectorLabel = (c: Connector, mobile: boolean) =>
  c.id === "injected" ? t("browserWallet") : c.id === "coinbaseWalletSDK" && mobile ? "Coinbase Smart Wallet" : c.name;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const icon = (src?: string) => {
  const span = el("span", "ic");
  if (src) {
    const img = el("img");
    img.width = 28;
    img.height = 28;
    img.alt = "";
    img.src = src;
    span.append(img);
  }
  return span;
};

export class ConnectSheet {
  private dialog: HTMLDialogElement | null = null;
  private trigger: HTMLElement | null = null;
  constructor(
    private getConnectors: () => readonly Connector[],
    private onPick: (c: Connector) => Promise<void>,
  ) {}
  get isOpen() {
    return !!this.dialog;
  }
  /** A native modal dialog, so it sits in the top layer above any open modal (the results
   * dialog) and the browser keeps focus inside it. */
  open(mobile = isMobileBrowser()) {
    const trigger = this.dialog ? this.trigger : (document.activeElement as HTMLElement | null);
    this.close(false);
    this.trigger = trigger;
    const sheet = el("dialog", "sheet");
    sheet.setAttribute("aria-label", t("connectTitle"));
    // A click on the dialog box itself, outside its content, is a click on the backdrop.
    sheet.onclick = (e) => e.target === sheet && this.close();
    sheet.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.close();
    });
    const head = el("div", "sheet-head");
    const x = el("button", "x", "×");
    x.setAttribute("aria-label", t("close"));
    x.onclick = () => this.close();
    head.append(el("h2", "", t("connectTitle")), x);
    sheet.append(head);
    if (mobile)
      for (const w of OPEN_IN) {
        const a = el("a", "row");
        a.href = w.href(location.href);
        a.append(icon(WALLET_ICONS[w.id]), el("span", "", t("openIn") + " " + w.name));
        sheet.append(a);
      }
    const note = el("p", "sheet-note");
    note.setAttribute("role", "status");
    const rows: HTMLButtonElement[] = [];
    for (const c of listConnectors(this.getConnectors(), mobile)) {
      const b = el("button", "row");
      const label = el("span", "", connectorLabel(c, mobile));
      b.append(icon(c.icon ?? WALLET_ICONS[c.id]), label);
      b.onclick = async () => {
        rows.forEach((r) => (r.disabled = true));
        label.textContent = connectorLabel(c, mobile) + " · " + t("opening");
        note.textContent = "";
        try {
          await this.onPick(c);
          this.close();
        } catch (e: any) {
          label.textContent = connectorLabel(c, mobile);
          note.textContent = t(e?.message === "user_rejected" ? "user_rejected" : "connectFailed");
          rows.forEach((r) => (r.disabled = false));
        }
      };
      rows.push(b);
      sheet.append(b);
    }
    sheet.append(note);
    document.body.append(sheet);
    sheet.showModal();
    this.dialog = sheet;
    (rows[0] ?? x).focus();
  }
  close(restoreFocus = true) {
    const sheet = this.dialog;
    if (!sheet) return;
    this.dialog = null;
    if (sheet.open) sheet.close();
    sheet.remove();
    if (restoreFocus && this.trigger?.isConnected) this.trigger.focus();
    if (restoreFocus) this.trigger = null;
  }
}
