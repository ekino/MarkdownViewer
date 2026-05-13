// Save / Save As dispatcher for the markdown viewer.
//
// "Save" in a read-only viewer means **export**: PDF, standalone HTML
// (inlined CSS), HTML + sibling assets folder (better fidelity for docs
// with many images), or a plain copy of the source .md.
//
// Format selection rides on the save-dialog filter the user picks. This
// keeps the UI to a single OS dialog rather than a custom modal.

export type ExportFormat = "pdf" | "html-standalone" | "html-with-assets" | "md-copy";

export interface ExportContext {
  /// Absolute path of the source markdown file (for md-copy + assets root).
  sourcePath: string;
  /// The current folder root, if any. Used as an allowed asset root.
  rootPath: string | null;
  /// The rendered markdown DOM element.
  markdownEl: HTMLElement;
  /// Default basename for the output, without extension. Usually the doc title.
  defaultStem: string;
}

export interface ExportSaveFn {
  (options: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | null>;
}

export interface ExportInvoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

const FORMAT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  pdf: { name: "PDF", extensions: ["pdf"] },
  "html-standalone": { name: "HTML (standalone)", extensions: ["html"] },
  "html-with-assets": { name: "HTML + assets", extensions: ["html"] },
  "md-copy": { name: "Markdown source", extensions: ["md"] },
};

const FORMAT_ORDER: ExportFormat[] = [
  "pdf",
  "html-standalone",
  "html-with-assets",
  "md-copy",
];

export interface StandaloneOptions {
  /// Value of the <html data-theme="..."> attribute on the exported doc.
  /// The app's CSS keys most variables to [data-theme="..."] selectors,
  /// so without this the export falls back to the :root defaults.
  dataTheme?: string;
  /// Value of <html lang="...">. Defaults to "en".
  lang?: string;
  /// Optional inline <style> appended after the bundled app CSS — used
  /// to neutralize the page-shell rules (sidebar, titlebar) that aren't
  /// relevant in a standalone document.
  extraCss?: string;
}

// Pure helper: given the document HTML and a list of <style>/<link> CSS
// payloads, build a self-contained HTML document. Exposed for testing.
//
// The body is wrapped in <div id="markdown"> because the app's CSS
// scopes ~65 rules to that ID; without the wrapper, code blocks lose
// their background, lists lose their bullets, tables lose borders, etc.
export function buildStandaloneHtml(
  title: string,
  bodyHtml: string,
  cssBlocks: readonly string[],
  opts: StandaloneOptions = {},
): string {
  const safeTitle = title.replace(/[<>&]/g, (c) => {
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    return "&amp;";
  });
  const styles = cssBlocks
    .filter((c) => c.trim().length > 0)
    .map((c) => `<style>${c}</style>`)
    .join("\n");
  const extraStyle = opts.extraCss
    ? `<style>${opts.extraCss}</style>`
    : "";
  const lang = (opts.lang ?? "en").replace(/[^a-zA-Z-]/g, "");
  const theme = (opts.dataTheme ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  const htmlAttrs = theme
    ? ` lang="${lang}" data-theme="${theme}"`
    : ` lang="${lang}"`;
  return `<!DOCTYPE html>
<html${htmlAttrs}>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
${styles}
${extraStyle}
</head>
<body>
<div id="markdown">
${bodyHtml}
</div>
</body>
</html>`;
}

// CSS that neutralizes app-shell layout rules when the exported HTML is
// viewed standalone. Centers the markdown block in a comfortable column
// and undoes the fixed-positioned sidebar/titlebar/outline overlays.
export const EXPORT_SHELL_RESET = `
html, body {
  margin: 0 !important;
  padding: 0 !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
  display: block !important;
  background: var(--bg, #fff);
  color: var(--text, #1a1a1a);
}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
#sidebar, #outline, #titlebar, #empty-state, #toast, .ctx-menu, .prefs-backdrop, #main { display: none !important; }
#content, #content.empty { all: unset; display: block; }
#markdown {
  display: block !important;
  max-width: 820px;
  margin: 0 auto !important;
  padding: 48px 40px !important;
  height: auto !important;
  overflow: visible !important;
}
`;

// Collect every same-origin stylesheet's text. <style> tags expose their
// .textContent directly; cross-origin sheets are skipped (would throw on
// .cssRules access). Returns deduped CSS blocks in document order.
export function collectInlineCss(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const seenOwners = new WeakSet<Element>();

  for (const styleEl of doc.querySelectorAll("style")) {
    const css = styleEl.textContent ?? "";
    seenOwners.add(styleEl);
    if (css && !seen.has(css)) {
      seen.add(css);
      out.push(css);
    }
  }

  for (const sheet of Array.from(doc.styleSheets)) {
    // Skip stylesheets backed by a <style> we already captured — CSSOM
    // reformatting otherwise produces a near-duplicate entry.
    const owner = sheet.ownerNode as Element | null;
    if (owner && seenOwners.has(owner)) continue;
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin
    }
    if (!rules) continue;
    const text = Array.from(rules)
      .map((r) => r.cssText)
      .join("\n");
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }

  return out;
}

export interface AssetEntry {
  src: string;
  rel: string;
}

