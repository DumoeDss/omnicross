// log_export.rs — the desktop half of the daemon log export (bug reports).
//
// The WEBVIEW fetches the redacted bundle from the daemon admin API
// (`GET /admin/api/logs/export`) — Rust never touches the daemon's log files
// or its admin auth. This command is only the SAVE half: a native save dialog
// (tauri-plugin-dialog's Rust-side API; no webview capability is granted)
// followed by a plain file write. Returns the chosen path, or `None` when the
// user dismissed the dialog.
//
// `open_logs_folder` is the other half of the diagnostics story: reveal the
// daemon's logs directory in the OS file manager (tray menu + Settings →
// About).

use std::fs;
use std::process::Command;
use std::sync::mpsc;

use tauri::{AppHandle, Manager, Runtime};

/// Native save dialog pre-named with the export filename, then write the
/// bundle. `Ok(None)` = cancelled by the user.
#[tauri::command]
pub async fn save_log_export<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // The dialog reports its outcome through a callback (fired on user action);
    // bridge it back to this command with a one-shot channel. Blocking `recv`
    // parks one async-runtime worker until the user decides — fine for a
    // one-shot user action.
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&filename)
        .add_filter("Log files", &["log", "txt"])
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    let Some(chosen) = rx.recv().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = match chosen {
        tauri_plugin_dialog::FilePath::Url(url) => url
            .to_file_path()
            .map_err(|_| "unsupported save location".to_string())?,
        tauri_plugin_dialog::FilePath::Path(path) => path,
    };
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Reveal `<appDataDir>/logs` in the OS file manager — the directory the
/// daemon logs to (`logs/daemon.log`, spawned with a config in appDataDir) and
/// the stderr drain appends to. Created first so a fresh install opens a real
/// folder instead of a fallback location. Shared by the tray menu item and the
/// Settings → About button.
#[tauri::command]
pub fn open_logs_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create logs dir: {e}"))?;
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string());
    // (explorer exits 1 even on success, so only the spawn is checked)
    #[cfg(target_os = "macos")]
    let result = open_with_status(Command::new("open").arg(&dir));
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = open_with_status(Command::new("xdg-open").arg(&dir));
    result
}

/// Wait for the opener and fold a non-zero exit into an error (macOS/Linux).
#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn open_with_status(cmd: &mut Command) -> Result<(), String> {
    cmd.status().map_err(|e| e.to_string()).and_then(|s| {
        if s.success() {
            Ok(())
        } else {
            Err(format!("folder opener exited with {s}"))
        }
    })
}
