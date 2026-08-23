// ui_settings.rs — desktop UI preferences (tray behavior + startup + language)
// persisted to <app_config_dir>/ui-settings.json, plus the system tray.
//
// The renderer reads/writes these via the `get_ui_settings` / `set_ui_settings`
// commands. Three of them are enforced natively:
//   - close_to_tray   → CloseRequested hides the window instead of exiting.
//   - start_minimized → the window stays hidden at startup (shown via the tray).
//   - auto_start      → OS login item, via tauri-plugin-autostart.
// `language` is mirrored here only so the tray menu can be localized; the
// renderer keeps its own i18n source of truth.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_autostart::ManagerExt;

use crate::update_manager::DesktopUpdateManager;

const TRAY_ID: &str = "omnicross-tray";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    #[serde(default)]
    pub close_to_tray: bool,
    #[serde(default)]
    pub start_minimized: bool,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub auto_download_updates: bool,
}

/// First-run default language: follow the system locale (`zh*` → Chinese),
/// falling back to English. Used by `Default` and serde's missing-field default,
/// so a fresh install (no settings file yet) localizes the tray to the OS — the
/// renderer mirrors this via `navigator.language`.
fn default_language() -> String {
    let locale = sys_locale::get_locale().unwrap_or_default();
    if locale.to_lowercase().starts_with("zh") {
        "zh".to_string()
    } else {
        "en".to_string()
    }
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            close_to_tray: false,
            start_minimized: false,
            language: default_language(),
            auto_download_updates: false,
        }
    }
}

/// Tauri-managed live copy (the CloseRequested handler + tray read it).
pub struct UiSettingsState(pub Mutex<UiSettings>);

impl Default for UiSettingsState {
    fn default() -> Self {
        Self(Mutex::new(UiSettings::default()))
    }
}

/// The shape returned to the renderer (camelCase; includes the OS autostart bit).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettingsView {
    close_to_tray: bool,
    start_minimized: bool,
    language: String,
    auto_start: bool,
    auto_download_updates: bool,
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("ui-settings.json"))
}

/// Read the persisted settings (defaults when missing/corrupt).
pub fn load_settings<R: Runtime>(app: &AppHandle<R>) -> UiSettings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist<R: Runtime>(app: &AppHandle<R>, settings: &UiSettings) {
    if let Some(path) = settings_path(app) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            let _ = fs::write(path, json);
        }
    }
}

#[tauri::command]
pub fn get_ui_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UiSettingsState>,
) -> UiSettingsView {
    let s = state.0.lock().unwrap().clone();
    let auto_start = app.autolaunch().is_enabled().unwrap_or(false);
    UiSettingsView {
        close_to_tray: s.close_to_tray,
        start_minimized: s.start_minimized,
        language: s.language,
        auto_start,
        auto_download_updates: s.auto_download_updates,
    }
}

/// Partial update from the renderer — a single struct arg (serde handles the
/// camelCase field names, so there is no JS↔Rust arg-name conversion to depend on).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiSettingsPatch {
    close_to_tray: Option<bool>,
    start_minimized: Option<bool>,
    language: Option<String>,
    auto_start: Option<bool>,
    auto_download_updates: Option<bool>,
}

fn apply_persistent_patch(settings: &mut UiSettings, patch: &UiSettingsPatch) -> bool {
    if let Some(v) = patch.close_to_tray {
        settings.close_to_tray = v;
    }
    if let Some(v) = patch.start_minimized {
        settings.start_minimized = v;
    }
    let mut language_changed = false;
    if let Some(v) = patch.language.as_ref() {
        language_changed = v != &settings.language;
        settings.language = v.clone();
    }
    if let Some(v) = patch.auto_download_updates {
        settings.auto_download_updates = v;
    }
    language_changed
}

#[tauri::command]
pub fn set_ui_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UiSettingsState>,
    patch: UiSettingsPatch,
) -> Result<(), String> {
    let auto_download_changed = patch.auto_download_updates;
    let language_changed;
    {
        let mut s = state.0.lock().unwrap();
        language_changed = apply_persistent_patch(&mut s, &patch);
        persist(&app, &s);
    }
    if let Some(enable) = patch.auto_start {
        let manager = app.autolaunch();
        let result = if enable {
            manager.enable()
        } else {
            manager.disable()
        };
        result.map_err(|e| e.to_string())?;
    }
    if language_changed {
        refresh_tray_menu(&app);
    }
    if let Some(enabled) = auto_download_changed {
        if let Some(manager) = app.try_state::<DesktopUpdateManager>() {
            let manager = manager.inner().clone();
            if manager.preference_changed(enabled) {
                tauri::async_runtime::spawn(async move {
                    manager.download_automatically().await;
                });
            }
        }
    }
    Ok(())
}

fn tray_labels(language: &str) -> (&'static str, &'static str) {
    if language.starts_with("zh") {
        ("显示", "退出")
    } else {
        ("Show", "Quit")
    }
}

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<Menu<R>> {
    let (show, quit) = tray_labels(language);
    let show_item = MenuItem::with_id(app, "tray-show", show, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show_item, &quit_item])
}

/// Bring the main window to the foreground (tray click / "Show").
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn refresh_tray_menu<R: Runtime>(app: &AppHandle<R>) {
    let language = app
        .state::<UiSettingsState>()
        .0
        .lock()
        .unwrap()
        .language
        .clone();
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_tray_menu(app, &language)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Build the system tray (icon + localized Show/Quit menu, left-click reveals).
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<()> {
    let menu = build_tray_menu(app, language)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Omnicross")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_json_defaults_auto_download_without_changing_existing_values() {
        let settings: UiSettings =
            serde_json::from_str(r#"{"closeToTray":true,"startMinimized":true,"language":"zh"}"#)
                .unwrap();
        assert!(settings.close_to_tray);
        assert!(settings.start_minimized);
        assert_eq!(settings.language, "zh");
        assert!(!settings.auto_download_updates);
    }

    #[test]
    fn settings_round_trip_preserves_auto_download() {
        let settings = UiSettings {
            close_to_tray: true,
            start_minimized: false,
            language: "en".into(),
            auto_download_updates: true,
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"autoDownloadUpdates\":true"));
        assert_eq!(serde_json::from_str::<UiSettings>(&json).unwrap(), settings);
    }

    #[test]
    fn patch_changes_only_supplied_fields() {
        let mut settings = UiSettings {
            close_to_tray: true,
            start_minimized: true,
            language: "zh".into(),
            auto_download_updates: false,
        };
        let changed = apply_persistent_patch(
            &mut settings,
            &UiSettingsPatch {
                auto_download_updates: Some(true),
                ..UiSettingsPatch::default()
            },
        );
        assert!(!changed);
        assert!(settings.close_to_tray);
        assert!(settings.start_minimized);
        assert_eq!(settings.language, "zh");
        assert!(settings.auto_download_updates);
    }

    #[test]
    fn corrupt_json_uses_safe_defaults() {
        let settings = serde_json::from_str::<UiSettings>("{broken")
            .ok()
            .unwrap_or_default();
        assert!(!settings.close_to_tray);
        assert!(!settings.start_minimized);
        assert!(!settings.auto_download_updates);
    }
}
