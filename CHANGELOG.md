# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.9.0) - 2026-05-09

### Added

- In-document full-text search bar in a new custom title bar (macOS Overlay style, native traffic lights preserved)
- Accent-insensitive search by default, with case-sensitive and whole-word toggles via an options popover
- Cmd+F focuses the search input, Cmd+G / Shift+Cmd+G navigate matches, Esc clears the query
- Open files directly by double-clicking them in Finder

### Changed

- PDF, Print and Theme buttons moved from the sidebar header to the new title bar

## [0.8.1](https://github.com/ekino/MarkdownViewer/releases/tag/v0.8.1) - 2026-03-31

### Added

- Local image support in markdown via the Tauri asset protocol
- Screenshot gallery on the documentation site with click-to-zoom (medium-zoom)
- Hero screenshot on the landing page
- Ekino logo in the header, footer and README

### Changed

- Update repository references to `ekino/MarkdownViewer`

### Fixed

- Make medium-zoom work for both the hero and gallery screenshots

## [0.8.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.8.0) - 2026-03-10

### Added

- Open external links in the system browser instead of inside the app

## [0.7.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.7.0) - 2026-02-28

### Added

- Windows build in the CI and release workflows

## [0.6.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.6.0) - 2026-02-17

### Added

- PDF export via native macOS `WKWebView.createPDF` with save dialog
- Open single `.md` files directly via CLI, Finder "Open With", or drag & drop
- macOS file associations for `.md`, `.markdown`, `.mdx` extensions
- Detect file vs folder CLI arguments automatically

## [0.5.1](https://github.com/ekino/MarkdownViewer/releases/tag/v0.5.1) - 2026-02-16

### Fixed

- Replace fixed 500px max-height for Mermaid diagrams with dynamic sizing that fits SVG content (capped at 80vh)

## [0.5.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.5.0) - 2026-02-15

### Added

- Marked plugins: alerts, footnotes, smartypants, extended tables, emoji
- Copy button on code blocks with clipboard feedback
- Image lightbox with Esc/click-outside to close
- Task list checkboxes for GFM support
- Built-in example files with "View examples" button on home screen

### Security

- Sanitize markdown HTML output with DOMPurify to prevent XSS

## [0.4.1](https://github.com/ekino/MarkdownViewer/releases/tag/v0.4.1) - 2026-02-14

### Fixed

- Make notarization non-blocking with 15-minute timeout to handle Apple service delays

## [0.4.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.4.0) - 2026-02-14

### Added

- Apple notarization with `--wait` and stapler staple
- DMG now includes /Applications symlink for drag-and-drop install

## [0.3.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.3.0) - 2026-02-14

### Fixed

- Re-sign app with hardened runtime and timestamp for proper code signing
- Include entitlements.plist for WebKit compatibility

## [0.2.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.2.0) - 2026-02-14

### Changed

- Publish signed DMG immediately, notarize as non-blocking background step

## [0.1.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.1.0) - 2026-02-14

### Added

- Initial release: native macOS Markdown viewer built with Tauri v2
- Folder browsing with directory tree sidebar
- Markdown rendering with syntax highlighting (highlight.js)
- KaTeX math support (inline and display)
- Mermaid diagram rendering
- Outline panel with scroll tracking
- Dark mode following macOS system appearance
- Session persistence (remembers last opened folder)
- CLI support: `mdv ~/docs`
- Native macOS menu with Cmd+O
- CI/CD workflows with GitHub Actions
