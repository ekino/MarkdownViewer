// Recursive markdown-aware file watcher.
//
// One active watcher per window. start_watch replaces any existing
// watcher for the calling window so a folder switch doesn't leak
// handles. Events are debounced and filtered: a flurry of saves only
// fires one `fs-change` emission, and changes that have no effect on
// the sidebar (a .png save, a swap file rename) are dropped.

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const DEBOUNCE_MS: u64 = 200;

#[derive(Default)]
pub struct WatcherRegistry {
    // Keyed by webview window label. We hold the Debouncer to keep the
    // watcher alive; dropping it tears down the OS-level watch.
    watchers: Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>,
}

#[derive(Serialize, Clone)]
struct FsChange {
    paths: Vec<String>,
}

fn is_markdown(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()),
        Some(ref ext) if ext == "md" || ext == "markdown" || ext == "mdx"
    )
}

// A change is relevant if it touches a markdown file, OR a directory
// (rename/create/delete) since that affects the tree shape, OR a path
// we can't classify (deleted file — metadata is gone — we still need
// to invalidate any cached tree state on the renderer side).
fn is_relevant(p: &Path) -> bool {
    if is_markdown(p) {
        return true;
    }
    match std::fs::metadata(p) {
        Ok(m) => m.is_dir(),
        Err(_) => true,
    }
}

#[tauri::command]
pub fn start_watch<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
    root: String,
) -> Result<(), String> {
    if root.is_empty() || root.len() > 4096 {
        return Err("invalid root".into());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("root is not a directory".into());
    }

    let label = webview.window().label().to_string();
    let app_for_events = app.clone();
    let label_for_events = label.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut paths: Vec<String> = events
                .into_iter()
                .map(|e| e.path)
                .filter(|p| is_relevant(p))
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if paths.is_empty() {
                return;
            }
            // De-dupe identical paths emitted by separate event sources.
            paths.sort();
            paths.dedup();
            if let Some(win) = app_for_events.get_webview_window(&label_for_events) {
                let _ = win.emit("fs-change", FsChange { paths });
            }
        },
    )
    .map_err(|e| format!("watcher init failed: {e}"))?;

    debouncer
        .watcher()
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("watch failed: {e}"))?;

    let registry = app.state::<WatcherRegistry>();
    if let Ok(mut map) = registry.watchers.lock() {
        // Replacing drops the old Debouncer → old watch is released.
        map.insert(label, debouncer);
    }
    Ok(())
}

#[tauri::command]
pub fn stop_watch<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
) -> Result<(), String> {
    let label = webview.window().label().to_string();
    let registry = app.state::<WatcherRegistry>();
    if let Ok(mut map) = registry.watchers.lock() {
        map.remove(&label);
    }
    Ok(())
}

// Called from the run-event loop on window close so we don't leak the
// OS watch when the user shuts the window without explicitly stopping.
pub fn drop_watcher_for_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(registry) = app.try_state::<WatcherRegistry>() {
        if let Ok(mut map) = registry.watchers.lock() {
            map.remove(label);
        }
    }
}
