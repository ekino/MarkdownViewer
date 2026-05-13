mod exports;
mod fs_tree;
mod menu;
#[cfg(target_os = "macos")]
mod share_macos;
mod watcher;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PendingOpen {
    File { path: String },
    Folder { path: String },
}

// Global slot — available from process start, so `RunEvent::Opened` can write
// safely even if it fires before `setup` finishes (which can happen on macOS
// cold-start via Apple Events).
static PENDING_OPEN: OnceLock<Mutex<Option<PendingOpen>>> = OnceLock::new();

fn pending_slot() -> &'static Mutex<Option<PendingOpen>> {
    PENDING_OPEN.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
fn get_pending_open() -> Option<PendingOpen> {
    pending_slot().lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn print_webview(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

// Renderer-shaped payload for menu-open-recent so the JS side doesn't have
// to re-resolve the index back to the recents store.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum RecentEventPayload {
    File { path: String },
    Folder { path: String },
}

// Currently-displayed recents shadow copy. The menu is rebuilt on every
// update_menu_recents call, so we keep the items here to translate index
// → (kind, path) when the user clicks an "Open Recent" entry without
// round-tripping back to the renderer.
static MENU_RECENTS: OnceLock<Mutex<Vec<menu::RecentMenuItem>>> = OnceLock::new();

fn menu_recents_slot() -> &'static Mutex<Vec<menu::RecentMenuItem>> {
    MENU_RECENTS.get_or_init(|| Mutex::new(Vec::new()))
}

// Renderer keeps recents capped at 10 (see src/recents.ts MAX_RECENTS),
// but settings.json is user-writable so a malformed/hostile entry could
// in theory feed the backend a giant list. Defend in depth.
const MAX_MENU_ITEMS: usize = 32;
const MAX_MENU_LABEL: usize = 512;
const MAX_MENU_PATH: usize = 4096;

#[tauri::command]
fn update_menu_state(
    app: tauri::AppHandle,
    items: Vec<menu::RecentMenuItem>,
    folder_open: bool,
    file_open: bool,
) -> Result<(), String> {
    if items.len() > MAX_MENU_ITEMS {
        return Err("too many menu items".into());
    }
    for it in &items {
        if it.path.len() > MAX_MENU_PATH {
            return Err("menu item path too long".into());
        }
        if it.label.len() > MAX_MENU_LABEL {
            return Err("menu item label too long".into());
        }
    }
    let menu = menu::rebuild(&app, &items, folder_open, file_open).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    if let Ok(mut slot) = menu_recents_slot().lock() {
        *slot = items;
    }
    Ok(())
}

// Currently-set folder root, mirrored from the renderer. Used to gate
// reveal_in_finder so we don't let an XSS-injected caller surface
// arbitrary paths in Finder. Stored as a canonicalized PathBuf so
// Path::starts_with handles the case-insensitive-volume and Windows
// separator concerns string prefix comparisons can't.
static CURRENT_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn current_root_slot() -> &'static Mutex<Option<PathBuf>> {
    CURRENT_ROOT.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
fn register_current_root(path: Option<String>) -> Result<(), String> {
    let canon = match path {
        None => None,
        Some(p) => {
            if p.is_empty() || p.len() > 4096 {
                return Err("invalid root".into());
            }
            Some(std::fs::canonicalize(&p).map_err(|e| format!("canonicalize failed: {e}"))?)
        }
    };
    if let Ok(mut slot) = current_root_slot().lock() {
        *slot = canon;
    }
    Ok(())
}

fn path_is_under_current_root(canon: &Path) -> bool {
    let slot = match current_root_slot().lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    match slot.as_ref() {
        // Path::starts_with does component-wise comparison, so it
        // correctly handles `/a/b` vs `/a/bar` (no false positive)
        // and works across separator conventions.
        Some(root) => canon.starts_with(root),
        None => false,
    }
}

fn path_is_in_recents(canon: &Path) -> bool {
    menu_recents_slot()
        .lock()
        .map(|s| {
            s.iter()
                .filter_map(|r| std::fs::canonicalize(&r.path).ok())
                .any(|c| c == canon)
        })
        .unwrap_or(false)
}

