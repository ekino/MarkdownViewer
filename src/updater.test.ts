import { describe, expect, it } from "vitest";
import {
  extractDownloadUrls,
  isAutoCheckEnabled,
  isHostAllowed,
  isUpgrade,
} from "./updater";

describe("isAutoCheckEnabled", () => {
  it("defaults to enabled when no value stored", () => {
    expect(isAutoCheckEnabled(undefined)).toBe(true);
    expect(isAutoCheckEnabled(null)).toBe(true);
  });

  it("respects explicit true/false", () => {
    expect(isAutoCheckEnabled(true)).toBe(true);
    expect(isAutoCheckEnabled(false)).toBe(false);
  });

  it("rejects non-boolean stored values rather than coercing", () => {
    // Defensive: a corrupted settings.json should fail closed, not
    // accidentally re-enable a feature the user turned off.
    expect(isAutoCheckEnabled("true")).toBe(false);
    expect(isAutoCheckEnabled(1)).toBe(false);
    expect(isAutoCheckEnabled({})).toBe(false);
  });
});

describe("isUpgrade", () => {
  it("returns true for strict-greater versions", () => {
    expect(isUpgrade("0.9.0", "0.10.0")).toBe(true);
    expect(isUpgrade("0.9.0", "1.0.0")).toBe(true);
    expect(isUpgrade("0.9.0", "0.9.1")).toBe(true);
    expect(isUpgrade("1.2.3", "1.2.4")).toBe(true);
  });

  it("returns false for equal or older versions", () => {
    expect(isUpgrade("0.9.0", "0.9.0")).toBe(false);
    expect(isUpgrade("1.0.0", "0.9.9")).toBe(false);
    expect(isUpgrade("0.10.0", "0.9.0")).toBe(false);
  });

  it("strips leading 'v'", () => {
    expect(isUpgrade("v0.9.0", "v0.10.0")).toBe(true);
    expect(isUpgrade("0.9.0", "v0.10.0")).toBe(true);
  });

  it("treats missing trailing segments as 0", () => {
    expect(isUpgrade("0.9", "0.9.1")).toBe(true);
    expect(isUpgrade("0.9.0", "0.9")).toBe(false);
  });

  it("ignores pre-release/build metadata, comparing core only", () => {
    // For our use case we ship clean semver tags; pre-release tags
    // (v1.0.0-rc1) should not be treated as "upgrade to 1.0.0".
    expect(isUpgrade("1.0.0", "1.0.0-rc1")).toBe(false);
    expect(isUpgrade("0.9.0", "1.0.0-beta")).toBe(true);
  });

  it("rejects garbage version strings (security: hostile manifest)", () => {
    // L1 fix: a hostile manifest setting version to "99.0.0-attacker"
    // or any non-numeric segments must NOT be parsed as a huge version.
    expect(isUpgrade("0.9.0", "garbage")).toBe(false);
    expect(isUpgrade("0.9.0", "99.attacker.0")).toBe(false);
    expect(isUpgrade("0.9.0", "")).toBe(false);
    expect(isUpgrade("0.9.0", "...")).toBe(false);
    expect(isUpgrade("0.9.0", "1.0.0a")).toBe(false);
    // Garbage on the current side also fails closed.
    expect(isUpgrade("garbage", "1.0.0")).toBe(false);
  });

  it("handles multi-digit segments correctly (no string-compare bug)", () => {
    expect(isUpgrade("1.9.0", "1.10.0")).toBe(true);
    expect(isUpgrade("0.99.0", "0.100.0")).toBe(true);
  });
});

describe("isHostAllowed (domain pinning)", () => {
  it("accepts github.com over HTTPS", () => {
    expect(
      isHostAllowed(
        "https://github.com/ekino/MarkdownViewer/releases/download/v0.10.0/Markdown-Viewer.app.tar.gz",
      ),
    ).toBe(true);
  });

  it("accepts the GitHub object-store redirect target", () => {
    expect(
      isHostAllowed("https://objects.githubusercontent.com/something"),
    ).toBe(true);
  });

  it("rejects HTTP (no TLS)", () => {
    expect(isHostAllowed("http://github.com/anything")).toBe(false);
  });

  it("rejects look-alike hosts (homoglyph / typosquat / subdomain attacks)", () => {
    // Critical: a manifest pointing at attacker-controlled lookalikes
    // must fail closed even if the cert chain validates.
    expect(isHostAllowed("https://github.com.evil.com/x")).toBe(false);
    expect(isHostAllowed("https://evil.github.com.attacker.io/x")).toBe(false);
    expect(isHostAllowed("https://raw.githubusercontent.com/x")).toBe(false);
    expect(isHostAllowed("https://gist.github.com/x")).toBe(false);
  });

  it("rejects garbage and non-URLs without throwing", () => {
    expect(isHostAllowed("")).toBe(false);
    expect(isHostAllowed("not-a-url")).toBe(false);
    expect(isHostAllowed("javascript:alert(1)")).toBe(false);
    expect(isHostAllowed("file:///etc/passwd")).toBe(false);
  });
});

describe("extractDownloadUrls", () => {
  it("returns every platform's url from a typical manifest", () => {
    const manifest = {
      version: "0.10.0",
      platforms: {
        "darwin-x86_64": { signature: "sig1", url: "https://github.com/a" },
        "darwin-aarch64": { signature: "sig2", url: "https://github.com/b" },
        "windows-x86_64": { signature: "sig3", url: "https://github.com/c" },
      },
    };
    expect(extractDownloadUrls(manifest)).toEqual([
      "https://github.com/a",
      "https://github.com/b",
      "https://github.com/c",
    ]);
  });

  it("returns empty array when platforms is missing or malformed", () => {
    expect(extractDownloadUrls({})).toEqual([]);
    expect(extractDownloadUrls({ platforms: null })).toEqual([]);
    expect(extractDownloadUrls({ platforms: "garbage" })).toEqual([]);
  });

  it("skips entries without a string url", () => {
    const manifest = {
      platforms: {
        "darwin-x86_64": { signature: "s", url: "https://github.com/a" },
        "darwin-aarch64": { signature: "s", url: 42 }, // not a string
        "windows-x86_64": { signature: "s" }, // missing url
        garbage: "not-an-object",
      },
    };
    expect(extractDownloadUrls(manifest)).toEqual(["https://github.com/a"]);
  });
});
