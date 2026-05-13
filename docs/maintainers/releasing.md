# Releasing & Signing

Maintainer-facing runbook for cutting Markdown Viewer releases. Users do not need to read this — see [Auto-updates](../guide/auto-updates.md) for the user-facing description.

## Trust model recap

There are two independent signatures on every release:

1. **Apple Developer ID + notarization** — gates first install via macOS Gatekeeper. Configured via the `APPLE_*` GitHub secrets (existing). Not covered here in depth.
2. **Tauri Ed25519 updater signature** — gates every subsequent auto-update. Configured via the `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub secrets (this document).

Losing or rotating one does not affect the other.

---

## One-time setup

These steps are done once by the maintainer responsible for releases. They must be done **before** the first release that ships the auto-updater.

### 1. Generate the Tauri updater keypair

On your local machine (not in CI, not on a shared host):

```sh
npm run updater:keygen
```

(Equivalent to `npx tauri signer generate -w ~/.tauri/mdv-updater.key`.)

You will be prompted for a password. Use a strong, randomly-generated password (e.g. from a password manager). **Do not skip the password** — the password is what protects the key if the GitHub secret is ever exfiltrated.

This produces two files:

- `~/.tauri/mdv-updater.key` — the **private key** (password-protected).
- `~/.tauri/mdv-updater.key.pub` — the **public key**.

### 2. Back up the master copy of the private key

The GitHub Actions secret is a *copy* of the private key, not the authoritative source. Store the authoritative copy somewhere durable and offline:

- Recommended: a 1Password vault entry containing both the `.key` file and the password, stored under the maintainer's account.
- Acceptable: an encrypted USB drive kept in a physically secure location.
- **Not acceptable:** the repo, a developer laptop alone, an unencrypted cloud drive, plaintext in a password manager note.

### 3. Embed the public key in the app

Open `src-tauri/tauri.conf.json` and replace the `PUBKEY_PLACEHOLDER_REPLACE_BEFORE_RELEASE` value under `plugins.updater.pubkey` with the contents of `~/.tauri/mdv-updater.key.pub` (a single base64 line — keep it on one line, no quotes inside). Use `npm run updater:pubkey` to print it.

Commit and push this change. **It is safe to publish the public key.** Anyone can verify a signature against it; only the private key can produce one.

### 4. Create the GitHub Environment

In the repo settings (Settings → Environments), create an environment named `production-release` with:

- **Required reviewers:** at minimum, the maintainer who owns the signing key. This adds a manual approval step before any release build can read the signing secrets.
- **Deployment branches:** restrict to tags matching `v*` only.

### 5. Add the GitHub secrets

In the `production-release` environment (not at the repo or org level), add:

- `TAURI_SIGNING_PRIVATE_KEY` — paste the entire contents of `~/.tauri/mdv-updater.key` (including the BEGIN/END markers if present).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set in step 1.

Both must be scoped to the environment, not the repo, so that workflows running on non-`v*` branches cannot read them.

### 6. Verify

Push a no-op tag (e.g. `v0.9.1-rc1`) and confirm the release workflow:

- Requires your manual approval to proceed past the build step.
- Produces `latest.json`, `.app.tar.gz`, `.sig`, `.nsis.zip`, and `.sig` artifacts.
- Uploads them as release assets alongside the existing DMG/MSI/EXE.

Delete the test tag and release after verification.

---

## Cutting a release

For every subsequent release:

### 1. Version bumps

Update the version in all three files to the new semver value:

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `[package].version`

The three must match. The release workflow does not enforce this — a mismatch will produce an incorrect `latest.json` and silently break auto-updates.

### 2. Changelog

Update `CHANGELOG.md`. The GitHub release body is generated automatically by `softprops/action-gh-release`, but the **What's New** screen in the app pulls the release body from the GitHub API — so make sure the release notes are user-readable, not a raw commit log.

### 3. Tag and push

```sh
git tag v0.10.0
git push origin v0.10.0
```

This triggers `release.yml`.

### 4. Approve the deployment

The build job will pause at the `production-release` environment gate, waiting for your approval. Approve in the GitHub Actions UI.

### 5. Verify the release

After the workflow finishes:

- Check the published release on GitHub has all expected assets: `Markdown-Viewer.dmg`, `*.msi`, `*.exe`, `Markdown-Viewer.app.tar.gz`, `Markdown-Viewer.app.tar.gz.sig`, `*.nsis.zip`, `*.nsis.zip.sig`, and `latest.json`.
- Open `latest.json` and confirm the `version` field matches the tag and the `signature` fields are populated (not empty strings).
- On a Mac with the previous version installed, launch the app and confirm the update banner appears.
- Click **Install Now** and confirm it downloads, replaces, and relaunches cleanly.

---

## Manual signature verification

To independently verify a release's signature against the public key (e.g. for a security audit):

```sh
# Download the artifact and its .sig file from the release page, then:
npx tauri signer verify \
  --key ~/.tauri/mdv-updater.key.pub \
  --sig Markdown-Viewer.app.tar.gz.sig \
  Markdown-Viewer.app.tar.gz
