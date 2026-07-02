use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{Emitter, Manager, Wry};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PendingOpen {
    File { path: String },
    Folder { path: String },
}

#[derive(serde::Deserialize)]
struct RecentItem {
    path: String,
    kind: String,
    label: String,
}

#[derive(Clone, serde::Serialize)]
struct RecentOpen {
    kind: String,
    path: String,
}

// Handle to the "Open Recent" submenu, stored so the frontend can rebuild its
// contents at runtime (via `update_recent_menu`) as the recents list changes.
// The menu itself is owned by Rust; the recents *state* lives in the frontend
// store, keeping state ownership on the TS side per the app's conventions.
static RECENT_SUBMENU: OnceLock<Mutex<Option<Submenu<Wry>>>> = OnceLock::new();

fn recent_slot() -> &'static Mutex<Option<Submenu<Wry>>> {
    RECENT_SUBMENU.get_or_init(|| Mutex::new(None))
}

// Menu item ids for recent entries embed the path after a fixed prefix, so the
// menu-event handler can recover the path even if it contains a colon.
const RECENT_FILE_PREFIX: &str = "recent-file:";
const RECENT_FOLDER_PREFIX: &str = "recent-folder:";

#[tauri::command]
fn update_recent_menu(app: tauri::AppHandle, items: Vec<RecentItem>) -> Result<(), String> {
    let guard = recent_slot().lock().map_err(|e| e.to_string())?;
    let Some(submenu) = guard.as_ref() else {
        return Ok(()); // menu not built yet — nothing to update
    };

    let count = submenu.items().map_err(|e| e.to_string())?.len();
    for _ in 0..count {
        submenu.remove_at(0).map_err(|e| e.to_string())?;
    }

    if items.is_empty() {
        let none = MenuItemBuilder::with_id("recent_none", "No Recent Files")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&none).map_err(|e| e.to_string())?;
        return Ok(());
    }

    for item in &items {
        let prefix = if item.kind == "folder" {
            RECENT_FOLDER_PREFIX
        } else {
            RECENT_FILE_PREFIX
        };
        let id = format!("{prefix}{}", item.path);
        let mi = MenuItemBuilder::with_id(id, &item.label)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&mi).map_err(|e| e.to_string())?;
    }

    let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    submenu.append(&sep).map_err(|e| e.to_string())?;
    let clear = MenuItemBuilder::with_id("recent_clear", "Clear Menu")
        .build(&app)
        .map_err(|e| e.to_string())?;
    submenu.append(&clear).map_err(|e| e.to_string())?;
    Ok(())
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

// No-op round-trip used to isolate IPC transport latency from filesystem
// latency in the debug HUD. TEMP diagnostic.
#[tauri::command]
fn ping() {}

// Last-modified time (ms since epoch) used to validate the frontend's in-memory
// document cache. Metadata only — cheap even when the file body is slow to read
// (e.g. a not-yet-materialized OneDrive/iCloud "online-only" file).
#[tauri::command]
async fn document_mtime(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|_| "cannot stat file".to_string())?;
    let modified = meta.modified().map_err(|_| "no mtime".to_string())?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "bad mtime".to_string())?
        .as_millis() as u64;
    Ok(ms)
}

