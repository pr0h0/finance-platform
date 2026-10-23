// Native shell for the shared web app (PLAN §37-39): one Tauri 2 project for Linux, Windows, macOS,
// Android and iOS. The UI is apps/web (bundled); this crate adds what a browser cannot do:
//   - durable local SQLite storage behind packages/storage's MemoryStore (store_* commands),
//   - the server token in the OS credential store (secret_* commands, secret.rs),
//   - HTTP without CORS to any compatible server (tauri-plugin-http), native notifications,
//   - saving exports/backups through the OS save dialog (dialog + fs plugins),
//   - desktop: system tray and a global "add transaction" shortcut; mobile: biometric unlock.
mod secret;
mod store;

#[cfg(desktop)]
use tauri::{Emitter, Manager};

/// Bring the main window forward and ask the web app to open quick entry.
#[cfg(desktop)]
fn quick_add(app: &tauri::AppHandle) {
    show_main(app);
    let _ = app.emit("native:quick-add", ());
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(desktop)]
const QUICK_ADD_SHORTCUT: &str = "CommandOrControl+Shift+E";

/// Polls the test server for an expression, evaluates it, posts the result back. Short polls: a
/// response held open for seconds never reaches the page in WKWebView.
#[cfg(debug_assertions)]
const DRIVER: &str = r#"async (u) => {
  if (window.__finplatDriver) return;
  window.__finplatDriver = true;
  for (;;) {
    try {
      const r = await fetch(u + '/next');
      if (r.status !== 200) { await new Promise((r) => setTimeout(r, 100)); continue; }
      const { id, expr } = await r.json();
      let body;
      try { body = { id, value: await (0, eval)(expr) }; } catch (e) { body = { id, error: String(e && e.stack || e) }; }
      await fetch(u + '/result', { method: 'POST', body: JSON.stringify(body) });
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // A second launch focuses the running app instead of opening another database connection.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
            // Settings → General → "Start at login" (off by default)
            .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            quick_add(app);
                        }
                    })
                    .build(),
            );
    }
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_biometric::init());
    }

    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        // Save dialog + writing the chosen file (exports, backups, attachments): fs may write only
        // where the user picked in the dialog (no static fs scope in capabilities).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .on_page_load(|_webview, _payload| {
            // Debug builds only: tests/native/apple-smoke.ts drives the app through a local test
            // server (macOS and the iOS simulator have no WebDriver/CDP for WKWebView).
            #[cfg(debug_assertions)]
            if _payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Ok(url) = std::env::var("FINPLAT_DRIVER") {
                    let _ = _webview.eval(format!("({DRIVER})({url:?})"));
                }
            }
        })
        .manage(store::Stores::default())
        .invoke_handler(tauri::generate_handler![
            store::store_load,
            store::store_commit,
            store::store_destroy,
            secret::secret_get,
            secret::secret_set,
            secret::secret_delete
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let open = MenuItem::with_id(app, "open", "Open Finance Platform", true, None::<&str>)?;
                let add = MenuItem::with_id(app, "quick_add", "Add transaction", true, Some(QUICK_ADD_SHORTCUT))?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &add, &quit])?;
                let mut tray = TrayIconBuilder::with_id("main")
                    .tooltip("Finance Platform")
                    .menu(&menu)
                    .on_menu_event(|app, e| match e.id.as_ref() {
                        "open" => show_main(app),
                        "quick_add" => quick_add(app),
                        "quit" => app.exit(0),
                        _ => {}
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                // A desktop without a tray (some Linux sessions) still runs the app.
                if let Err(e) = tray.build(app) {
                    eprintln!("tray unavailable: {e}");
                }
                // Global shortcuts can be taken by another app or unsupported (Wayland): not fatal.
                if let Err(e) = app.global_shortcut().register(QUICK_ADD_SHORTCUT) {
                    eprintln!("global shortcut {QUICK_ADD_SHORTCUT} unavailable: {e}");
                }
            }
            #[cfg(mobile)]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Finance Platform app");
}
