import { describe, expect, it, vi } from "vitest";
import { addCopyButtons, addImageLightbox } from "./dom";
import { setLocale, t } from "./i18n";
import { parseMarkdown } from "./markdown";

describe("integration — markdown to DOM", () => {
  it("renders complex markdown into valid DOM structure", () => {
    const md = [
      "# Main Title",
      "",
      "Some **bold** and *italic* text.",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "> [!NOTE]",
      "> This is a note",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- [x] Done",
      "- [ ] Todo",
      "",
      "Text with footnote[^1]",
      "",
      "[^1]: Footnote content",
    ].join("\n");

    const html = parseMarkdown(md);
    const div = document.createElement("div");
    div.innerHTML = html;

    expect(div.querySelector("h1")).not.toBeNull();
    expect(div.querySelector("strong")?.textContent).toBe("bold");
    expect(div.querySelector("em")?.textContent).toBe("italic");
    expect(div.querySelector("pre code")).not.toBeNull();
    expect(div.querySelector(".markdown-alert")).not.toBeNull();
    expect(div.querySelector("table")).not.toBeNull();
    expect(div.querySelectorAll("input").length).toBeGreaterThanOrEqual(2);
  });

  it("strips malicious event handlers from DOM", () => {
    const md = [
      '<img src="x.png" onerror="alert(1)">',
      '<div onclick="alert(2)">text</div>',
      '<a href="javascript:alert(3)">link</a>',
    ].join("\n");

    const html = parseMarkdown(md);
    const div = document.createElement("div");
    div.innerHTML = html;

    for (const el of div.querySelectorAll("*")) {
      for (const attr of el.attributes) {
        expect(attr.name).not.toMatch(/^on/);
      }
      const href = el.getAttribute("href");
      if (href) {
        expect(href).not.toContain("javascript:");
      }
    }
  });
});

describe("integration — addCopyButtons", () => {
  it("adds a copy button to pre elements containing code", () => {
    const container = document.createElement("div");
    container.innerHTML = [
      "<pre><code>const x = 1;</code></pre>",
      "<pre><code>const y = 2;</code></pre>",
      "<pre>No code here</pre>",
    ].join("");

    setLocale("en");
    addCopyButtons(container);

    const buttons = container.querySelectorAll(".copy-btn");
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe(t("code.copy"));
  });

  it("does not add duplicate buttons", () => {
    const container = document.createElement("div");
    container.innerHTML = "<pre><code>const x = 1;</code></pre>";

    addCopyButtons(container);
    addCopyButtons(container);

    expect(container.querySelectorAll(".copy-btn").length).toBe(1);
  });

  it("sets position relative on pre", () => {
    const container = document.createElement("div");
    container.innerHTML = "<pre><code>code</code></pre>";

    addCopyButtons(container);

    const pre = container.querySelector("pre") as HTMLElement;
    expect(pre.style.position).toBe("relative");
  });
});

describe("integration — addImageLightbox", () => {
  it("adds cursor pointer to images", () => {
    const container = document.createElement("div");
    container.innerHTML = '<img src="a.png" alt="A"><img src="b.png" alt="B">';

    addImageLightbox(container, () => {});

    const images = container.querySelectorAll("img");
    for (const img of images) {
      expect(img.style.cursor).toBe("pointer");
    }
  });

  it("calls onImageClick when image is clicked", () => {
    const container = document.createElement("div");
    container.innerHTML = '<img src="test.png" alt="Test">';
    const onClick = vi.fn();

    addImageLightbox(container, onClick);

    const img = container.querySelector("img") as HTMLImageElement;
    img.click();

    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledWith(img);
  });
});