// Bounded LRU of paths the renderer has explicitly opened as live
// documents. Used by share_macos / copy_markdown_source to refuse
// arbitrary paths an XSS-injected caller might supply.
//
// Why bounded: the slot is touched only by `register_active_doc`, but
// in principle an XSS *can* call that command in a tight loop. A cap
// keeps the failure mode at "oldest doc is forgotten" instead of
// unbounded memory growth.
//
// Why LRU (not strict FIFO): re-opening a file already in the set
// moves it to the back. This keeps frequently-visited files from
// being prematurely evicted just because they were opened early in
// the session — the security boundary is "did the user interact with
// this file recently?", and a re-open is a fresh interaction.
const MAX_ACTIVE_DOCS: usize = 256;

#[derive(Default)]
struct ActiveDocs {
    // Both structures stay in sync. The VecDeque preserves insertion
    // order for eviction; the inner Vec is the actual lookup target.
    // We use Vec<PathBuf> rather than HashSet<PathBuf> because the set
    // is small (≤256) and a linear scan beats hashing path components
    // for this size, while keeping eviction trivial.
    order: VecDeque<PathBuf>,
}

impl ActiveDocs {
    fn insert(&mut self, p: PathBuf) {
        // Move existing entry to the back so a re-open doesn't get
        // evicted prematurely.
        self.order.retain(|q| q != &p);
        self.order.push_back(p);
        while self.order.len() > MAX_ACTIVE_DOCS {
            self.order.pop_front();
        }
    }

    fn contains(&self, p: &Path) -> bool {
        self.order.iter().any(|q| q == p)
    }
}

static ACTIVE_DOC_PATHS: OnceLock<Mutex<ActiveDocs>> = OnceLock::new();

fn active_docs_slot() -> &'static Mutex<ActiveDocs> {
    ACTIVE_DOC_PATHS.get_or_init(|| Mutex::new(ActiveDocs::default()))
}

#[tauri::command]
fn register_active_doc(path: String) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("invalid path".into());
    }
    let canon = std::fs::canonicalize(&path)
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    if let Ok(mut slot) = active_docs_slot().lock() {
        slot.insert(canon);
    }
    Ok(())
}

// Test-only helper so unit tests covering commands that gate on the
// active-doc set can prime it without going through Tauri's IPC.
#[cfg(test)]
pub(crate) fn test_register_active_doc(path: &Path) {
    let canon = std::fs::canonicalize(path).expect("canonicalize");
    active_docs_slot().lock().unwrap().insert(canon);
}

pub(crate) fn is_path_active_doc(path: &str) -> bool {
    let canon = match std::fs::canonicalize(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    active_docs_slot()
        .lock()
        .map(|s| s.contains(&canon))
        .unwrap_or(false)
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    use tauri_plugin_opener::reveal_item_in_dir;
    if path.is_empty() || path.len() > 4096 {
        return Err("invalid path".into());
    }
    // Only reveal paths the user has plausibly interacted with through
    // the app: the current folder root and anything under it, an entry
    // from the recents list, or an active document. This stops an XSS
    // in the renderer from popping arbitrary Finder windows.
    let canon = std::fs::canonicalize(&path)
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    let allowed = path_is_under_current_root(&canon)
        || path_is_in_recents(&canon)
        || is_path_active_doc(&path);
    if !allowed {
        return Err("path not in any allowed scope".into());
    }
    // Pass the canonical path (not the caller-supplied one) so a
    // symlink swap between the scope check and the OS call resolves
    // to whatever we authorized, not whatever the attacker pointed at.
    reveal_item_in_dir(&canon).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum PathValidationKind {
    File,
    Dir,
    Missing,
}

#[derive(serde::Serialize)]
struct PathValidation {
    exists: bool,
    kind: PathValidationKind,
}

// Used by the renderer to mark recents entries whose target no longer
// exists (moved/deleted). Returns a parallel array so the caller can
// zip results without re-sending the path list. Symlinks are followed
// via fs::metadata; broken symlinks report as Missing.
#[tauri::command]
fn validate_paths(paths: Vec<String>) -> Vec<PathValidation> {
    paths
        .into_iter()
        .map(|p| match std::fs::metadata(&p) {
            Ok(meta) if meta.is_file() => PathValidation {
                exists: true,
                kind: PathValidationKind::File,
            },
            Ok(meta) if meta.is_dir() => PathValidation {
                exists: true,
                kind: PathValidationKind::Dir,
            },
            _ => PathValidation {
                exists: false,
                kind: PathValidationKind::Missing,
            },
        })
        .collect()
}

fn themes_dir_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?
        .join("themes");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create themes dir: {e}"))?;
    }
    Ok(dir)
}

