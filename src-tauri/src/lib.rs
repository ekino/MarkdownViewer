use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::menu::{
    CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PendingOpen {
    File { path: String },
    Folder { path: String },
    /// A freshly spawned window with nothing to open: it must show the welcome
    /// screen instead of restoring the last folder (which would make "New
    /// Window" a duplicate of the window it was spawned from).
    Empty,
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

// Handle to the "Window" submenu, whose tail is one entry per open window.
//
// macOS can populate a Window menu on its own (`setWindowsMenu:`), but AppKit
// only adopts windows it sees created after that call — our main window already
// exists by then, and tao's windows never got added at all. So the list is built
// here and refreshed on every event that can change it: window opened, closed,
// focused, or renamed by the frontend.
static WINDOW_SUBMENU: OnceLock<Mutex<Option<Submenu<Wry>>>> = OnceLock::new();

const WINDOW_ITEM_PREFIX: &str = "window:";

fn window_slot() -> &'static Mutex<Option<Submenu<Wry>>> {
    WINDOW_SUBMENU.get_or_init(|| Mutex::new(None))
}

/// Order windows the way the user created them: the original window first, then
/// the spawned ones by number (so `viewer-10` sorts after `viewer-9`).
fn window_sort_key(label: &str) -> (u8, u32, String) {
    if label == MAIN_WINDOW_LABEL {
        return (0, 0, String::new());
    }
    let n = label
        .rsplit('-')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(u32::MAX);
    (1, n, label.to_string())
}

const ARRANGE_PREFIX: &str = "window-arrange:";
const BRING_ALL_TO_FRONT_ID: &str = "window-bring-all-front";

// Frame each window had before it was first tiled, so "Return to Previous Size"
// can undo a run of Fill/half/quarter moves in one step (macOS behaviour).
// Dropped once restored, and when the window goes away.
type Frame = (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>);
static PRE_ARRANGE: OnceLock<Mutex<HashMap<String, Frame>>> = OnceLock::new();

fn pre_arrange() -> &'static Mutex<HashMap<String, Frame>> {
    PRE_ARRANGE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The area a window may occupy on its screen — the screen minus menu bar and
/// Dock — as (x, y, width, height) in physical pixels, top-left origin.
///
/// `Monitor::work_area()` is not usable for this: on macOS it reports the right
/// *size* but an origin of (0, 0), i.e. it ignores the menu bar. Anchoring to
/// the top still lands correctly because macOS refuses to put a window under the
/// menu bar, but anything anchored to the bottom (bottom half, bottom quarters,
/// centering) ends up one menu-bar-height too high. So on macOS we ask AppKit
/// for the same `visibleFrame` its own Window menu uses, and convert it from
/// Cocoa's bottom-left origin to the top-left origin tao expects.
#[cfg(target_os = "macos")]
fn usable_area(win: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    use objc2_app_kit::NSScreen;
    use objc2_foundation::MainThreadMarker;

    let mtm = MainThreadMarker::new()?;
    let screens = NSScreen::screens(mtm);
    // screens[0] is the screen holding the menu bar; every Cocoa y is relative
    // to its bottom edge.
    let primary_height = screens.iter().next()?.frame().size.height;
    let to_top_left = |origin_y: f64, height: f64| primary_height - (origin_y + height);

    let scale = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?;
    let (wx, wy) = (pos.x as f64 / scale, pos.y as f64 / scale);

    let screen = screens
        .iter()
        .find(|s| {
            let f = s.frame();
            let top = to_top_left(f.origin.y, f.size.height);
            wx >= f.origin.x
                && wx < f.origin.x + f.size.width
                && wy >= top
                && wy < top + f.size.height
        })
        .or_else(|| screens.iter().next())?;

    let v = screen.visibleFrame();
    let top = to_top_left(v.origin.y, v.size.height);
    let s = screen.backingScaleFactor();
    Some((
        (v.origin.x * s).round() as i32,
        (top * s).round() as i32,
        (v.size.width * s).round() as i32,
        (v.size.height * s).round() as i32,
    ))
}

#[cfg(not(target_os = "macos"))]
fn usable_area(win: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let monitor = win.current_monitor().ok()??;
    let area = monitor.work_area();
    Some((
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    ))
}

/// Move/resize the frontmost window inside its screen's work area (the screen
/// minus menu bar and Dock), the way the macOS Window menu does it.
fn arrange_focused_window(app: &tauri::AppHandle, action: &str) -> Result<(), String> {
    let Some(win) = focused_window(app) else {
        return Ok(());
    };
    let label = win.label().to_string();

    if action == "restore" {
        let saved = pre_arrange()
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&label);
        if let Some((pos, size)) = saved {
            win.set_size(size).map_err(|e| e.to_string())?;
            win.set_position(pos).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let (ax, ay, aw, ah) =
        usable_area(&win).ok_or_else(|| "no usable screen area".to_string())?;
    // Halves are computed as "the rest of the area" for the right/bottom side so
    // an odd number of pixels never leaves a one-pixel gap down the middle.
    let (lw, th) = (aw / 2, ah / 2);
    let (rw, bh) = (aw - lw, ah - th);

    let size = win.outer_size().map_err(|e| e.to_string())?;
    let (x, y, w, h) = match action {
        "fill" => (ax, ay, aw, ah),
        "center" => (
            ax + (aw - size.width as i32) / 2,
            ay + (ah - size.height as i32) / 2,
            size.width as i32,
            size.height as i32,
        ),
        "left" => (ax, ay, lw, ah),
        "right" => (ax + lw, ay, rw, ah),
        "top" => (ax, ay, aw, th),
        "bottom" => (ax, ay + th, aw, bh),
        "top-left" => (ax, ay, lw, th),
        "top-right" => (ax + lw, ay, rw, th),
        "bottom-left" => (ax, ay + th, lw, bh),
        "bottom-right" => (ax + lw, ay + th, rw, bh),
        _ => return Ok(()),
    };

    // Remember the pre-tiling frame once, so chained arrangements still restore
    // to where the window was before the user started rearranging it.
    {
        let mut saved = pre_arrange().lock().map_err(|e| e.to_string())?;
        if !saved.contains_key(&label) {
            let pos = win.outer_position().map_err(|e| e.to_string())?;
            saved.insert(label, (pos, size));
        }
    }

    win.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32))
        .map_err(|e| e.to_string())?;
    win.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Raise every window, leaving the frontmost one still frontmost.
fn bring_all_to_front(app: &tauri::AppHandle) {
    let focused = focused_window(app).map(|w| w.label().to_string());
    for (label, win) in app.webview_windows() {
        if Some(&label) == focused.as_ref() {
            continue;
        }
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(label) = focused {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_focus();
        }
    }
}

fn arrange_item(
    app: &tauri::AppHandle,
    action: &str,
    text: &str,
) -> Result<tauri::menu::MenuItem<Wry>, String> {
    MenuItemBuilder::with_id(format!("{ARRANGE_PREFIX}{action}"), text)
        .build(app)
        .map_err(|e| e.to_string())
}

fn rebuild_window_menu(app: &tauri::AppHandle) -> Result<(), String> {
    let guard = window_slot().lock().map_err(|e| e.to_string())?;
    let Some(submenu) = guard.as_ref() else {
        return Ok(()); // menu not built yet — setup will do the first pass
    };

    let count = submenu.items().map_err(|e| e.to_string())?.len();
    for _ in 0..count {
        submenu.remove_at(0).map_err(|e| e.to_string())?;
    }

    let minimize = PredefinedMenuItem::minimize(app, None).map_err(|e| e.to_string())?;
    let zoom = PredefinedMenuItem::maximize(app, None).map_err(|e| e.to_string())?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None).map_err(|e| e.to_string())?;
    let fill = arrange_item(app, "fill", "Fill")?;
    let center = arrange_item(app, "center", "Center")?;

    // Deliberately without accelerators: macOS already owns ⌃⌥+arrows for its
    // own window tiling, and shadowing those here would be a coin flip over
    // which one wins.
    let move_resize = SubmenuBuilder::new(app, "Move & Resize")
        .items(&[
            &arrange_item(app, "left", "Left")?,
            &arrange_item(app, "right", "Right")?,
            &arrange_item(app, "top", "Top")?,
            &arrange_item(app, "bottom", "Bottom")?,
        ])
        .separator()
        .items(&[
            &arrange_item(app, "top-left", "Top Left")?,
            &arrange_item(app, "top-right", "Top Right")?,
            &arrange_item(app, "bottom-left", "Bottom Left")?,
            &arrange_item(app, "bottom-right", "Bottom Right")?,
        ])
        .separator()
        .items(&[&arrange_item(app, "restore", "Return to Previous Size")?])
        .build()
        .map_err(|e| e.to_string())?;

    let bring_all = MenuItemBuilder::with_id(BRING_ALL_TO_FRONT_ID, "Bring All to Front")
        .build(app)
        .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let sep3 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    for item in [
        &minimize as &dyn tauri::menu::IsMenuItem<Wry>,
        &zoom,
        &fill,
        &center,
        &move_resize,
        &sep1,
        &fullscreen,
        &sep2,
        &bring_all,
        &sep3,
    ] {
        submenu.append(item).map_err(|e| e.to_string())?;
    }

    let mut windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .map(|(label, win)| {
            let title = win.title().unwrap_or_default();
            let focused = win.is_focused().unwrap_or(false);
            (label, title, focused)
        })
        .collect();
    windows.sort_by(|a, b| window_sort_key(&a.0).cmp(&window_sort_key(&b.0)));

    for (label, title, focused) in windows {
        let text = if title.is_empty() {
            "Markdown Viewer".to_string()
        } else {
            title
        };
        let item = CheckMenuItemBuilder::with_id(format!("{WINDOW_ITEM_PREFIX}{label}"), text)
            .checked(focused)
            .build(app)
            .map_err(|e| e.to_string())?;
        submenu.append(&item).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Rename this window and refresh its entry in the Window menu.
///
/// Goes through an app command rather than the frontend calling `setTitle`
/// directly, so the menu can never drift from the actual titles.
#[tauri::command]
fn set_window_title(
    app: tauri::AppHandle,
    window: tauri::Window,
    title: String,
) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())?;
    rebuild_window_menu(&app)
}

