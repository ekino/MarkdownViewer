// Auto-updater glue. Wraps the Tauri updater plugin behind a tiny
// renderer-side API: a startup check (gated on the user pref) and a
// manual "check now" path triggered from the menu.
//
// All download/install work happens in the Rust side via the plugin —
// this module just decides when to call it, what to show the user, and
// how to suppress repeated prompts for the same version.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Store } from "@tauri-apps/plugin-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { showToast } from "./toast";
import { t } from "./i18n";

export const AUTO_CHECK_KEY = "autoCheckUpdates";
export const LAST_DISMISSED_VERSION_KEY = "lastDismissedUpdateVersion";

// Single source of truth for the GitHub coordinates. Kept in sync with
// tauri.conf.json (updater endpoint) and lib.rs (release notes API).
// If this ever changes, those three places must all change together.
export const GITHUB_REPO = "ekino/MarkdownViewer";
const RELEASE_URL_BASE = `https://github.com/${GITHUB_REPO}/releases/tag`;

// The only host we'll accept update artifacts from. A signed manifest
// pointing at a different host (CDN mirror, attacker fork, etc.) is
// rejected even if the signature would have verified — the security
// model assumes ekino-controlled hosting. The Ed25519 sig is the real
// gate; this is defense-in-depth against a signing-key compromise
// where the attacker also relocates artifacts.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com", // GitHub redirects releases here
]);

export function isHostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ALLOWED_DOWNLOAD_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// Walks the manifest JSON the plugin parsed and returns every download
// URL it advertises. We pin all of them, not just our platform, because
// the plugin picks the platform server-side — we want to detect a
// hostile manifest before the plugin has a chance to act on any entry.
//
// IMPORTANT (L1): this enumeration is tightly coupled to the manifest
// schema understood by tauri-plugin-updater. The current schema exposes
// download URLs under `platforms[<target>].url`. If a future Tauri
// version introduces a new URL field (mirror_url, fallback, etc.), it
// MUST be added here — otherwise the host-pinning check below will
// silently miss it and the plugin could fetch from an unvalidated host.
// Keep this function in sync with whatever fields the plugin actually
// reads. The Ed25519 signature is still the cryptographic gate, but
// host pinning is the defense-in-depth layer it relies on.
export function extractDownloadUrls(rawJson: Record<string, unknown>): string[] {
  const out: string[] = [];
  const platforms = rawJson["platforms"];
  if (platforms && typeof platforms === "object") {
    for (const entry of Object.values(platforms as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        const url = (entry as Record<string, unknown>).url;
        if (typeof url === "string") out.push(url);
      }
    }
  }
  return out;
}

export function isAutoCheckEnabled(stored: unknown): boolean {
  // Default to enabled when the user hasn't set the pref yet.
  if (stored === undefined || stored === null) return true;
  return stored === true;
}

// Tauri's updater plugin will refuse to install older versions, but we
// still gate on the renderer side so a buggy/hostile manifest can't
// surprise us between plugin updates. Strict-greater required.
//
// Stricter than a naive split: every segment must be purely numeric.
// Anything with garbage segments (e.g. a hostile manifest setting
// version to "99.0.0-attacker.payload") falls back to false rather
// than being interpreted as a huge version. The actual security
// boundary is the Ed25519 signature, but defense-in-depth.
export function isUpgrade(current: string, candidate: string): boolean {
  const parse = (v: string): number[] | null => {
    const stripped = v.replace(/^v/, "").split(/[+-]/)[0];
    const parts = stripped.split(".");
    if (parts.length === 0) return null;
    const out: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      const n = Number.parseInt(p, 10);
      if (!Number.isFinite(n)) return null;
      out.push(n);
    }
    return out;
  };
  const a = parse(current);
  const b = parse(candidate);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (bi > ai) return true;
    if (bi < ai) return false;
  }
  return false;
}

export interface UpdaterDeps {
  store: Store;
  showBanner: (
    update: Update,
    onAction: (action: BannerAction) => void,
  ) => void;
  hideBanner: () => void;
}

export type BannerAction =
  | { type: "install" }
  | { type: "later" }
  | { type: "notes" };