#[tauri::command]
fn themes_dir(app: tauri::AppHandle) -> Result<String, String> {
    let p = themes_dir_path(&app)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn list_disk_themes(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = themes_dir_path(&app)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        out.push(value);
    }
    Ok(out)
}

// A well-formed theme (id, name, pair, isDark, ~14 short color strings) sits
// well under 4 KiB. 64 KiB caps a buggy/hostile caller from filling the
// themes dir without rejecting legitimate payloads.
const MAX_THEME_JSON_BYTES: usize = 64 * 1024;

#[tauri::command]
fn save_disk_theme(
    app: tauri::AppHandle,
    id: String,
    json: String,
) -> Result<String, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid theme id".into());
    }
    if json.len() > MAX_THEME_JSON_BYTES {
        return Err("theme json too large".into());
    }
    // Parse before writing so a malformed payload never lands on disk —
    // list_disk_themes would silently skip it later, leaving a phantom file.
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("invalid theme json: {e}"))?;
    let dir = themes_dir_path(&app)?;
    let file = dir.join(format!("{id}.json"));
    let tmp = dir.join(format!("{id}.json.tmp"));
    std::fs::write(&tmp, json).map_err(|e| format!("write failed: {e}"))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("rename failed: {e}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_disk_theme(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid theme id".into());
    }
    let dir = themes_dir_path(&app)?;
    let file = dir.join(format!("{id}.json"));
    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| format!("delete failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn reveal_themes_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = themes_dir_path(&app)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = dir;
        return Err("reveal not supported on this platform".into());
    }
    Ok(())
}

#[tauri::command]
async fn list_system_fonts() -> Result<Vec<String>, String> {
    // Enumerating fonts via font-kit reads the user/system font directories and
    // parses each file (100–500ms on macOS). Run it on the blocking pool so the
    // main Tauri worker thread stays free for other commands.
    tokio::task::spawn_blocking(|| -> Result<Vec<String>, String> {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        let families = source
            .all_families()
            .map_err(|e| format!("font enumeration failed: {e}"))?;
        let mut names: Vec<String> = families
            .into_iter()
            .filter(|n| !n.is_empty() && !n.starts_with('.'))
            .collect();
        names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        names.dedup();
        Ok(names)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn export_pdf(webview: tauri::Webview, output_path: String) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::NSData;
    use objc2_foundation::NSError;
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Mutex::new(Some(tx));

    webview
        .with_webview(move |wv| unsafe {
            let wk: &WKWebView = &*(wv.inner().cast::<WKWebView>());
            let mtm = MainThreadMarker::new().expect("with_webview runs on main thread");
            let config = WKPDFConfiguration::new(mtm);

            let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = if !error.is_null() {
                    let desc = (*error).localizedDescription();
                    Err(format!("PDF generation failed: {desc}"))
                } else if data.is_null() {
                    Err("PDF generation returned no data".to_string())
                } else {
                    Ok((*data).to_vec())
                };
                if let Some(sender) = tx.lock().unwrap().take() {
                    let _ = sender.send(result);
                }
            });

            wk.createPDFWithConfiguration_completionHandler(Some(&config), &block);
        })
        .map_err(|e| e.to_string())?;

    let pdf_data = rx
        .await
        .map_err(|_| "PDF generation channel closed".to_string())??;
    std::fs::write(&output_path, &pdf_data).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn export_pdf(_output_path: String) -> Result<(), String> {
    Err("PDF export is only supported on macOS".to_string())
}

// Server-side downgrade guard. Called from the renderer right before
// install. The renderer also runs isUpgrade() in TypeScript, but the
// renderer is reachable via DOMPurify-bypass XSS in theory; the Rust
// side is not. If a hostile manifest somehow advertised an older
// version and slipped past every other check, this is the last
// gate before we hand the update plugin a bullet to fire.
//
// The current version is sourced exclusively from the binary's
// package_info — we deliberately do NOT accept a current_version
// parameter from the renderer. Taking one would create a footgun
// (callers passing the renderer-supplied value into the check) and
// risk reflecting attacker-controlled input back through error
// messages.
//
// Returns Err with a descriptive message instead of Ok(false) so the
// renderer can't accidentally interpret "failure" as "allowed". The
// error message does NOT echo the candidate string verbatim — only a
// fixed, non-attacker-controlled summary.
#[tauri::command]
fn assert_update_is_upgrade(
    app: tauri::AppHandle,
    candidate_version: String,
) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    if !is_strictly_greater_semver(&current, &candidate_version) {
        return Err("candidate version is not a strict upgrade".into());
    }
    Ok(())
}

