import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "./i18n";
import {
  createUpdaterController,
  type UpdateHandle,
  type UpdaterBackend,
} from "./updater";

function buildToast(): void {
  document.body.innerHTML = `
    <div id="update-toast" hidden>
      <span id="update-toast-icon"></span>
      <span id="update-toast-text"></span>
      <button id="update-toast-action" hidden></button>
      <button id="update-toast-dismiss"></button>
    </div>
  `;
}

function refs() {
  return {
    root: document.getElementById("update-toast") as HTMLElement,
    icon: document.getElementById("update-toast-icon") as HTMLElement,
    text: document.getElementById("update-toast-text") as HTMLElement,
    action: document.getElementById(
      "update-toast-action"
    ) as HTMLButtonElement,
    dismiss: document.getElementById(
      "update-toast-dismiss"
    ) as HTMLButtonElement,
  };
}

function fakeUpdate(version: string, install = vi.fn().mockResolvedValue(undefined)): UpdateHandle {
  return { version, downloadAndInstall: install };
}

describe("updater controller", () => {
  beforeEach(() => {
    setLocale("en");
    buildToast();
  });

  it("stays hidden on a silent check when up to date", async () => {
    const backend: UpdaterBackend = {
      check: vi.fn().mockResolvedValue(null),
      relaunch: vi.fn(),
    };
    const c = createUpdaterController(backend);
    await c.check({ silent: true });
    expect(refs().root.hidden).toBe(true);
    expect(backend.check).toHaveBeenCalledOnce();
  });

  it("shows 'up to date' on a manual check", async () => {
    const backend: UpdaterBackend = {
      check: vi.fn().mockResolvedValue(null),
      relaunch: vi.fn(),
    };
    const c = createUpdaterController(backend);
    await c.check({ silent: false });
    const r = refs();
    expect(r.root.hidden).toBe(false);
    expect(r.text.textContent).toBe("There are currently no updates available.");
    expect(r.action.hidden).toBe(true);
  });

  it("downloads and offers restart when an update is available", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    const backend: UpdaterBackend = {
      check: vi.fn().mockResolvedValue(fakeUpdate("0.11.0", install)),
      relaunch: vi.fn().mockResolvedValue(undefined),
    };
    const c = createUpdaterController(backend);
    await c.check({ silent: true });

    const r = refs();
    expect(install).toHaveBeenCalledOnce();
    expect(r.root.hidden).toBe(false);
    expect(r.text.textContent).toContain("0.11.0");
    expect(r.action.hidden).toBe(false);

    r.action.click();
    expect(backend.relaunch).toHaveBeenCalledOnce();
  });

  it("surfaces download failures", async () => {
    const backend: UpdaterBackend = {
      check: vi
        .fn()
        .mockResolvedValue(
          fakeUpdate("0.11.0", vi.fn().mockRejectedValue(new Error("net")))
        ),
      relaunch: vi.fn(),
    };
    const c = createUpdaterController(backend);
    await c.check({ silent: true });
    const r = refs();
    expect(r.root.hidden).toBe(false);
    expect(r.action.hidden).toBe(true);
  });

  it("stays silent when the check call itself throws on launch", async () => {
    const backend: UpdaterBackend = {
      check: vi.fn().mockRejectedValue(new Error("offline")),
      relaunch: vi.fn(),
    };
    const c = createUpdaterController(backend);
    await c.check({ silent: true });
    expect(refs().root.hidden).toBe(true);
  });

  it("ignores overlapping checks while one is in flight", async () => {
    let resolveCheck: (v: UpdateHandle | null) => void = () => {};
    const check = vi.fn(
      () => new Promise<UpdateHandle | null>((res) => (resolveCheck = res))
    );
    const backend: UpdaterBackend = { check, relaunch: vi.fn() };
    const c = createUpdaterController(backend);

    const first = c.check({ silent: true });
    await c.check({ silent: true }); // should be a no-op, returns immediately
    expect(check).toHaveBeenCalledOnce();

    resolveCheck(null);
    await first;
  });

  it("lets the user dismiss the toast", async () => {
    const backend: UpdaterBackend = {
      check: vi.fn().mockResolvedValue(null),
      relaunch: vi.fn(),
    };
    const c = createUpdaterController(backend);
    await c.check({ silent: false });
    const r = refs();
    expect(r.root.hidden).toBe(false);
    r.dismiss.click();
    expect(r.root.hidden).toBe(true);
  });
});
