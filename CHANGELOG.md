# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.12.1](https://github.com/ekino/MarkdownViewer/releases/tag/v0.12.1) - 2026-10-25

### Changed

- The docked sidebar runs the full height of the window, traffic lights included; the title bar covers the content only
- Preferences and the light/dark switch move to the foot of the docked sidebar; the title bar keeps them in a narrow window
- With the sidebar docked, search folds into a button when the title bar runs short of room; ⌘F unfolds it

### Fixed

- In a narrow window (860px or less), the sidebar button showed only the backdrop and left the sidebar off screen

## [0.12.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.12.0) - 2026-10-16

### Added

- Home screen at launch: pick up the last document where you left it, reopen a recent folder or file, or drop one on the window. Preferences › General can restore the last folder at launch instead (FR + EN)
- Per-window navigation history, with a native Go menu: Back ⌘[, Forward ⌘], Home ⇧⌘H (the folder stays open), Enclosing Folder ⌘↑ and Close Folder ⇧⌘W. Items are disabled when the frontmost window cannot take that step
- Folder view: an overview of the folder's documents and subfolders, with a clickable breadcrumb
- `.markdown` and `.mdx` files are recognised alongside `.md`, in any letter case
- Speakino Light and Speakino Dark document themes, bringing the built-in total to ten
- With *Follow macOS appearance* on, one theme for light mode and one for dark mode; the title bar toggle switches between the two. Existing settings are migrated

### Changed

- Speakino-style window chrome: a 52px title bar that clears the traffic lights (and reflows in full screen), keycap buttons, light and dark palettes, and a new app icon
- Preferences redesigned as a settings sheet with three tabs (General, Reading, Themes), settings written as sentences with inline selects, and theme tiles per mode (FR + EN)
- Settings are saved through one write queue; theme choices write only the keys that changed and retry keys whose last write failed
- Closing a folder forgets it, so it is not reopened at the next launch

### Fixed

- Links and images whose file name is percent-encoded (`My%20Guide.md`) now open the right file

## [0.11.1](https://github.com/ekino/MarkdownViewer/releases/tag/v0.11.1) - 2026-08-13

### Added

- General preference for what opening a document from Finder does when a document is already open: hand it to a new window (default, matching macOS document viewers) or replace the current window's content. A window still on the welcome screen is reused either way, so choosing "new window" never leaves an empty window behind (FR + EN)

### Fixed

- Open documents from folders outside the home directory. Since 0.11.0 the sidebar listed files under `/tmp`, `/Volumes` or a repo cloned outside home, but selecting one did nothing: the listing and the read did not share the same access rule. Reads are now confined to the folder you opened — the access you actually granted — which also stops a crafted relative link from escaping it
- Show a message when a document cannot be opened. The failure was logged to the console only, so an unopenable file looked like an unresponsive click (FR + EN)

## [0.11.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.11.0) - 2026-08-13

### Added

- Native File and View menus matching standard macOS apps: File (Open File… ⌘O, Open Folder… ⇧⌘O, Open Recent ▸, Print… ⌘P, Export as PDF… ⇧⌘S, Close Window) and View (Toggle Dark Mode)
- Open Recent submenu, dynamically populated from the last 10 opened documents (deduped, most-recent-first), recorded on top-level opens (picker, file association, CLI, restore)
- In-memory document cache keyed by path + mtime so re-opening a document is instant, without serving stale content after an external edit
- Loading spinner (shown after a 150ms delay to avoid flashing on fast reads) and a one-time dismissible notice when an uncached read exceeds 600ms, explaining the likely cloud-sync cause (FR + EN)
- Debug HUD (⌘/Ctrl+Shift+D) showing live FPS and per-phase document-open timings (ipc, read, parse, images, mermaid, dom, outline, total) with click-to-copy
- Multi-window support: File › New Window (⌘N) opens an empty window and File › Open Folder in New Window… (⇧⌘N) opens a picked folder in its own window, so two sets of docs can be read side by side
- Native Window menu listing every open window (checked on the frontmost, select to bring forward), with windows titled after the document or folder they show
- Window arrangement commands: Fill, Center, Move & Resize (halves, quarters, Return to Previous Size) and Bring All to Front