// Global map — available from process start, so `RunEvent::Opened` can write
// safely even if it fires before `setup` finishes (which can happen on macOS
// cold-start via Apple Events).
//
// Keyed by window label: each window drains only its own entry, so spawning a
// second window with its own folder can never steal the main window's pending
// open (or vice-versa).
static PENDING_OPEN: OnceLock<Mutex<HashMap<String, PendingOpen>>> = OnceLock::new();

const MAIN_WINDOW_LABEL: &str = "main";

fn pending_map() -> &'static Mutex<HashMap<String, PendingOpen>> {
    PENDING_OPEN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_pending(label: &str, pending: PendingOpen) {
    if let Ok(mut map) = pending_map().lock() {
        map.insert(label.to_string(), pending);
    }
}

#[tauri::command]
fn get_pending_open(window: tauri::Window) -> Option<PendingOpen> {
    pending_map()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(window.label()))
}

// Labels for spawned windows. `viewer-*` is allowlisted in
// capabilities/default.json — a new prefix here needs a matching entry there or
// the window comes up without any plugin permissions.
static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(1);

fn next_window_label(app: &tauri::AppHandle) -> String {
    loop {
        let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
        let label = format!("viewer-{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
}

/// Open a new app window, optionally on `path` (a folder or a single file).
///
/// Sync on purpose: Tauri runs non-async commands on the main thread, which is
/// where macOS window creation has to happen.
#[tauri::command]
fn open_new_window(app: tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    let label = next_window_label(&app);

    // Buffer *before* building the window: the frontend pulls its pending open
    // during init, which can start as soon as the webview exists.
    let pending = match path.as_deref() {
        Some(p) if Path::new(p).is_file() => PendingOpen::File { path: p.to_string() },
        Some(p) if Path::new(p).is_dir() => PendingOpen::Folder { path: p.to_string() },
        _ => PendingOpen::Empty,
    };
    set_pending(&label, pending);

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Markdown Viewer")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .resizable(true);

    #[cfg(target_os = "macos")]
    {
        // Mirror the main window's chrome (see app.windows in tauri.conf.json):
        // the frontend draws its own title bar over the native traffic lights.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    // Cascade off the frontmost window so a new window never lands exactly on
    // top of the one it was spawned from.
    if let Some(parent) = focused_window(&app) {
        if let (Ok(pos), Ok(scale)) = (parent.outer_position(), parent.scale_factor()) {
            let logical = pos.to_logical::<f64>(scale);
            builder = builder.position(logical.x + 28.0, logical.y + 28.0);
        }
    }

    builder.build().map_err(|e| e.to_string())?;
    // The new window has no title of its own until its frontend loads a
    // document; listing it right away keeps the menu honest in the meantime.
    let _ = rebuild_window_menu(&app);
    Ok(label)
}

/// The frontmost window, falling back to any window (macOS can dispatch a menu
/// command while no window holds focus, e.g. right after the last one closed).
///
/// `Manager::get_focused_window` would be the direct route, but it sits behind
/// tauri's `unstable` feature — this walks the stable webview-window map.
fn focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.values().next())
        .cloned()
}

// Menu commands act on the frontmost window only. A plain `emit` broadcasts to
// every webview, so with two windows open a single ⌘F (or "Open Folder…") would
// fire in both — two folder pickers, two focused search fields.
fn emit_to_focused<S: serde::Serialize + Clone>(
    app: &tauri::AppHandle,
    event: &str,
    payload: S,
) {
    if let Some(win) = focused_window(app) {
        let _ = app.emit_to(win.label(), event, payload);
    }
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

// What a path is right now, for the home screen's "Reprendre" card: it tells a
// file that is gone from one the app may not read. Follows symlinks. Indicative
// only — opening the document still goes through read_document.
#[tauri::command]
async fn path_status(path: String) -> &'static str {
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => "file",
        Ok(meta) if meta.is_dir() => "dir",
        Ok(_) => "other",
        Err(e) => match e.kind() {
            std::io::ErrorKind::NotFound => "missing",
            std::io::ErrorKind::PermissionDenied => "denied",
            _ => "error",
        },
    }
}

