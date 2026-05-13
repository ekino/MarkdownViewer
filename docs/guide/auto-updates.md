# Auto-updates

Markdown Viewer ships with a built-in updater so you always run the latest signed release without having to re-download a DMG or installer.

## How it works

When the app starts, it makes a single HTTPS request to GitHub Releases to read a small manifest file (`latest.json`). The manifest describes the most recent release: its version, the download URL for your platform, and a cryptographic signature.

If the manifest advertises a version newer than the one you're running, a banner appears at the top of the window with three actions:

- **Install Now** — downloads the new version, verifies its signature, replaces the running app, and relaunches.
- **Remind Me Later** — dismisses the banner for this session. It will reappear the next time you launch the app if the update is still available.
- **View Release Notes** — opens the release notes for the new version on GitHub.

After an update installs, the next launch shows a **What's New** screen rendered from that release's GitHub notes. You can re-open it any time from **Help → What's New…**.

## Manual check

To force a check at any time:

- Click **Markdown Viewer → Check for Updates…** in the menu bar.

If there's no update available, you'll get a brief "You're up to date" confirmation.

## Turning auto-checks off

If you'd rather not have the app reach out on every launch:

1. Open **Preferences** (`⌘,`).
2. Go to the **Updates** tab.
3. Uncheck **Check for updates automatically**.

With auto-checks off, the menu item still works whenever you want to check manually.

## Privacy

The update check is a single HTTPS GET to `github.com`. The request:

- Sends only what any HTTPS request would send (your IP, your User-Agent).
- Does **not** send your file paths, document contents, settings, or any identifier tied to your app installation.
- Happens once on launch (and again whenever you click *Check for Updates…*).

If you disable auto-checks, no network request is made at startup.

## Security

Every update download is signed with an Ed25519 key held by the project maintainer. The matching public key is compiled into your installed app, and the app refuses to install any update whose signature doesn't verify. Even if an attacker intercepted the manifest, they couldn't ship you a malicious binary without also possessing the signing key.

See the [Security Policy](https://github.com/ekino/MarkdownViewer/blob/main/SECURITY.md#auto-update-security-model) for the full threat model.
