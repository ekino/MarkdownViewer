import { describe, expect, it } from "vitest";
import { shouldAutoShow } from "./whats-new";

describe("shouldAutoShow", () => {
  it("skips on first-ever launch (no lastSeen)", () => {
    // Critical: a fresh install must not auto-open the What's New screen.
    expect(shouldAutoShow("0.10.0", null)).toBe(false);
    expect(shouldAutoShow("0.10.0", undefined)).toBe(false);
    expect(shouldAutoShow("0.10.0", "")).toBe(false);
  });

  it("triggers when current differs from lastSeen", () => {
    expect(shouldAutoShow("0.10.0", "0.9.0")).toBe(true);
  });

  it("does not trigger when versions match", () => {
    expect(shouldAutoShow("0.10.0", "0.10.0")).toBe(false);
  });

  it("treats downgrades the same as upgrades (any delta opens the screen)", () => {
    // The screen always reflects the CURRENT installed version's notes,
    // so a delta in either direction is a valid trigger. The updater
    // path enforces strict-greater; What's New is just "did the version
    // change since we last showed something?".
    expect(shouldAutoShow("0.9.0", "0.10.0")).toBe(true);
  });
});
