// Native menu construction.
//
// Two entry points:
//   - `build_menu(app)` — initial menu built during `setup`.
//   - `rebuild_with_recents(app, items)` — called by the renderer via the
//     `update_menu_recents` command whenever the recents list changes,
//     so the Open Recent submenu reflects current state.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager, Wry};

#[derive(serde::Deserialize, Clone)]
pub struct RecentMenuItem {
    pub kind: String, // "file" | "folder"
    pub path: String,
    pub label: String,
    pub enabled: bool, // false when path is missing on disk
}

// Stable IDs for menu events. Renderer subscribes to these via `app.listen`.
pub const ID_OPEN_FILE: &str = "open_file";
pub const ID_OPEN_FOLDER: &str = "open_folder";
pub const ID_OPEN_RECENT_PREFIX: &str = "open_recent:";
pub const ID_CLEAR_RECENTS: &str = "clear_recents";
pub const ID_CLOSE_FOLDER: &str = "close_folder";
pub const ID_SAVE: &str = "save";
pub const ID_EXPORT_PDF: &str = "export_pdf";
pub const ID_EXPORT_HTML: &str = "export_html";
pub const ID_EXPORT_HTML_ASSETS: &str = "export_html_assets";
pub const ID_EXPORT_MD: &str = "export_md";
pub const ID_SHARE: &str = "share";
pub const ID_PRINT: &str = "print";
pub const ID_PREFERENCES: &str = "preferences";

pub fn build_menu(app: &tauri::App) -> tauri::Result<Menu<Wry>> {
    build_menu_inner(app.app_handle(), &[], false, false)
}

pub fn rebuild(
    app: &AppHandle,
    recents: &[RecentMenuItem],
    folder_open: bool,
    file_open: bool,
) -> tauri::Result<Menu<Wry>> {
    build_menu_inner(app, recents, folder_open, file_open)
}