// Strict semver-core comparison. Pre-release / build metadata (after
// `-` or `+`) is ignored. Every dot-separated segment of the core must
// be purely numeric; anything else fails closed.
fn is_strictly_greater_semver(current: &str, candidate: &str) -> bool {
    fn core(v: &str) -> Option<Vec<u64>> {
        let stripped = v.strip_prefix('v').unwrap_or(v);
        let core_only = stripped.split(['-', '+']).next().unwrap_or("");
        let parts: Vec<&str> = core_only.split('.').collect();
        if parts.is_empty() {
            return None;
        }
        let mut out = Vec::with_capacity(parts.len());
        for p in parts {
            if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            out.push(p.parse::<u64>().ok()?);
        }
        Some(out)
    }
    let a = match core(current) {
        Some(v) => v,
        None => return false,
    };
    let b = match core(candidate) {
        Some(v) => v,
        None => return false,
    };
    let len = a.len().max(b.len());
    for i in 0..len {
        let ai = a.get(i).copied().unwrap_or(0);
        let bi = b.get(i).copied().unwrap_or(0);
        if bi > ai {
            return true;
        }
        if bi < ai {
            return false;
        }
    }
    false
}

// Fetches the release notes body for a given app version from the GitHub
// API. Lives on the Rust side so the renderer doesn't need a CSP
// connect-src exception for api.github.com — keeping the webview's
// network surface as tight as possible limits the blast radius of any
// future XSS bypass in DOMPurify.
//
// Returns the release notes body + publish date for a given version,
// or None when the release has no notes / the network call fails / the
// API returns non-success. The caller sanitizes the body via
// parseMarkdown + DOMPurify before rendering.
#[derive(serde::Serialize)]
pub struct ReleaseInfo {
    body: String,
    published_at: Option<String>,
    html_url: Option<String>,
}

// Single source of truth for the GitHub coordinates on the Rust side.
// Must stay in sync with GITHUB_REPO in src/updater.ts and with the
// updater endpoint in tauri.conf.json. If the project ever moves orgs,
// these three references must all change together.
const GITHUB_REPO: &str = "ekino/MarkdownViewer";