```

A `Signature is valid` output confirms the artifact was signed by the holder of the private key.

---

## Key rotation runbook

Rotate the key proactively every 1–2 years, or immediately on suspicion of compromise (see Incident Response below).

The challenge: users on the old version can only update to a release signed by the **old** key. If you cut a release signed only by the new key, those users are stranded — they'll need to manually download and reinstall a fresh DMG.

The solution is a **transitional release** that the old version trusts:

### Step 1 — Generate the new key

Same as one-time setup steps 1–2. Keep both old and new key files for now.

### Step 2 — Ship a transitional release signed by the OLD key

This release contains the new pubkey embedded in the binary but is still signed by the old key. Procedure:

1. Update `src-tauri/tauri.conf.json` to embed the **new** public key.
2. Keep the **old** private key in `TAURI_SIGNING_PRIVATE_KEY` for this release.
3. Tag and release as normal (e.g. `v0.10.0`).

Users on the previous version verify this update against the **old** pubkey (which is still in their installed app), accept it, install it, and the newly-installed binary now contains the **new** pubkey.

### Step 3 — Swap the GitHub secret

Replace `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the new key + password. From now on, all releases are signed by the new key.

### Step 4 — Cut a follow-up release

Tag and release `v0.10.1` (or whatever comes next). Users on `v0.10.0` will verify this against the **new** pubkey (which they got in step 2) and accept it. Rotation complete.

### Step 5 — Retire the old key

After confirming a meaningful fraction of users are on the post-rotation version (give it a few weeks), securely destroy the old private key file. The old key is no longer used for anything.

---

## Incident response — suspected key compromise

If you have any reason to believe the private key has leaked (e.g. the GitHub secret was viewed by an unauthorized party, a maintainer laptop was stolen, an offline backup was lost):

1. **Treat the key as compromised.** An attacker with the key can sign arbitrary binaries that all current users will trust and install via the auto-updater.
2. **Generate a new keypair immediately** (rotation step 1).
3. **Pause releases** until rotation completes — do not cut any new release signed by the compromised key.
4. **Cut the transitional release** signed by the compromised key (rotation step 2). This is the unavoidable last use of that key — users need it to migrate forward.
5. **Swap the secret** (step 3) and **cut the follow-up release** (step 4).
6. **Publish a GitHub Security Advisory.** Disclose the compromise, point users at the post-rotation release, and warn that users who fall behind cannot be protected by the auto-updater alone — they may need to manually download a DMG signed by the new key from a known-good location.
7. **Audit access** to the GitHub Environment, the offline key backup, and any account that had access to either. Rotate associated credentials (GitHub PATs, 1Password access, etc.) as appropriate.
8. **Post-mortem.** Document how the leak happened and update this runbook with mitigations.

There is no cryptographic revocation. A binary signed by the leaked key remains technically valid forever; the only defense is moving users forward to a post-rotation version.

---

## Things not to do

### Do not republish a release with the same version number

The auto-updater identifies releases by version string. If a user clicks "Remind Me Later" on `v0.10.0` and you then delete and republish `v0.10.0` with a fixed binary, that user will never see the prompt again — they'll be stuck on the old version.

If you need to ship a corrected build after a release goes out, **bump the version** (`v0.10.1`) even if the user-visible change is zero. Patch-level bumps are cheap; lost users on a broken release are not.

The renderer-side `lastDismissedUpdateVersion` store key is intentionally keyed on the version string alone — it's the contract that "version X means the same binary forever."

### Do not delete a published release tag

Tags are referenced from the auto-updater manifest (`latest.json` points at `releases/download/${TAG}/...`). Deleting a tag breaks the download URLs for anyone who hasn't pulled the manifest yet. Mark old releases as "pre-release" if you need to retract them, but leave the tag in place.

### Do not edit a release's `latest.json` after publication

If the manifest needs fixing, cut a new patch release. Editing assets on a published release can race against in-flight auto-update checks and leave users in inconsistent states.

## Troubleshooting

### `latest.json` 404 on first release after enabling the updater

Expected. The endpoint URL points at `releases/latest/download/latest.json` — until the *first* release with the updater enabled is published, that file doesn't exist. The app handles this gracefully (silent no-op).

### Notarize step times out

The macOS notarization step has a 15-minute timeout. Apple's notarization service occasionally has multi-hour queues. The workflow uses `continue-on-error: true` so a timeout doesn't fail the whole release, but the resulting build will not be stapled and Gatekeeper will show a "developer not verified" warning on first launch.

If this happens: re-run the failed job after Apple's service recovers, or staple manually with `xcrun stapler staple` on the DMG and re-upload.

### Signature mismatch on install

If users report the installer refuses an update with a signature error, the most likely cause is that the `.app.tar.gz` was produced **before** notarization rather than **after**. The release workflow is structured to tar the post-notarize bundle for exactly this reason — do not move the tar step earlier.

### Universal binary not produced

The macOS build uses `--target universal-apple-darwin`, which requires both `aarch64-apple-darwin` and `x86_64-apple-darwin` Rust targets to be installed in CI. If you see a per-arch build instead, check that the toolchain install step in `release.yml` includes both targets.
