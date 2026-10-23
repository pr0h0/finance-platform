// "Keep running in the tray when the window is closed" (Settings → General → Desktop app). Off by
// default: some Linux desktops (GNOME without the AppIndicator extension) accept a tray icon but never
// show it. Launching the app again shows the hidden window anyway (single-instance plugin). The choice
// is a marker file in the app config directory, so it holds before the web app has loaded.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime, State, Window, WindowEvent};

#[derive(Default)]
pub struct Tray {
    available: AtomicBool,
    close_to_tray: AtomicBool,
}

fn marker<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("close-to-tray"))
}

/// The tray icon exists: load the saved choice.
#[cfg_attr(mobile, allow(dead_code))]
pub fn ready<R: Runtime>(app: &AppHandle<R>) {
    let t = app.state::<Tray>();
    t.available.store(true, Ordering::SeqCst);
    let on = marker(app).is_some_and(|p| p.exists());
    t.close_to_tray.store(on, Ordering::SeqCst);
}

pub fn on_window_event<R: Runtime>(w: &Window<R>, e: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = e {
        let t = w.state::<Tray>();
        if w.label() == "main"
            && t.available.load(Ordering::SeqCst)
            && t.close_to_tray.load(Ordering::SeqCst)
        {
            api.prevent_close();
            let _ = w.hide();
        }
    }
}

#[derive(serde::Serialize)]
pub struct CloseToTray {
    available: bool,
    on: bool,
}

#[tauri::command]
pub fn close_to_tray_get(t: State<'_, Tray>) -> CloseToTray {
    CloseToTray {
        available: t.available.load(Ordering::SeqCst),
        on: t.close_to_tray.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn close_to_tray_set<R: Runtime>(
    app: AppHandle<R>,
    t: State<'_, Tray>,
    on: bool,
) -> Result<(), String> {
    if !t.available.load(Ordering::SeqCst) {
        return Err("no tray icon on this desktop".into());
    }
    let p = marker(&app).ok_or("no app config directory")?;
    if on {
        std::fs::create_dir_all(p.parent().ok_or("no app config directory")?)
            .map_err(|e| e.to_string())?;
        std::fs::write(&p, b"").map_err(|e| e.to_string())?;
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    t.close_to_tray.store(on, Ordering::SeqCst);
    Ok(())
}
