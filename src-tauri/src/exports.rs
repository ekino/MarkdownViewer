// HTML / source-copy exports.
//
// PDF export keeps living in lib.rs because it bridges WebKit; this
// module handles the simpler text/file copies. Each command validates
// the output path is writable and (for assets) that every source path
// sits inside an allowed root, so a hostile <img src="../../etc/passwd">
// can't be smuggled into the export folder.

use std::path::{Path, PathBuf};

const MAX_PATH: usize = 4096;
// A standalone HTML doc for a markdown viewer rarely exceeds a few MB
// even with inlined fonts. 64 MiB caps the renderer-side payload at a
// generous ceiling without being weaponizable.
const MAX_HTML_BYTES: usize = 64 * 1024 * 1024;

#[derive(serde::Deserialize)]
pub struct AssetCopy {
    /// Path on disk to read from.
    pub src: String,
    /// Path relative to the assets dir to write to (e.g. "images/foo.png").
    pub rel: String,
}

fn validate_path(p: &str) -> Result<PathBuf, String> {
    if p.is_empty() || p.len() > MAX_PATH {
        return Err("invalid path".into());
    }
    Ok(PathBuf::from(p))
}

// Returns the canonical form of `p` if it lives inside any of the
// `allowed` roots. Used to gate asset copies — `allowed` should be the
// current folder root plus the active document's parent directory.
//
// Refuses symlinks outright: a symlinked source bypasses the
// containment check, because canonicalize() resolves through it and
// the resulting real path can land anywhere the symlink points (e.g.
// a symlink under an opened folder that targets ~/.ssh).
fn assert_inside(p: &Path, allowed: &[PathBuf]) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(p)
        .map_err(|e| format!("stat failed: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("symlinked source rejected: {}", p.display()));
    }
    let canon = std::fs::canonicalize(p).map_err(|e| format!("canonicalize failed: {e}"))?;
    for root in allowed {
        // Each allowed root is itself canonicalized so callers don't
        // have to. A symlinked allowed root resolves to its real
        // target — acceptable: the renderer's responsibility is to
        // pass a root the user actually opened, not its true location.
        if let Ok(root_canon) = std::fs::canonicalize(root) {
            if canon.starts_with(&root_canon) {
                return Ok(canon);
            }
        }
    }
    Err(format!("path outside allowed roots: {}", p.display()))
}

// Conservative allowlist for asset copies. The export feature is
// markdown → HTML; the only legitimate non-text assets in a markdown
// doc are images. This keeps an attacker who controls the markdown
// from sneaking arbitrary files (.env, .pem, .so) into the user's
// chosen output folder under the guise of an <img>.
const ALLOWED_ASSET_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
];

fn assert_asset_extension(p: &Path) -> Result<(), String> {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ALLOWED_ASSET_EXTS.iter().any(|a| *a == ext) {
        Ok(())
    } else {
        Err(format!("asset extension not allowed: {}", p.display()))
    }
}

fn assert_html_extension(p: &Path) -> Result<(), String> {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "html" || ext == "htm" {
        Ok(())
    } else {
        Err(format!("output must be .html: {}", p.display()))
    }
}

