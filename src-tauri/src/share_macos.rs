// macOS share sheet via NSSharingServicePicker.
//
// Anchored to the active webview's NSView, positioned to a renderer-
// supplied rect (the share button's bounding box in webview coords).
// Falls back to the window's center when the rect is unusable so a
// malformed input doesn't crash AppKit.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_app_kit::{NSSharingServicePicker, NSView};
use objc2_foundation::{NSArray, NSRect, NSRectEdge, NSString, NSURL};

#[derive(serde::Deserialize)]
pub struct AnchorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const MAX_PATHS: usize = 32;

fn sanitize_rect(r: AnchorRect, view: &NSView) -> NSRect {
    // Use NSRect-compatible CGFloat (f64 on modern macOS).
    let bounds = view.bounds();
    let bw = bounds.size.width;
    let bh = bounds.size.height;

    let finite = r.x.is_finite() && r.y.is_finite() && r.width.is_finite() && r.height.is_finite();
    let positive = r.width > 0.0 && r.height > 0.0;
    if !finite || !positive {
        // Center fallback — a small rect in the middle of the view.
        let cw = 1.0_f64;
        let ch = 1.0_f64;
        return NSRect::new(
            objc2_foundation::NSPoint::new((bw - cw) / 2.0, (bh - ch) / 2.0),
            objc2_foundation::NSSize::new(cw, ch),
        );
    }
    let x = r.x.max(0.0).min(bw.max(1.0));
    let y = r.y.max(0.0).min(bh.max(1.0));
    let w = r.width.max(1.0).min(bw.max(1.0));
    let h = r.height.max(1.0).min(bh.max(1.0));
    NSRect::new(
        objc2_foundation::NSPoint::new(x, y),
        objc2_foundation::NSSize::new(w, h),
    )
}

#[tauri::command]
pub async fn share_macos(
    webview: tauri::Webview,
    paths: Vec<String>,
    anchor: AnchorRect,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no paths to share".into());
    }
    if paths.len() > MAX_PATHS {
        return Err("too many paths".into());
    }
    for p in &paths {
        if p.is_empty() || p.len() > 4096 {
            return Err("invalid path".into());
        }
        // Reject symlinks before we hand the path to AppKit: a symlink
        // whose target is sensitive (e.g. ~/.ssh/id_rsa) would be
        // shared as-is via AirDrop / Mail / Messages.
        let meta = std::fs::symlink_metadata(p)
            .map_err(|e| format!("stat failed: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("symlinked path rejected: {p}"));
        }
        if !std::path::Path::new(p).exists() {
            return Err(format!("path does not exist: {p}"));
        }
        // Crucially: only allow sharing files the renderer has
        // previously opened via the normal load pipeline. An XSS in the
        // webview can call share_macos directly, but it has no way to
        // make the backend believe a path is "active" — it would have
        // to call register_active_doc first, and that command is
        // equally available to legit code so this isn't a real
        // bypass for now; future hardening would gate
        // register_active_doc on a renderer-only origin check.
        if !crate::is_path_active_doc(p) {
            return Err(format!("path not registered as active doc: {p}"));
        }
    }

    webview
        .with_webview(move |wv| unsafe {
            // Build NSArray<AnyObject> from path strings (NSURL is an AnyObject).
            let urls: Vec<Retained<NSURL>> = paths
                .iter()
                .map(|p| {
                    let s = NSString::from_str(p);
                    NSURL::fileURLWithPath(&s)
                })
                .collect();
            let any_refs: Vec<&AnyObject> =
                urls.iter().map(|u| u.as_ref() as &AnyObject).collect();
            let items: Retained<NSArray<AnyObject>> = NSArray::from_slice(&any_refs);

            // Treat the WKWebView's pointer as an NSView — WKWebView is a
            // NSView subclass, so this cast is safe.
            let view: &NSView = &*(wv.inner().cast::<NSView>());
            let rect = sanitize_rect(anchor, view);

            let picker = NSSharingServicePicker::initWithItems(
                NSSharingServicePicker::alloc(),
                &items,
            );
            picker.showRelativeToRect_ofView_preferredEdge(
                rect,
                view,
                NSRectEdge::MinY,
            );
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}