// Reading through the `fs` plugin adds large fixed latency per open on
// macOS/WKWebView. A direct app command reads the file itself.
//
// `async` on purpose: the read itself is slow on this machine (endpoint
// security / synced-folder scanning adds seconds per open — the IPC round-trip
// is ~1ms). A sync command would run on the main thread and freeze the UI; an
// async command runs off it, so the window stays responsive during the read.
//
// Confined to the folder the user opened, plus the bundled resource dir for the
// built-in examples. `root` is the folder the window is currently browsing, so
// a document can only ever pull in files the user already granted access to by
// opening that folder — a crafted relative link cannot escape it.
//
// Confining to the *home* dir instead (as this did until 0.11.1) got the threat
// model backwards: it allowed ~/.ssh and ~/.aws while refusing every folder
// outside home, so opening anything under /tmp, /Volumes or a repo cloned
// elsewhere failed even though the sidebar listed it fine.
//
// canonicalize resolves `..`/symlinks on both sides before comparing. Errors
// stay generic to avoid leaking paths.
#[tauri::command]
async fn read_document(
    app: tauri::AppHandle,
    path: String,
    root: String,
) -> Result<String, String> {
    let requested =
        std::fs::canonicalize(&path).map_err(|_| "cannot resolve path".to_string())?;

    let roots = [std::fs::canonicalize(&root).ok(), app.path().resource_dir().ok()]
        .into_iter()
        .flatten()
        .filter_map(|p| std::fs::canonicalize(p).ok());
    if !roots.into_iter().any(|allowed| requested.starts_with(&allowed)) {
        return Err("path outside the opened folder".to_string());
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
            path_status,
            ping,
            export_pdf,
            get_pending_open,
            open_new_window,
            set_window_title,
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

            let new_window = MenuItemBuilder::with_id("new_window", "New Window")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;

            let open_folder_new_window = MenuItemBuilder::with_id(
                "open_folder_new_window",
                "Open Folder in New Window…",
            )
            .accelerator("CmdOrCtrl+Shift+N")
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

            // Go menu: the window's own history. The frontend decides what each
            // step means for the window that is in front.
            let nav_back = MenuItemBuilder::with_id("nav_back", "Back")
                .accelerator("CmdOrCtrl+[")
                .build(app)?;
            let nav_forward = MenuItemBuilder::with_id("nav_forward", "Forward")
                .accelerator("CmdOrCtrl+]")
                .build(app)?;
            let nav_home = MenuItemBuilder::with_id("nav_home", "Home")
                .accelerator("CmdOrCtrl+Shift+H")
                .build(app)?;
            let nav_up = MenuItemBuilder::with_id("nav_up", "Enclosing Folder")
                .accelerator("CmdOrCtrl+Up")
                .build(app)?;
            let nav_close = MenuItemBuilder::with_id("nav_close_folder", "Close Folder")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(app)?;

            // Contents are filled in by rebuild_window_menu once the handle is
            // stored below; it appends the fixed items plus one entry per window.
            let window_menu = SubmenuBuilder::new(app, "Window").build()?;
            if let Ok(mut slot) = window_slot().lock() {
                *slot = Some(window_menu.clone());
            }

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
                        .items(&[&new_window])
                        .separator()
                        .items(&[&open_file, &open_folder, &open_folder_new_window])
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
                    &SubmenuBuilder::new(app, "Go")
                        .items(&[&nav_back, &nav_forward])
                        .separator()
                        .items(&[&nav_home, &nav_up])
                        .separator()
                        .items(&[&nav_close])
                        .build()?,
                    &window_menu,
                ])
                .build()?;

            app.set_menu(menu)?;

            if let Err(e) = rebuild_window_menu(app.handle()) {
                eprintln!("[menu] initial window list failed: {e}");
            }

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                match id {
                    // Handled entirely in Rust: no window needs to be involved,
                    // and the new window may be the first one (nothing focused).
                    "new_window" => {
                        if let Err(e) = open_new_window(app_handle.clone(), None) {
                            eprintln!("[menu] new window failed: {e}");
                        }
                    }
                    "open_file" => {
                        emit_to_focused(&app_handle, "menu-open-file", ());
                    }
                    "open_folder" => {
                        emit_to_focused(&app_handle, "menu-open-folder", ());
                    }
                    // The folder picker lives in the frontend (dialog plugin),
                    // so the frontmost window prompts and then asks Rust for a
                    // window on the chosen folder.
                    "open_folder_new_window" => {
                        emit_to_focused(&app_handle, "menu-open-folder-new-window", ());
                    }
                    "print" => {
                        emit_to_focused(&app_handle, "menu-print", ());
                    }
                    "export_pdf" => {
                        emit_to_focused(&app_handle, "menu-export-pdf", ());
                    }
                    "toggle_theme" => {
                        emit_to_focused(&app_handle, "menu-toggle-theme", ());
                    }
                    "preferences" => {
                        emit_to_focused(&app_handle, "menu-open-preferences", ());
                    }
                    "find" => {
                        emit_to_focused(&app_handle, "menu-find", ());
                    }
                    "recent_clear" => {
                        emit_to_focused(&app_handle, "menu-clear-recent", ());
                    }
                    "nav_back" | "nav_forward" | "nav_home" | "nav_up" | "nav_close_folder" => {
                        let step = &id["nav_".len()..];
                        emit_to_focused(&app_handle, "menu-nav", step.to_string());
                    }
                    BRING_ALL_TO_FRONT_ID => {
                        bring_all_to_front(&app_handle);
                    }
                    _ if id.starts_with(ARRANGE_PREFIX) => {
                        let action = &id[ARRANGE_PREFIX.len()..];
                        if let Err(e) = arrange_focused_window(&app_handle, action) {
                            eprintln!("[menu] arrange '{action}' failed: {e}");
                        }
                    }
                    // One entry per open window: bring the picked one forward.
                    _ if id.starts_with(WINDOW_ITEM_PREFIX) => {
                        let label = &id[WINDOW_ITEM_PREFIX.len()..];
                        if let Some(win) = app_handle.get_webview_window(label) {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                        // Focus moved, so the checkmark has to move with it. The
                        // Focused event does this too, but rebuilding here keeps
                        // the menu right even if focus is refused.
                        let _ = rebuild_window_menu(&app_handle);
                    }
                    _ if id.starts_with(RECENT_FILE_PREFIX) => {
                        let path = id[RECENT_FILE_PREFIX.len()..].to_string();
                        emit_to_focused(
                            &app_handle,
                            "menu-open-recent",
                            RecentOpen { kind: "file".into(), path },
                        );
                    }
                    _ if id.starts_with(RECENT_FOLDER_PREFIX) => {
                        let path = id[RECENT_FOLDER_PREFIX.len()..].to_string();
                        emit_to_focused(
                            &app_handle,
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
                    set_pending(MAIN_WINDOW_LABEL, p);
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
        // Keep the Window menu's list and checkmark in step with reality.
        if let tauri::RunEvent::WindowEvent {
            ref label,
            ref event,
            ..
        } = event
        {
            if matches!(
                event,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::Focused(true)
            ) {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Ok(mut saved) = pre_arrange().lock() {
                        saved.remove(label);
                    }
                }
                let _ = rebuild_window_menu(app_handle);
            }
        }

        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { ref urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if path.is_file() {
                        let path_str = path.to_string_lossy().to_string();
                        // Hot-start: a window already exists, the JS listener is
                        // registered. Emit to the frontmost one (falling back to
                        // any window) so the document replaces that window's
                        // content and not every window's.
                        if let Some(win) = focused_window(app_handle) {
                            let _ = app_handle.emit_to(win.label(), "open-file", path_str);
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        } else {
                            // Cold-start: Apple Events fired before setup completed.
                            // Buffer so the frontend can pull it on init.
                            set_pending(
                                MAIN_WINDOW_LABEL,
                                PendingOpen::File { path: path_str },
                            );
                        }
                    }
                }
            }
        }
        let _ = (app_handle, event);
    });
}