#[tauri::command]
async fn fetch_release_notes(version: String) -> Result<Option<ReleaseInfo>, String> {
    // Restrict input shape so a hostile caller can't aim the request at
    // arbitrary paths via path traversal in the tag segment.
    if version.is_empty() || version.len() > 64 {
        return Err("invalid version".into());
    }
    if !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+') {
        return Err("invalid version".into());
    }
    let url = format!(
        "https://api.github.com/repos/{GITHUB_REPO}/releases/tags/v{version}"
    );
    let client = reqwest::Client::builder()
        .user_agent("MarkdownViewer/whatsnew")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Ok(None);
    }
    #[derive(serde::Deserialize)]
    struct ReleaseResponse {
        body: Option<String>,
        published_at: Option<String>,
        html_url: Option<String>,
    }
    let parsed: ReleaseResponse = res.json().await.map_err(|e| e.to_string())?;
    let body = parsed.body.unwrap_or_default();
    if body.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(ReleaseInfo {
        body,
        published_at: parsed.published_at,
        html_url: parsed.html_url,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(path_arg: Option<String>) {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            print_webview,
            export_pdf,
            get_pending_open,
            validate_paths,
            update_menu_state,
            register_active_doc,
            register_current_root,
            reveal_in_finder,
            fs_tree::scan_markdown_tree,
            watcher::start_watch,
            watcher::stop_watch,
            exports::export_html_standalone,
            exports::export_html_with_assets,
            exports::copy_markdown_source,
            #[cfg(target_os = "macos")]
            share_macos::share_macos,
            list_system_fonts,
            themes_dir,
            list_disk_themes,
            save_disk_theme,
            delete_disk_theme,
            reveal_themes_dir,
            fetch_release_notes,
            assert_update_is_upgrade
        ])
        .manage(watcher::WatcherRegistry::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let menu = menu::build_menu(app)?;
            app.set_menu(menu)?;

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                match menu::classify_event(event.id().0.as_str()) {
                    menu::MenuEvent::OpenFile => {
                        let _ = app_handle.emit("menu-open-file", ());
                    }
                    menu::MenuEvent::OpenFolder => {
                        let _ = app_handle.emit("menu-open-folder", ());
                    }
                    menu::MenuEvent::OpenRecent(idx) => {
                        // Translate the click into a (kind, path) payload so
                        // the renderer can act without re-fetching the store.
                        let payload = menu_recents_slot()
                            .lock()
                            .ok()
                            .and_then(|slot| slot.get(idx).cloned())
                            .and_then(|item| match item.kind.as_str() {
                                "file" => Some(RecentEventPayload::File { path: item.path }),
                                "folder" => Some(RecentEventPayload::Folder { path: item.path }),
                                _ => None,
                            });
                        if let Some(p) = payload {
                            let _ = app_handle.emit("menu-open-recent", p);
                        }
                    }
                    menu::MenuEvent::ClearRecents => {
                        let _ = app_handle.emit("menu-clear-recents", ());
                    }
                    menu::MenuEvent::CloseFolder => {
                        let _ = app_handle.emit("menu-close-folder", ());
                    }
                    menu::MenuEvent::Save => {
                        let _ = app_handle.emit("menu-save", ());
                    }
                    menu::MenuEvent::ExportPdf => {
                        let _ = app_handle.emit("menu-export", "pdf");
                    }
                    menu::MenuEvent::ExportHtml => {
                        let _ = app_handle.emit("menu-export", "html-standalone");
                    }
                    menu::MenuEvent::ExportHtmlAssets => {
                        let _ = app_handle.emit("menu-export", "html-with-assets");
                    }
                    menu::MenuEvent::ExportMd => {
                        let _ = app_handle.emit("menu-export", "md-copy");
                    }
                    menu::MenuEvent::Share => {
                        let _ = app_handle.emit("menu-share", ());
                    }
                    menu::MenuEvent::Print => {
                        let _ = app_handle.emit("menu-print", ());
                    }
                    menu::MenuEvent::Preferences => {
                        let _ = app_handle.emit("menu-open-preferences", ());
                    }
                    menu::MenuEvent::CheckUpdates => {
                        let _ = app_handle.emit("menu-check-updates", ());
                    }
                    menu::MenuEvent::WhatsNew => {
                        let _ = app_handle.emit("menu-whats-new", ());
                    }
                    menu::MenuEvent::Unknown => {}
                }
            });

            // Buffer CLI arg so the frontend can pull it on init
            if let Some(ref path_str) = path_arg {
                let path = Path::new(path_str);
                let pending = if path.is_file() {
                    Some(PendingOpen::File { path: path_str.clone() })
                } else if path.is_dir() {
                    Some(PendingOpen::Folder { path: path_str.clone() })
                } else {
                    None
                };
                if let Some(p) = pending {
                    if let Ok(mut slot) = pending_slot().lock() {
                        *slot = Some(p);
                    }
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Drop watchers when their window closes so the OS-level watch
        // is released and we don't keep the renderer payload channel alive.
        if let tauri::RunEvent::WindowEvent {
            ref label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } = event
        {
            watcher::drop_watcher_for_window(app_handle, label);
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { ref urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if path.is_file() {
                        let path_str = path.to_string_lossy().to_string();
                        let windows = app_handle.webview_windows();
                        if let Some(win) = windows.values().next() {
                            // Hot-start: a window already exists, the JS listener
                            // is registered. Emit directly; the frontend's cold-start
                            // pull-from-buffer has already drained any prior value.
                            let _ = app_handle.emit("open-file", path_str);
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        } else if let Ok(mut slot) = pending_slot().lock() {
                            // Cold-start: Apple Events fired before setup completed.
                            // Buffer so the frontend can pull it on init.
                            *slot = Some(PendingOpen::File { path: path_str });
                        }
                    }
                }
            }
        }
        let _ = (app_handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_docs_evicts_in_fifo_order_at_capacity() {
        let mut docs = ActiveDocs::default();
        for i in 0..MAX_ACTIVE_DOCS + 5 {
            docs.insert(PathBuf::from(format!("/tmp/doc-{i}.md")));
        }
        assert_eq!(docs.order.len(), MAX_ACTIVE_DOCS);
        // The first 5 inserts should have been evicted.
        for i in 0..5 {
            assert!(
                !docs.contains(&PathBuf::from(format!("/tmp/doc-{i}.md"))),
                "doc-{i} should have been evicted",
            );
        }
        assert!(docs.contains(&PathBuf::from(format!(
            "/tmp/doc-{}.md",
            MAX_ACTIVE_DOCS + 4
        ))));
    }

    #[test]
    fn active_docs_reinsert_moves_to_back() {
        let mut docs = ActiveDocs::default();
        docs.insert(PathBuf::from("/a"));
        docs.insert(PathBuf::from("/b"));
        docs.insert(PathBuf::from("/a")); // touched again, should be at back
        assert_eq!(docs.order.len(), 2);
        assert_eq!(docs.order.back().unwrap(), &PathBuf::from("/a"));
        // Now fill until we'd evict /b first if /a was at the front.
        for i in 0..MAX_ACTIVE_DOCS {
            docs.insert(PathBuf::from(format!("/x{i}")));
        }
        assert!(!docs.contains(&PathBuf::from("/a")));
        assert!(!docs.contains(&PathBuf::from("/b")));
    }

    #[test]
    fn path_is_under_current_root_uses_component_match() {
        // Reset slot for hermetic test.
        *current_root_slot().lock().unwrap() = Some(PathBuf::from("/a/b"));
        assert!(path_is_under_current_root(Path::new("/a/b/c.md")));
        assert!(path_is_under_current_root(Path::new("/a/b")));
        // Critical: "/a/bar" must NOT match — this is the string-prefix
        // bug N3 called out.
        assert!(!path_is_under_current_root(Path::new("/a/bar")));
        assert!(!path_is_under_current_root(Path::new("/a/bartender/x")));
        assert!(!path_is_under_current_root(Path::new("/c")));
        *current_root_slot().lock().unwrap() = None;
        assert!(!path_is_under_current_root(Path::new("/a/b/c.md")));
    }

    #[test]
    fn semver_strict_greater_basic() {
        assert!(is_strictly_greater_semver("0.9.0", "0.10.0"));
        assert!(is_strictly_greater_semver("0.9.0", "1.0.0"));
        assert!(is_strictly_greater_semver("1.2.3", "1.2.4"));
        assert!(!is_strictly_greater_semver("0.9.0", "0.9.0"));
        assert!(!is_strictly_greater_semver("1.0.0", "0.9.9"));
    }

    #[test]
    fn semver_strict_greater_strips_v_prefix() {
        assert!(is_strictly_greater_semver("v0.9.0", "v0.10.0"));
        assert!(is_strictly_greater_semver("0.9.0", "v0.10.0"));
    }

    #[test]
    fn semver_strict_greater_ignores_prerelease() {
        // Same core version with a -rc suffix is NOT an upgrade.
        assert!(!is_strictly_greater_semver("1.0.0", "1.0.0-rc1"));
        // But a strictly greater core IS, regardless of suffix.
        assert!(is_strictly_greater_semver("0.9.0", "1.0.0-beta"));
    }

    #[test]
    fn semver_strict_greater_rejects_garbage() {
        // Hostile manifest with non-numeric segments must NOT parse as
        // a huge version. The whole point of the Rust-side guard.
        assert!(!is_strictly_greater_semver("0.9.0", "99.attacker.0"));
        assert!(!is_strictly_greater_semver("0.9.0", "garbage"));
        assert!(!is_strictly_greater_semver("0.9.0", ""));
        assert!(!is_strictly_greater_semver("0.9.0", "1.0.0a"));
        assert!(!is_strictly_greater_semver("0.9.0", "..."));
        // Garbage on the installed-version side also fails closed.
        assert!(!is_strictly_greater_semver("garbage", "1.0.0"));
    }

    #[test]
    fn semver_strict_greater_handles_multidigit() {
        assert!(is_strictly_greater_semver("1.9.0", "1.10.0"));
        assert!(is_strictly_greater_semver("0.99.0", "0.100.0"));
    }
}
