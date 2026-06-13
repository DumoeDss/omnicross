// Tauri builder for the omnicross control panel. The frontend talks to the
// daemon admin API over HTTP — routed through the `tauri-plugin-http` plugin so
// the native layer bypasses browser CORS (the daemon sends no CORS headers and
// must not, being a token-free loopback service). On startup the app
// adopt-or-spawns the daemon (see `daemon_runtime`) and exposes an honest
// lifecycle status to the shell; a child it spawned is tree-killed on exit.

mod daemon_runtime;
mod kill;
mod ui_settings;

use tauri::{Manager, RunEvent, WindowEvent};

use daemon_runtime::{adopt_or_spawn, daemon_status, DaemonRuntime};
use ui_settings::{
    get_ui_settings, load_settings, set_ui_settings, setup_tray, UiSettingsState,
};

/// Ensure loopback hosts bypass any system/env HTTP proxy. The daemon is a
/// loopback-only service (127.0.0.1:8766); a global `HTTP(S)_PROXY` (e.g. Clash
/// on 127.0.0.1:7890) would otherwise route the app's `tauri-plugin-http` data
/// calls through the proxy, which typically 502s on a loopback target — leaving
/// every page empty even when the daemon is up. We append the loopback hosts to
/// `NO_PROXY`/`no_proxy` (merging, not clobbering) so `reqwest` (used by the http
/// plugin) bypasses the proxy for the daemon only. Other (non-loopback) traffic
/// is unaffected. Must run before the http plugin builds its client.
fn ensure_loopback_no_proxy() {
    const LOOPBACK: [&str; 2] = ["127.0.0.1", "localhost"];
    for key in ["NO_PROXY", "no_proxy"] {
        let current = std::env::var(key).unwrap_or_default();
        let mut hosts: Vec<String> = current
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        for h in LOOPBACK {
            if !hosts.iter().any(|x| x.eq_ignore_ascii_case(h)) {
                hosts.push(h.to_string());
            }
        }
        std::env::set_var(key, hosts.join(","));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Loopback daemon must never be proxied — set this BEFORE the http plugin
    // (and the adopt-or-spawn probe) build their reqwest clients.
    ensure_loopback_no_proxy();

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        // OS login-item management (the `auto_start` setting). LaunchAgent on
        // macOS; the registry Run key on Windows. No extra launch args.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(DaemonRuntime::new())
        .manage(UiSettingsState::default())
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            get_ui_settings,
            set_ui_settings
        ])
        .on_window_event(|window, event| {
            // close_to_tray: hide instead of exiting when the user closes the
            // window. With it off, the close proceeds → the app exits normally.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let hide = window
                    .state::<UiSettingsState>()
                    .0
                    .lock()
                    .map(|s| s.close_to_tray)
                    .unwrap_or(false);
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted UI settings into the managed state, build the tray,
            // and reveal the window unless the user opted into start-minimized.
            let settings = load_settings(&handle);
            {
                let state = app.state::<UiSettingsState>();
                *state.0.lock().unwrap() = settings.clone();
            }
            if let Err(err) = setup_tray(&handle, &settings.language) {
                eprintln!("[tray] failed to create system tray: {err}");
            }
            if !settings.start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

            // Run adopt-or-spawn off the setup thread so window creation is not
            // blocked by the probe / spawn / wait-for-port loop.
            let spawn_handle = handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                adopt_or_spawn(spawn_handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running omnicross-app")
        .run(|app, event| {
            // Tree-kill a daemon WE spawned on every clean exit path. Adopted
            // daemons (spawned == false) are left running — shutdown() no-ops.
            if let RunEvent::Exit | RunEvent::ExitRequested { .. } = event {
                app.state::<DaemonRuntime>().shutdown();
            }
        });
}