#[tauri::command]
pub fn export_html_standalone(html: String, output_path: String) -> Result<(), String> {
    if html.len() > MAX_HTML_BYTES {
        return Err("html too large".into());
    }
    let out = validate_path(&output_path)?;
    // Enforce the extension so an XSS in the renderer can't repurpose
    // this command to drop a .plist into ~/Library/LaunchAgents or any
    // other extension-sensitive location.
    assert_html_extension(&out)?;
    std::fs::write(&out, html).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn export_html_with_assets(
    html: String,
    assets: Vec<AssetCopy>,
    output_path: String,
    allowed_roots: Vec<String>,
) -> Result<(), String> {
    if html.len() > MAX_HTML_BYTES {
        return Err("html too large".into());
    }
    let out = validate_path(&output_path)?;
    assert_html_extension(&out)?;
    let out_dir = out
        .parent()
        .ok_or_else(|| "output_path has no parent".to_string())?;

    // Derive the assets folder: foo.html → foo.assets/
    let stem = out
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid output filename".to_string())?;
    let assets_dir = out_dir.join(format!("{stem}.assets"));
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("create assets dir failed: {e}"))?;

    let allowed: Vec<PathBuf> = allowed_roots.iter().map(PathBuf::from).collect();
    if allowed.is_empty() {
        return Err("no allowed roots provided".into());
    }

    for asset in assets {
        // Reject absolute or traversing rel paths — keep the assets dir
        // strictly self-contained.
        let rel = Path::new(&asset.rel);
        if rel.is_absolute()
            || rel.components().any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("invalid rel path: {}", asset.rel));
        }
        let dest = assets_dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create asset subdir failed: {e}"))?;
        }
        let src = validate_path(&asset.src)?;
        assert_asset_extension(&src)?;
        let src_canon = assert_inside(&src, &allowed)?;
        std::fs::copy(&src_canon, &dest).map_err(|e| {
            format!("copy {} → {}: {e}", src_canon.display(), dest.display())
        })?;
    }

    std::fs::write(&out, html).map_err(|e| format!("write html failed: {e}"))?;
    Ok(())
}

fn assert_markdown_extension(p: &Path) -> Result<(), String> {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "md" || ext == "markdown" || ext == "mdx" {
        Ok(())
    } else {
        Err(format!("output must be .md/.markdown/.mdx: {}", p.display()))
    }
}

