// Recursive markdown-only directory scan.
//
// The renderer's sidebar tree only ever shows files that the viewer can
// open, plus the directories needed to reach them. Doing the filter here
// (in Rust) avoids hundreds of JS↔IPC round-trips for a large repo and
// also lets us enforce hard caps so a user who accidentally points at
// $HOME doesn't freeze the app.

use serde::Serialize;
use std::path::{Path, PathBuf};

// Caps tuned for realistic doc folders. A typical project has a few
// hundred markdown files at most; 50k nodes is ~2 orders of magnitude
// of headroom while still bounding worst-case work and serialization
// size (each node ≈ 200 bytes JSON → ~10 MB ceiling).
const MAX_DEPTH: usize = 15;
const MAX_NODES: usize = 50_000;
// Independent cap on entries *visited* during the scan, not just those
// kept in the output tree. Pruned-empty dirs (e.g. node_modules) don't
// bump MAX_NODES because they never enter the output, so a directory
// bomb of millions of empty subdirs could stall the scan indefinitely.
// This second counter bounds total work regardless of pruning.
const MAX_VISITED: usize = MAX_NODES * 4;

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TreeNode {
    File {
        name: String,
        path: String,
    },
    Dir {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
}

#[derive(Serialize, Debug, Clone)]
pub struct ScanResult {
    pub root: Option<TreeNode>,
    // True iff we hit MAX_DEPTH or MAX_NODES — caller surfaces a toast so
    // the user knows the listing is incomplete. We still return the
    // truncated tree rather than an empty one so something is shown.
    pub truncated: bool,
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()),
        Some(ref ext) if ext == "md" || ext == "markdown" || ext == "mdx"
    )
}

pub fn scan(root: &Path) -> std::io::Result<ScanResult> {
    let mut node_count = 0usize;
    let mut visited = 0usize;
    let mut truncated = false;
    let root_node = build_dir(root, 0, &mut node_count, &mut visited, &mut truncated)?;
    // Prune the root: if it contains no markdown anywhere, return None
    // so the renderer can show an "(empty)" state instead of an unused
    // top-level entry.
    let root = match root_node {
        Some(TreeNode::Dir { children, .. }) if children.is_empty() => None,
        other => other,
    };
    Ok(ScanResult { root, truncated })
}

fn build_dir(
    dir: &Path,
    depth: usize,
    node_count: &mut usize,
    visited: &mut usize,
    truncated: &mut bool,
) -> std::io::Result<Option<TreeNode>> {
    if depth > MAX_DEPTH {
        *truncated = true;
        return Ok(None);
    }
    if *node_count >= MAX_NODES || *visited >= MAX_VISITED {
        *truncated = true;
        return Ok(None);
    }

    let mut children: Vec<TreeNode> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        // Permission denied / unreadable — treat as empty rather than
        // failing the whole scan.
        Err(_) => return Ok(None),
    };

    let mut collected: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        collected.push(entry.path());
    }
    // Stable, case-insensitive ordering. Sidebar UX depends on this.
    collected.sort_by(|a, b| {
        a.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase(),
            )
    });

    for path in collected {
        *visited += 1;
        if *node_count >= MAX_NODES || *visited >= MAX_VISITED {
            *truncated = true;
            break;
        }
        // Resolve metadata once and skip symlinks: chasing them risks
        // cycles and hangs (named pipes, /dev/zero, network mounts).
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Hide dotfiles/dirs by convention (.git, .DS_Store, etc.).
        if name.starts_with('.') {
            continue;
        }
        let path_str = path.to_string_lossy().to_string();

        if meta.is_dir() {
            if let Some(node) = build_dir(&path, depth + 1, node_count, visited, truncated)? {
                // Only include a directory if it actually has markdown
                // somewhere underneath (filtered out otherwise).
                if let TreeNode::Dir { children: sub, .. } = &node {
                    if !sub.is_empty() {
                        *node_count += 1;
                        children.push(node);
                    }
                }
            }
        } else if meta.is_file() && is_markdown(&path) {
            *node_count += 1;
            children.push(TreeNode::File {
                name,
                path: path_str,
            });
        }
    }

    Ok(Some(TreeNode::Dir {
        name: dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        path: dir.to_string_lossy().to_string(),
        children,
    }))
}

// Async so the recursive scan runs on the blocking pool instead of
// blocking the IPC worker thread. A large tree on a slow filesystem
// (network mount, iCloud Drive) would otherwise starve other commands.
#[tauri::command]
pub async fn scan_markdown_tree(root: String) -> Result<ScanResult, String> {
    if root.is_empty() || root.len() > 4096 {
        return Err("invalid root".into());
    }
    tokio::task::spawn_blocking(move || {
        scan(Path::new(&root)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn touch(p: &Path) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(p).unwrap();
        f.write_all(b"# hi").unwrap();
    }

    #[test]
    fn includes_markdown_files_only() {
        let d = tmp();
        let root = d.path();
        touch(&root.join("a.md"));
        touch(&root.join("b.txt"));
        touch(&root.join("c.markdown"));
        touch(&root.join("d.mdx"));

        let out = scan(root).unwrap();
        let TreeNode::Dir { children, .. } = out.root.unwrap() else {
            panic!("expected dir");
        };
        let names: Vec<&str> = children
            .iter()
            .filter_map(|c| match c {
                TreeNode::File { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(names, vec!["a.md", "c.markdown", "d.mdx"]);
    }

    #[test]
    fn prunes_dirs_with_no_markdown() {
        let d = tmp();
        let root = d.path();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("images")).unwrap();
        touch(&root.join("images/pic.png"));
        touch(&root.join("docs/intro.md"));

        let out = scan(root).unwrap();
        let TreeNode::Dir { children, .. } = out.root.unwrap() else {
            panic!();
        };
        let dir_names: Vec<&str> = children
            .iter()
            .filter_map(|c| match c {
                TreeNode::Dir { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(dir_names, vec!["docs"]);
    }

    #[test]
    fn skips_dotfiles_and_dot_dirs() {
        let d = tmp();
        let root = d.path();
        touch(&root.join(".hidden.md"));
        touch(&root.join(".git/HEAD"));
        touch(&root.join("visible.md"));

        let out = scan(root).unwrap();
        let TreeNode::Dir { children, .. } = out.root.unwrap() else {
            panic!();
        };
        assert_eq!(children.len(), 1);
        match &children[0] {
            TreeNode::File { name, .. } => assert_eq!(name, "visible.md"),
            _ => panic!(),
        }
    }

    #[test]
    fn root_is_none_when_no_markdown_anywhere() {
        let d = tmp();
        touch(&d.path().join("a.txt"));
        let out = scan(d.path()).unwrap();
        assert!(out.root.is_none());
    }

    #[test]
    fn sort_is_case_insensitive() {
        let d = tmp();
        let root = d.path();
        touch(&root.join("Zebra.md"));
        touch(&root.join("apple.md"));
        touch(&root.join("Banana.md"));

        let out = scan(root).unwrap();
        let TreeNode::Dir { children, .. } = out.root.unwrap() else {
            panic!();
        };
        let names: Vec<&str> = children
            .iter()
            .filter_map(|c| match c {
                TreeNode::File { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(names, vec!["apple.md", "Banana.md", "Zebra.md"]);
    }
}