### Changed

- Documents are read through a dedicated async Rust command (`read_document`, confined to home/resource dirs with canonicalization) instead of the fs plugin, keeping slow reads off the UI thread — fixes multi-second freezes when opening cloud-synced (e.g. OneDrive on-demand) files
- Menu commands now target the frontmost window instead of broadcasting to every window, so ⌘F no longer focuses several search fields and Open Folder… no longer raises several pickers

### Fixed

- Fix the whole window becoming unresponsive — no clicks, no scrolling, no file selection — after using Preferences. A modal backdrop could be left displayed while fully transparent, covering the window and swallowing every pointer event with no way to dismiss it. Transparent overlays are now click-through and removed from the tab order and the accessibility tree, so no blocking state can survive a frame or timer callback that never runs (reported on 0.10.0)
- Modal dialogs no longer rely on an animation frame to become visible, so they still open correctly when the window is occluded and WebKit suspends deferred callbacks
- Reopening Preferences during the closing fade no longer hides the freshly reopened panel or resets its state underneath the user
- Stop lingering search highlights when switching documents (reset now reads the live input value) and when clearing the last character (1→0) on the WKWebView CSS Custom Highlight path

## [0.10.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.10.0) - 2026-07-01

### Added

- Native Preferences window opened from the menu bar (MarkdownViewer › Preferences…, ⌘,) organized in General, Fonts and Appearance tabs
- General tab: interface language (French / English, auto-detected from the system locale on first launch) and outline panel visibility (Auto / Always / Hidden)
- Fonts tab: document text size presets (Small / Medium / Large) plus advanced typography (body/code font pickers from installed system fonts, weight, exact pixel size, one-click reset)
- Appearance tab: 8 predefined themes (Light, Dark, GitHub, Dracula, Solarized Light/Dark, Nord, Sepia) shown as preview tiles, "Follow system" light/dark pairing, and an in-app visual theme editor with live preview
- Create, duplicate, edit, import (JSON) and reveal-in-Finder for custom themes, stored as JSON in the app support directory and reloaded at startup
- Full French / English translations applied via `data-i18n` attributes with English fallback
- Native macOS Edit menu (Undo, Redo, Cut, Copy, Paste, Select All) so system editing shortcuts work in text inputs, plus a Find item (⌘F) that focuses the search field

### Changed

- Destructive theme-deletion confirmation uses a styled in-app modal instead of the native blocking `confirm()`
- Closing Preferences resets transient state (active tab, editor, scroll) so each reopen lands on a clean view

### Fixed

- Dragging the custom title bar now moves the window (granted `core:window:allow-start-dragging`), matching native macOS behavior
- Clearing the search (including the native `<input type="search">` clear button in WKWebView) now removes stale highlights immediately, cancelling any pending debounced query

### Accessibility

- Native focus trap on every modal (Preferences, theme editor, image lightbox, mermaid fullscreen, confirm dialog) with Tab / Shift+Tab cycling, Escape to close and focus restoration
- Preferences tabs follow the ARIA tabs pattern (roving focus, Left/Right/Home/End, `aria-selected` kept in sync)

## [0.9.0](https://github.com/ekino/MarkdownViewer/releases/tag/v0.9.0) - 2026-05-09

### Added

- In-document full-text search bar in a new custom title bar (macOS Overlay style, native traffic lights preserved)
- Accent-insensitive search by default, with case-sensitive and whole-word toggles via an options popover
- Cmd+F focuses the search input, Cmd+G / Shift+Cmd+G navigate matches, Esc clears the query
- Open files directly by double-clicking them in Finder

### Changed

- PDF, Print and Theme buttons moved from the sidebar header to the new title bar
- Title bar reserves the traffic-lights area via `env(titlebar-area-x)` instead of a hardcoded 80px offset
- Use a buffered pending-open slot for cold-start file association (no more 500ms timing hack); on hot-start, emit directly without re-buffering

### Fixed

- Search popover closes with Escape and exposes `aria-haspopup` / `aria-expanded` for assistive tech
- Search navigation (next/prev) updates only the current-match highlight instead of rebuilding all highlights

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
