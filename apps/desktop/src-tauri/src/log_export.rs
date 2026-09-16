// log_export.rs — the desktop half of the daemon log export (bug reports).
//
// The WEBVIEW fetches the redacted bundle from the daemon admin API
// (`GET /admin/api/logs/export`) — Rust never touches the daemon's log files
// or its admin auth. This command is only the SAVE half: a native save dialog
// (tauri-plugin-dialog's Rust-side API; no webview capability is granted)
// followed by a plain file write. Returns the chosen path, or `None` when the
// user dismissed the dialog.

use std::fs;
use std::sync::mpsc;

use tauri::{AppHandle, Runtime};

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
