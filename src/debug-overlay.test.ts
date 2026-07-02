import { describe, expect, it } from "vitest";
import {
  formatClipboard,
  formatOpenRecord,
  type OpenRecord,
} from "./debug-overlay";

function rec(phases: Partial<OpenRecord["phases"]>, total = 0): OpenRecord {
  return {
    file: "doc.md",
    total,
    phases: {
      ping: 0,
      read: 0,
      parse: 0,
      images: 0,
      mermaid: 0,
      dom: 0,
      outline: 0,
      ...phases,
    },
  };
}

describe("formatOpenRecord", () => {
  it("lists every phase in order plus the total", () => {
    const lines = formatOpenRecord(rec({}, 12.34));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain("ipc ping (no-op)");
    expect(lines[1]).toContain("read file (IPC)");
    expect(lines[2]).toContain("parse markdown");
    expect(lines[7]).toBe("total: 12.3 ms");
  });

  it("flags the slowest phase", () => {
    const lines = formatOpenRecord(rec({ parse: 5, mermaid: 900, dom: 2 }));
    const mermaidLine = lines.find((l) => l.startsWith("mermaid:"));
    const parseLine = lines.find((l) => l.startsWith("parse markdown:"));
    expect(mermaidLine).toContain("◀ slowest");
    expect(parseLine).not.toContain("slowest");
  });

  it("formats milliseconds to one decimal", () => {
    const lines = formatOpenRecord(rec({ parse: 123.456 }));
    expect(lines[2]).toContain("123.5 ms");
  });
});

describe("formatClipboard", () => {
  it("prepends the file name and FPS to the phase lines", () => {
    const text = formatClipboard(rec({ parse: 5 }, 60), 58);
    const lines = text.split("\n");
    expect(lines[0]).toBe("open: doc.md");
    expect(lines[1]).toBe("FPS 58");
    expect(lines[2]).toContain("ipc ping (no-op)");
    expect(lines[lines.length - 1]).toBe("total: 60.0 ms");
  });
});
