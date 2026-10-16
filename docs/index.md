---
layout: home

hero:
  name: Markdown Viewer
  text: Native macOS documentation viewer
  tagline: Browse folders, render Markdown beautifully, navigate between documents — all in a fast, native app.
  image:
    src: /screenshots/mixed.png
    alt: Markdown Viewer showing mixed content with code and math
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Download
      link: https://github.com/ekino/MarkdownViewer/releases

features:
  - title: GitHub-Flavored Markdown
    details: Full GFM support with tables, task lists, strikethrough, alerts, footnotes, and more.
  - title: Math & Diagrams
    details: KaTeX math expressions and Mermaid diagrams rendered inline with fullscreen view.
  - title: Syntax Highlighting
    details: Code blocks with automatic language detection powered by highlight.js.
  - title: Themes
    details: Ten built-in themes plus your own, with one for light mode and one for dark mode that follow the macOS appearance.
  - title: Secure Rendering
    details: All HTML sanitized through DOMPurify — no XSS, no script injection, no iframe attacks.
  - title: Native Performance
    details: Built with Tauri v2 and Rust for a lightweight, fast macOS experience.
---

<div class="screenshot-gallery">
  <div class="main-screenshot">
    <img src="/screenshots/mixed.png" alt="Mixed content with code and math">
  </div>
  <div class="screenshot-row">
    <img src="/screenshots/mermaid.png" alt="Mermaid diagrams">
    <img src="/screenshots/math.png" alt="KaTeX math formulas">
  </div>
  <div class="screenshot-row">
    <img src="/screenshots/images.png" alt="Image lightbox demo">
  </div>
</div>