// Reading through the `fs` plugin adds large fixed latency per open on
// macOS/WKWebView. A direct app command reads the file itself.
//
// `async` on purpose: the read itself is slow on this machine (endpoint
// security / synced-folder scanning adds seconds per open — the IPC round-trip
// is ~1ms). A sync command would run on the main thread and freeze the UI; an
// async command runs off it, so the window stays responsive during the read.
//
// Confined to the user's home dir or the bundled resource dir (examples):
// canonicalize resolves `..`/symlinks, then we require the result to sit under
// an allowed root. Errors stay generic to avoid leaking paths.
#[tauri::command]
async fn read_document(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let requested =
        std::fs::canonicalize(&path).map_err(|_| "cannot resolve path".to_string())?;

    let roots = [app.path().home_dir(), app.path().resource_dir()]
        .into_iter()
        .flatten()
        .filter_map(|p| std::fs::canonicalize(p).ok());
    if !roots.into_iter().any(|root| requested.starts_with(&root)) {
        return Err("path outside allowed roots".to_string());
    }

    let t = std::time::Instant::now();
    let content =
        std::fs::read_to_string(&requested).map_err(|_| "failed to read file".to_string())?;
    eprintln!(
        "[read_document] std::fs read {} bytes in {:?}",
        content.len(),
        t.elapsed()
    );
    Ok(content)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(path_arg: Option<String>) {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            print_webview,
            read_document,
            document_mtime,
            ping,
            export_pdf,
            get_pending_open,
            list_system_fonts,
            themes_dir,
            list_disk_themes,
            save_disk_theme,
            delete_disk_theme,
            reveal_themes_dir,
            update_recent_menu
        ])
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // Build native menu
            let open_file = MenuItemBuilder::with_id("open_file", "Open File…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;

            let open_folder = MenuItemBuilder::with_id("open_folder", "Open Folder…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?;

            let recent_submenu = SubmenuBuilder::new(app, "Open Recent")
                .item(
                    &MenuItemBuilder::with_id("recent_none", "No Recent Files")
                        .enabled(false)
                        .build(app)?,
                )
                .build()?;
            if let Ok(mut slot) = recent_slot().lock() {
                *slot = Some(recent_submenu.clone());
            }

            let print_item = MenuItemBuilder::with_id("print", "Print…")
                .accelerator("CmdOrCtrl+P")
                .build(app)?;

            let export_pdf_item = MenuItemBuilder::with_id("export_pdf", "Export as PDF…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;

            let toggle_theme = MenuItemBuilder::with_id("toggle_theme", "Toggle Dark Mode")
                .build(app)?;

            let preferences = MenuItemBuilder::with_id("preferences", "Preferences…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let find = MenuItemBuilder::with_id("find", "Find…")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;

            let app_name = app.package_info().name.clone();

            let menu = MenuBuilder::new(app)
                .items(&[
                    &SubmenuBuilder::new(app, &app_name)
                        .about(None)
                        .separator()
                        .items(&[&preferences])
                        .separator()
                        .services()
                        .separator()
                        .hide()
                        .hide_others()
                        .show_all()
                        .separator()
                        .quit()
                        .build()?,
                    &SubmenuBuilder::new(app, "File")
                        .items(&[&open_file, &open_folder])
                        .item(&recent_submenu)
                        .separator()
                        .items(&[&print_item, &export_pdf_item])
                        .separator()
                        .close_window()
                        .build()?,
                    &SubmenuBuilder::new(app, "Edit")
                        .undo()
                        .redo()
                        .separator()
                        .cut()
                        .copy()
                        .paste()
                        .select_all()
                        .separator()
                        .items(&[&find])
                        .build()?,
                    &SubmenuBuilder::new(app, "View")
                        .items(&[&toggle_theme])
                        .build()?,
                ])
                .build()?;

            app.set_menu(menu)?;

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                match id {
                    "open_file" => {
                        let _ = app_handle.emit("menu-open-file", ());
                    }
                    "open_folder" => {
                        let _ = app_handle.emit("menu-open-folder", ());
                    }
                    "print" => {
                        let _ = app_handle.emit("menu-print", ());
                    }
                    "export_pdf" => {
                        let _ = app_handle.emit("menu-export-pdf", ());
                    }
                    "toggle_theme" => {
                        let _ = app_handle.emit("menu-toggle-theme", ());
                    }
                    "preferences" => {
                        let _ = app_handle.emit("menu-open-preferences", ());
                    }
                    "find" => {
                        let _ = app_handle.emit("menu-find", ());
                    }
                    "recent_clear" => {
                        let _ = app_handle.emit("menu-clear-recent", ());
                    }
                    _ if id.starts_with(RECENT_FILE_PREFIX) => {
                        let path = id[RECENT_FILE_PREFIX.len()..].to_string();
                        let _ = app_handle.emit(
                            "menu-open-recent",
                            RecentOpen { kind: "file".into(), path },
                        );
                    }
                    _ if id.starts_with(RECENT_FOLDER_PREFIX) => {
                        let path = id[RECENT_FOLDER_PREFIX.len()..].to_string();
                        let _ = app_handle.emit(
                            "menu-open-recent",
                            RecentOpen { kind: "folder".into(), path },
                        );
                    }
                    _ => {}
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
