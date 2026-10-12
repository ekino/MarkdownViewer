# Getting Started

## Download

Download the latest `.dmg` from the [Releases](https://github.com/ekino/MarkdownViewer/releases) page. The app is signed and notarized by Apple.

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://rustup.rs/) (stable)
- macOS with Xcode Command Line Tools

### Steps

```bash
# Clone the repo
git clone git@github.com:ekino/MarkdownViewer.git
cd MarkdownViewer

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production (.app + .dmg)
npm run tauri build
```

The built app will be at `src-tauri/target/release/bundle/macos/Markdown Viewer.app`.

## Usage

### GUI

1. Launch the app
2. Click **Open folder** or press **Cmd+O**
3. Select a folder containing `.md` files
4. Browse and read your documentation

### CLI

```bash
# Open a specific folder
mdv ~/my-docs

# Open a single file (loads its parent directory in the sidebar)
mdv ~/my-docs/README.md
```

## Examples

The app includes a built-in **Explore the examples** button on the home screen that loads sample documents showcasing all supported features. These examples cover code highlighting, math, diagrams, alerts, footnotes, tables, and more.