fn build_menu_inner<M: tauri::Manager<Wry>>(
    app: &M,
    recents: &[RecentMenuItem],
    folder_open: bool,
    file_open: bool,
) -> tauri::Result<Menu<Wry>> {
    let app_handle = app.app_handle();

    let open_file = MenuItemBuilder::with_id(ID_OPEN_FILE, "Open File…")
        .accelerator("CmdOrCtrl+O")
        .build(app_handle)?;

    let open_folder = MenuItemBuilder::with_id(ID_OPEN_FOLDER, "Open Folder…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app_handle)?;

    let preferences = MenuItemBuilder::with_id(ID_PREFERENCES, "Preferences…")
        .accelerator("CmdOrCtrl+,")
        .build(app_handle)?;

    // Save replays the last export the user did on this file; falls back
    // to PDF when nothing has been exported yet (renderer-side logic).
    let save = MenuItemBuilder::with_id(ID_SAVE, "Save")
        .accelerator("CmdOrCtrl+S")
        .enabled(file_open)
        .build(app_handle)?;

    // Each export format is its own menu item so the native save dialog
    // shows a single, accurate filter — Tauri's save() doesn't surface a
    // format picker inside the OS dialog.
    let export_pdf = MenuItemBuilder::with_id(ID_EXPORT_PDF, "Export as PDF…")
        .accelerator("CmdOrCtrl+E")
        .enabled(file_open)
        .build(app_handle)?;
    let export_html = MenuItemBuilder::with_id(ID_EXPORT_HTML, "Export as HTML…")
        .enabled(file_open)
        .build(app_handle)?;
    let export_html_assets =
        MenuItemBuilder::with_id(ID_EXPORT_HTML_ASSETS, "Export as HTML with assets…")
            .enabled(file_open)
            .build(app_handle)?;
    let export_md = MenuItemBuilder::with_id(ID_EXPORT_MD, "Copy source markdown…")
        .enabled(file_open)
        .build(app_handle)?;

    let export_submenu = SubmenuBuilder::new(app_handle, "Export")
        .items(&[&export_pdf, &export_html, &export_html_assets, &export_md])
        .build()?;

    #[cfg(target_os = "macos")]
    let share = MenuItemBuilder::with_id(ID_SHARE, "Share…")
        .enabled(file_open)
        .build(app_handle)?;

    let print = MenuItemBuilder::with_id(ID_PRINT, "Print…")
        .accelerator("CmdOrCtrl+P")
        .enabled(file_open)
        .build(app_handle)?;

    let close_folder = MenuItemBuilder::with_id(ID_CLOSE_FOLDER, "Close Folder")
        .accelerator("CmdOrCtrl+Shift+W")
        .enabled(folder_open)
        .build(app_handle)?;

    // Open Recent submenu. When the list is empty we show a single
    // disabled "(empty)" item so the submenu is still discoverable.
    let recent_submenu = {
        let mut sub = SubmenuBuilder::new(app_handle, "Open Recent");
        if recents.is_empty() {
            let placeholder = MenuItemBuilder::with_id("recent_empty", "(no recent items)")
                .enabled(false)
                .build(app_handle)?;
            sub = sub.item(&placeholder);
        } else {
            for (i, r) in recents.iter().enumerate() {
                let id = format!("{ID_OPEN_RECENT_PREFIX}{i}");
                let label = if r.enabled {
                    r.label.clone()
                } else {
                    format!("{} (missing)", r.label)
                };
                let item = MenuItemBuilder::with_id(id, &label)
                    .enabled(r.enabled)
                    .build(app_handle)?;
                sub = sub.item(&item);
            }
            sub = sub.separator();
            let clear = MenuItemBuilder::with_id(ID_CLEAR_RECENTS, "Clear Recent")
                .build(app_handle)?;
            sub = sub.item(&clear);
        }
        sub.build()?
    };

    let app_name = app_handle.package_info().name.clone();

    MenuBuilder::new(app_handle)
        .items(&[
            &SubmenuBuilder::new(app_handle, &app_name)
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
            &{
                let mut file_menu = SubmenuBuilder::new(app_handle, "File");
                file_menu = file_menu.items(&[&open_file, &open_folder]);
                file_menu = file_menu.item(&recent_submenu);
                file_menu = file_menu.item(&PredefinedMenuItem::separator(app_handle)?);
                file_menu = file_menu.items(&[&close_folder, &save]);
                file_menu = file_menu.item(&export_submenu);
                #[cfg(target_os = "macos")]
                {
                    file_menu = file_menu.item(&share);
                }
                file_menu = file_menu.items(&[&print]);
                file_menu = file_menu.separator();
                file_menu = file_menu.close_window();
                file_menu.build()?
            },
        ])
        .build()
}

// Resolve a menu event ID back to its semantic kind so lib.rs can dispatch
// without re-encoding the ID format in two places.
pub enum MenuEvent {
    OpenFile,
    OpenFolder,
    OpenRecent(usize),
    ClearRecents,
    CloseFolder,
    Save,
    ExportPdf,
    ExportHtml,
    ExportHtmlAssets,
    ExportMd,
    Share,
    Print,
    Preferences,
    Unknown,
}

pub fn classify_event(id: &str) -> MenuEvent {
    match id {
        ID_OPEN_FILE => MenuEvent::OpenFile,
        ID_OPEN_FOLDER => MenuEvent::OpenFolder,
        ID_CLEAR_RECENTS => MenuEvent::ClearRecents,
        ID_CLOSE_FOLDER => MenuEvent::CloseFolder,
        ID_SAVE => MenuEvent::Save,
        ID_EXPORT_PDF => MenuEvent::ExportPdf,
        ID_EXPORT_HTML => MenuEvent::ExportHtml,
        ID_EXPORT_HTML_ASSETS => MenuEvent::ExportHtmlAssets,
        ID_EXPORT_MD => MenuEvent::ExportMd,
        ID_SHARE => MenuEvent::Share,
        ID_PRINT => MenuEvent::Print,
        ID_PREFERENCES => MenuEvent::Preferences,
        s if s.starts_with(ID_OPEN_RECENT_PREFIX) => s[ID_OPEN_RECENT_PREFIX.len()..]
            .parse::<usize>()
            .map(MenuEvent::OpenRecent)
            .unwrap_or(MenuEvent::Unknown),
        _ => MenuEvent::Unknown,
    }
}