#[tauri::command]
pub fn copy_markdown_source(src_path: String, output_path: String) -> Result<(), String> {
    let src = validate_path(&src_path)?;
    let out = validate_path(&output_path)?;
    // Only allow copying files the renderer has explicitly opened as
    // a live document. Without this an XSS in the webview could call
    // copy_markdown_source("/Users/victim/.ssh/id_rsa", "/tmp/leak")
    // and then exfiltrate via share_macos.
    if !crate::is_path_active_doc(&src_path) {
        return Err("source is not a registered active doc".into());
    }
    // Reject symlinks defensively even though is_path_active_doc
    // canonicalizes — the active-doc set may have been registered
    // before a symlink was introduced.
    let src_meta = std::fs::symlink_metadata(&src)
        .map_err(|e| format!("stat failed: {e}"))?;
    if src_meta.file_type().is_symlink() {
        return Err("symlinked source rejected".into());
    }
    // Output must be a markdown file. Keeps the command from being
    // repurposed to drop a copy with an arbitrary extension into a
    // sensitive location.
    assert_markdown_extension(&out)?;
    std::fs::copy(&src, &out).map_err(|e| format!("copy failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn tmpfile(dir: &Path, name: &str, body: &[u8]) -> PathBuf {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(body).unwrap();
        p
    }

    #[test]
    fn standalone_writes_file() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("foo.html");
        export_html_standalone(
            "<html>hi</html>".into(),
            out.to_string_lossy().into(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&out).unwrap(), "<html>hi</html>");
    }

    #[test]
    fn standalone_rejects_oversize_payload() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("big.html");
        let big = "x".repeat(MAX_HTML_BYTES + 1);
        let err = export_html_standalone(big, out.to_string_lossy().into()).unwrap_err();
        assert!(err.contains("too large"));
    }

    #[test]
    fn with_assets_copies_files_inside_root() {
        let work = tempfile::tempdir().unwrap();
        let root = work.path();
        let img = tmpfile(root, "images/foo.png", b"PNG");
        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("doc.html");

        export_html_with_assets(
            "<html></html>".into(),
            vec![AssetCopy {
                src: img.to_string_lossy().into(),
                rel: "images/foo.png".into(),
            }],
            out.to_string_lossy().into(),
            vec![root.to_string_lossy().into()],
        )
        .unwrap();

        let copied = out_dir.path().join("doc.assets/images/foo.png");
        assert_eq!(fs::read(copied).unwrap(), b"PNG");
    }

    #[test]
    fn with_assets_rejects_path_outside_root() {
        let work = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let outside = tmpfile(outside_dir.path(), "secret.png", b"X");
        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("doc.html");

        let err = export_html_with_assets(
            "<html></html>".into(),
            vec![AssetCopy {
                src: outside.to_string_lossy().into(),
                rel: "secret.png".into(),
            }],
            out.to_string_lossy().into(),
            vec![work.path().to_string_lossy().into()],
        )
        .unwrap_err();
        assert!(err.contains("outside allowed roots"), "{err}");
    }

    #[test]
    fn with_assets_rejects_parent_traversal_in_rel() {
        let work = tempfile::tempdir().unwrap();
        let img = tmpfile(work.path(), "ok.png", b"X");
        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("doc.html");

        let err = export_html_with_assets(
            "<html></html>".into(),
            vec![AssetCopy {
                src: img.to_string_lossy().into(),
                rel: "../escape.png".into(),
            }],
            out.to_string_lossy().into(),
            vec![work.path().to_string_lossy().into()],
        )
        .unwrap_err();
        assert!(err.contains("invalid rel path"), "{err}");
    }

    #[test]
    fn with_assets_rejects_symlinked_source() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let work = tempfile::tempdir().unwrap();
            let secret_dir = tempfile::tempdir().unwrap();
            let secret = tmpfile(secret_dir.path(), "id_rsa", b"SECRET");
            // A symlink inside the allowed root that points OUT to the
            // sensitive file — the exact attack H1 covers.
            let symlinked = work.path().join("trap.png");
            symlink(&secret, &symlinked).unwrap();

            let out_dir = tempfile::tempdir().unwrap();
            let out = out_dir.path().join("doc.html");

            let err = export_html_with_assets(
                "<html></html>".into(),
                vec![AssetCopy {
                    src: symlinked.to_string_lossy().into(),
                    rel: "trap.png".into(),
                }],
                out.to_string_lossy().into(),
                vec![work.path().to_string_lossy().into()],
            )
            .unwrap_err();
            assert!(err.contains("symlinked source rejected"), "{err}");
        }
    }

    #[test]
    fn with_assets_rejects_non_image_extension() {
        let work = tempfile::tempdir().unwrap();
        let secret = tmpfile(work.path(), "creds.env", b"AWS_KEY=...");
        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("doc.html");

        let err = export_html_with_assets(
            "<html></html>".into(),
            vec![AssetCopy {
                src: secret.to_string_lossy().into(),
                rel: "creds.env".into(),
            }],
            out.to_string_lossy().into(),
            vec![work.path().to_string_lossy().into()],
        )
        .unwrap_err();
        assert!(err.contains("asset extension not allowed"), "{err}");
    }

    #[test]
    fn copy_source_roundtrips() {
        let d = tempfile::tempdir().unwrap();
        let src = tmpfile(d.path(), "in.md", b"# hi");
        crate::test_register_active_doc(&src);
        let out = d.path().join("out.md");
        copy_markdown_source(src.to_string_lossy().into(), out.to_string_lossy().into())
            .unwrap();
        assert_eq!(fs::read_to_string(out).unwrap(), "# hi");
    }

    #[test]
    fn copy_source_rejects_unregistered() {
        let d = tempfile::tempdir().unwrap();
        let src = tmpfile(d.path(), "unreg.md", b"x");
        // No test_register_active_doc call → should be rejected.
        let out = d.path().join("out.md");
        let err = copy_markdown_source(
            src.to_string_lossy().into(),
            out.to_string_lossy().into(),
        )
        .unwrap_err();
        assert!(err.contains("not a registered active doc"), "{err}");
    }

    #[test]
    fn copy_source_rejects_non_markdown_output() {
        let d = tempfile::tempdir().unwrap();
        let src = tmpfile(d.path(), "ok.md", b"x");
        crate::test_register_active_doc(&src);
        let out = d.path().join("malicious.plist");
        let err = copy_markdown_source(
            src.to_string_lossy().into(),
            out.to_string_lossy().into(),
        )
        .unwrap_err();
        assert!(err.contains("must be .md"), "{err}");
    }

    #[test]
    fn standalone_rejects_non_html_output() {
        let d = tempfile::tempdir().unwrap();
        let err = export_html_standalone(
            "<html></html>".into(),
            d.path().join("evil.plist").to_string_lossy().into(),
        )
        .unwrap_err();
        assert!(err.contains("must be .html"), "{err}");
    }
}
