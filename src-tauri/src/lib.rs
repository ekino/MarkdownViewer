use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
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
            export_pdf,
            get_pending_open
        ])
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // Build native menu
            let open_folder = MenuItemBuilder::with_id("open_folder", "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[
                    &SubmenuBuilder::new(app, "File")
                        .items(&[&open_folder])
                        .separator()
                        .close_window()
                        .build()?,
                ])
                .build()?;

            app.set_menu(menu)?;

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id().0 == "open_folder" {
                    let _ = app_handle.emit("menu-open-folder", ());
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
                        // Buffer for cold-start (frontend may not be listening yet)
                        // and emit for hot-start (frontend is up).
                        if let Ok(mut slot) = pending_slot().lock() {
                            *slot = Some(PendingOpen::File { path: path_str.clone() });
                        }
                        let _ = app_handle.emit("open-file", path_str);

                        let windows = app_handle.webview_windows();
                        if let Some(win) = windows.values().next() {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
            }
        }
        let _ = (app_handle, event);
    });
}