// Startup auto-check. Silent on failure (offline, endpoint 404 on
// first-ever release) — we don't want a network blip to surface a
// scary error toast on every cold launch.
export async function autoCheckOnStartup(deps: UpdaterDeps): Promise<void> {
  const enabled = isAutoCheckEnabled(await deps.store.get(AUTO_CHECK_KEY));
  if (!enabled) return;
  try {
    const update = await check();
    if (!update) return;
    const current = await getVersion();
    if (!isUpgrade(current, update.version)) return;
    const lastDismissed = await deps.store.get<string>(
      LAST_DISMISSED_VERSION_KEY,
    );
    if (lastDismissed === update.version) return;
    deps.showBanner(update, (action) => handleAction(deps, update, action));
  } catch {
    // Silent — offline / 404 / parse error all land here.
  }
}

// Manual "Check for Updates…" from the menu. Surfaces feedback either way.
export async function manualCheck(deps: UpdaterDeps): Promise<void> {
  try {
    const update = await check();
    const current = await getVersion();
    if (!update || !isUpgrade(current, update.version)) {
      showToast(t("updater.uptodate"), "info");
      return;
    }
    // Manual flow ignores last-dismissed (user explicitly asked).
    deps.showBanner(update, (action) => handleAction(deps, update, action));
  } catch (e) {
    console.warn("Update check failed:", e);
    showToast(t("updater.check.failed"), "error");
  }
}

async function handleAction(
  deps: UpdaterDeps,
  update: Update,
  action: BannerAction,
): Promise<void> {
  switch (action.type) {
    case "install": {
      try {
        if (!(await assertSourceIsTrusted(update))) return;
        if (!(await confirmInstall(update))) return;
        showToast(t("updater.installing"), "info");
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        console.error("Update install failed:", e);
        showToast(t("updater.install.failed"), "error");
      }
      break;
    }
    case "later": {
      await deps.store.set(LAST_DISMISSED_VERSION_KEY, update.version);
      await deps.store.save();
      deps.hideBanner();
      break;
    }
    case "notes": {
      const url = `${RELEASE_URL_BASE}/v${update.version}`;
      try {
        await openUrl(url);
      } catch {
        // Best-effort — opener may fail on permission issues; the URL
        // is still meaningful to the user from the toast.
        showToast(url, "info");
      }
      break;
    }
  }
}

// Reduce a URL to just its hostname for logging. L2: full URLs in
// rejection logs could leak attacker tracking endpoints into OS logs;
// the hostname is enough for forensics and triage.
function safeHostFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "<unparseable>";
  }
}

// Pre-install gate: verifies every download URL the manifest advertises
// lives on a host we trust, AND asks the Rust side to compare versions
// (the Rust check is inattackable from the renderer, unlike isUpgrade()).
//
// The Ed25519 signature on the artifact is still the security boundary —
// these checks are defense-in-depth that fail closed when an attacker
// owns the signing key OR finds an XSS in the renderer.
async function assertSourceIsTrusted(update: Update): Promise<boolean> {
  const urls = extractDownloadUrls(update.rawJson);
  if (urls.length === 0) {
    // Manifest with no platform URLs is malformed — the plugin would
    // have failed anyway, but refuse explicitly so the user sees why.
    showToast(t("updater.source.untrusted"), "error");
    return false;
  }
  for (const url of urls) {
    if (!isHostAllowed(url)) {
      console.warn(
        "Rejecting update: untrusted download host in manifest:",
        safeHostFor(url),
      );
      showToast(t("updater.source.untrusted"), "error");
      return false;
    }
  }
  try {
    // Server-side semver check — this command lives in Rust and cannot
    // be skipped by a compromised renderer. The current version is
    // sourced from the binary on the Rust side, not from this call.
    await invoke("assert_update_is_upgrade", {
      candidateVersion: update.version,
    });
  } catch (e) {
    console.warn("Rust downgrade-guard rejected update:", e);
    showToast(t("updater.source.untrusted"), "error");
    return false;
  }
  return true;
}

// Surface the version + first download URL to the user and ask them to
// explicitly opt in via a NATIVE OS dialog (tauri-plugin-dialog ask()).
// This runs out-of-renderer: an XSS in the webview cannot synthesize a
// click to auto-confirm it, unlike the previous renderer-side modal.
async function confirmInstall(update: Update): Promise<boolean> {
  const urls = extractDownloadUrls(update.rawJson);
  const primaryUrl = urls[0] ?? "";
  const message = t("updater.confirm.message")
    .replace("{version}", update.version)
    .replace("{url}", primaryUrl);
  return ask(message, {
    title: t("updater.confirm.title"),
    kind: "info",
    okLabel: t("updater.confirm.ok"),
    cancelLabel: t("updater.confirm.cancel"),
  });
}
