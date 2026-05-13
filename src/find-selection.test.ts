import { beforeEach, describe, expect, it } from "vitest";
import { readSelectionWithin } from "./find-selection";

function makeContainer(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

function selectNodeContents(node: Node): Selection {
  const sel = window.getSelection();
  if (!sel) throw new Error("no selection api");
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(node);
  sel.addRange(range);
  return sel;
}

describe("readSelectionWithin", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("returns selected text inside the container", () => {
    const c = makeContainer("<p>hello world</p>");
    const sel = selectNodeContents(c.querySelector("p") as Element);
    expect(readSelectionWithin(c, sel)).toBe("hello world");
  });

  it("returns empty string when selection is null", () => {
    const c = makeContainer("<p>foo</p>");
    expect(readSelectionWithin(c, null)).toBe("");
  });

  it("returns empty string when selection is collapsed", () => {
    const c = makeContainer("<p>foo</p>");
    const sel = window.getSelection();
    if (!sel) throw new Error("no selection api");
    sel.removeAllRanges();
    const range = document.createRange();
    const text = c.querySelector("p")?.firstChild as Text;
    range.setStart(text, 1);
    range.setEnd(text, 1);
    sel.addRange(range);
    expect(readSelectionWithin(c, sel)).toBe("");
  });

  it("returns empty string when selection is outside the container", () => {
    const inside = makeContainer("<p>inside</p>");
    const outside = makeContainer("<p>outside</p>");
    const sel = selectNodeContents(outside.querySelector("p") as Element);
    expect(readSelectionWithin(inside, sel)).toBe("");
  });

  it("trims surrounding whitespace", () => {
    const c = makeContainer("<p>   spaced   </p>");
    const sel = selectNodeContents(c.querySelector("p") as Element);
    expect(readSelectionWithin(c, sel)).toBe("spaced");
  });

  it("returns empty for whitespace-only selection", () => {
    const c = makeContainer("<p>   </p>");
    const sel = selectNodeContents(c.querySelector("p") as Element);
    expect(readSelectionWithin(c, sel)).toBe("");
  });

  it("accepts selections that span nested elements", () => {
    const c = makeContainer("<p>hel<strong>lo</strong> world</p>");
    const sel = selectNodeContents(c.querySelector("p") as Element);
    expect(readSelectionWithin(c, sel)).toBe("hello world");
  });
});