// Walk markdownEl for <img>s pointing at the local filesystem and pair
// each with a relative path inside the assets folder. Remote/data URIs
// are left alone (they remain valid in the exported HTML).
export function collectAssets(
  markdownEl: HTMLElement,
  sourceFileDir: string,
): { assets: AssetEntry[]; rewrites: Map<HTMLImageElement, string> } {
  const assets: AssetEntry[] = [];
  const rewrites = new Map<HTMLImageElement, string>();
  const seen = new Map<string, string>();

  for (const img of markdownEl.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    const abs = absoluteLocalPath(src, sourceFileDir);
    if (!abs) continue;
    let rel = seen.get(abs);
    if (!rel) {
      const base = abs.split("/").pop() || "asset";
      // Disambiguate name collisions across different source dirs.
      let candidate = base;
      let n = 1;
      while ([...seen.values()].includes(candidate)) {
        const dot = base.lastIndexOf(".");
        candidate =
          dot > 0
            ? `${base.slice(0, dot)}-${n}${base.slice(dot)}`
            : `${base}-${n}`;
        n++;
      }
      rel = candidate;
      seen.set(abs, rel);
      assets.push({ src: abs, rel });
    }
    rewrites.set(img, rel);
  }
  return { assets, rewrites };
}

function absoluteLocalPath(src: string, baseDir: string): string | null {
  if (!src) return null;
  for (const prefix of [
    "asset://localhost/",
    "http://asset.localhost/",
    "https://asset.localhost/",
  ]) {
    if (src.startsWith(prefix)) {
      try {
        return "/" + decodeURIComponent(src.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  if (src.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(src).pathname);
    } catch {
      return null;
    }
  }
  if (/^(https?:|data:|blob:)/i.test(src)) return null;
  if (src.startsWith("/")) return src;
  return `${baseDir}/${src}`;
}

// Side-effecting: rewrites <img src> in-place so the exported HTML
// references the assets/ folder. Caller should clone the DOM first if
// the live UI shouldn't change.
export function applyAssetRewrites(
  rewrites: Map<HTMLImageElement, string>,
  assetsDirName: string,
): void {
  for (const [img, rel] of rewrites) {
    img.setAttribute("src", `${assetsDirName}/${rel}`);
  }
}

export interface RunExportDeps {
  save: ExportSaveFn;
  invoke: ExportInvoke;
}

// Run an explicit format end-to-end. Returns the chosen output path, or
// null if the user cancelled the dialog.
export async function runExport(
  format: ExportFormat,
  ctx: ExportContext,
  deps: RunExportDeps,
): Promise<string | null> {
  const filter = FORMAT_FILTERS[format];
  const outputPath = await deps.save({
    defaultPath: `${ctx.defaultStem}.${filter.extensions[0]}`,
    filters: [filter],
  });
  if (!outputPath) return null;

  if (format === "md-copy") {
    await deps.invoke("copy_markdown_source", {
      srcPath: ctx.sourcePath,
      outputPath,
    });
    return outputPath;
  }

  if (format === "pdf") {
    // PDF goes through the existing print-mode + WKWebView pipeline.
    // The caller is responsible for toggling print-mode on the body;
    // here we just trigger the backend.
    await deps.invoke("export_pdf", { outputPath });
    return outputPath;
  }

  // HTML formats — clone the DOM so live UI stays untouched.
  const sourceDir = ctx.sourcePath.includes("/")
    ? ctx.sourcePath.slice(0, ctx.sourcePath.lastIndexOf("/"))
    : "";
  const cloned = ctx.markdownEl.cloneNode(true) as HTMLElement;

  const dataTheme =
    document.documentElement.getAttribute("data-theme") ?? undefined;
  const lang = document.documentElement.getAttribute("lang") ?? "en";
  const buildOpts: StandaloneOptions = {
    dataTheme,
    lang,
    extraCss: EXPORT_SHELL_RESET,
  };

  if (format === "html-with-assets") {
    const { assets, rewrites } = collectAssets(cloned, sourceDir);
    // Rewrite in the clone using the assets-dir name derived from the
    // output filename. The backend uses the same derivation rule.
    const stem = outputBasename(outputPath).replace(/\.html$/i, "");
    applyAssetRewrites(rewrites, `${stem}.assets`);
    const css = collectInlineCss(document);
    const html = buildStandaloneHtml(
      ctx.defaultStem,
      cloned.innerHTML,
      css,
      buildOpts,
    );
    const allowedRoots: string[] = [];
    if (ctx.rootPath) allowedRoots.push(ctx.rootPath);
    if (sourceDir) allowedRoots.push(sourceDir);
    await deps.invoke("export_html_with_assets", {
      html,
      assets,
      outputPath,
      allowedRoots,
    });
    return outputPath;
  }

  // Standalone HTML — no asset copy, leave img srcs as-is (they may break
  // on the recipient's machine; document this in the UI tooltip).
  const css = collectInlineCss(document);
  const html = buildStandaloneHtml(
    ctx.defaultStem,
    cloned.innerHTML,
    css,
    buildOpts,
  );
  await deps.invoke("export_html_standalone", { html, outputPath });
  return outputPath;
}

function outputBasename(p: string): string {
  const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return sep >= 0 ? p.slice(sep + 1) : p;
}

// Order shown in the multi-filter "Save As" dialog. Re-exported so the
// renderer doesn't reach into FORMAT_FILTERS directly.
export function formatsInOrder(): Array<{ format: ExportFormat; filter: { name: string; extensions: string[] } }> {
  return FORMAT_ORDER.map((f) => ({ format: f, filter: FORMAT_FILTERS[f] }));
}
