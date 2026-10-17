//! Native supervision of the control panel. The daemon never participates in recovery.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

const PROBE_INTERVAL: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const SUSPEND_GAP: Duration = Duration::from_secs(15);
const RETRY_WINDOW: Duration = Duration::from_secs(300);
const MAX_ATTEMPTS: usize = 3;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Action {
    Reload,
    Rebuild,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Decision {
    Wait,
    Probe { generation: u64, sequence: u64 },
    Recover(Action),
    Exhausted,
}

struct Watchdog {
    generation: u64,
    sequence: u64,
    pending_probe: Option<(u64, Instant)>,
    last_probe: Instant,
    last_tick: Instant,
    pending_action: Option<Action>,
    active_action: Option<Action>,
    attempts: VecDeque<Instant>,
    limit_reported: bool,
    window_gap: bool,
    stopped: bool,
}

impl Watchdog {
    fn new(now: Instant) -> Self {
        Self {
            generation: 0,
            sequence: 0,
            pending_probe: None,
            last_probe: now,
            last_tick: now,
            pending_action: None,
            active_action: None,
            attempts: VecDeque::new(),
            limit_reported: false,
            window_gap: false,
            stopped: false,
        }
    }

    fn request(&mut self, generation: u64, action: Action) {
        if self.stopped || self.limit_reported || generation != self.generation {
            return;
        }
        // Repeated renderer notifications during a reload wait for its heartbeat.
        // A browser exit always upgrades that reload to a complete rebuild.
        if action == Action::Reload && self.active_action.is_some() {
            return;
        }
        self.pending_action = Some(self.pending_action.map_or(action, |old| old.max(action)));
    }

    fn acknowledge(&mut self, generation: u64, sequence: u64) -> bool {
        if !self.stopped
            && generation == self.generation
            && self.pending_probe.map(|p| p.0) == Some(sequence)
        {
            self.pending_probe = None;
            return self.active_action.take().is_some();
        }
        false
    }

    fn prevent_exit(&self, code: Option<i32>, main_exists: bool) -> bool {
        code.is_none() && !self.stopped && (self.window_gap || main_exists)
    }

    fn poll(&mut self, now: Instant, visible: bool) -> Decision {
        if self.stopped || self.limit_reported {
            return Decision::Wait;
        }
        if !visible || now.duration_since(self.last_tick) > SUSPEND_GAP {
            self.pending_probe = None;
            self.last_probe = now;
        }
        self.last_tick = now;
        if self
            .pending_probe
            .is_some_and(|(_, sent)| now.duration_since(sent) >= PROBE_TIMEOUT)
        {
            let action = if self.active_action.is_some() {
                Action::Rebuild
            } else {
                Action::Reload
            };
            self.pending_action = Some(self.pending_action.map_or(action, |old| old.max(action)));
            self.pending_probe = None;
        }
        while self
            .attempts
            .front()
            .is_some_and(|at| now.duration_since(*at) >= RETRY_WINDOW)
        {
            self.attempts.pop_front();
        }
        if let Some(action) = self.pending_action.take() {
            if self.attempts.len() >= MAX_ATTEMPTS {
                self.limit_reported = true;
                return Decision::Exhausted;
            }
            self.limit_reported = false;
            self.attempts.push_back(now);
            self.active_action = Some(action);
            self.pending_probe = None;
            self.last_probe = now;
            if action == Action::Rebuild {
                // Invalidate events and heartbeat replies from the old control BEFORE closing it.
                self.generation += 1;
                self.window_gap = true;
            }
            return Decision::Recover(action);
        }
        if visible
            && self.pending_probe.is_none()
            && now.duration_since(self.last_probe) >= PROBE_INTERVAL
        {
            self.sequence += 1;
            self.pending_probe = Some((self.sequence, now));
            self.last_probe = now;
            return Decision::Probe {
                generation: self.generation,
                sequence: self.sequence,
            };
        }
        Decision::Wait
    }
}

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State, Webview};

pub struct RecoveryState(Arc<Mutex<Watchdog>>);

impl Default for RecoveryState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Watchdog::new(Instant::now()))))
    }
}

#[tauri::command]
pub fn webview_recovery_heartbeat(
    webview: Webview,
    state: State<'_, RecoveryState>,
    generation: u64,
    sequence: u64,
) {
    if webview.label() != "main" {
        return;
    }
    let recovered = state.0.lock().unwrap().acknowledge(generation, sequence);
    if recovered {
        platform::log(webview.app_handle(), "page heartbeat restored");
    }
}

pub fn prevent_exit(app: &AppHandle, code: Option<i32>) -> bool {
    let main_exists = app.get_webview_window("main").is_some();
    app.state::<RecoveryState>()
        .0
        .lock()
        .unwrap()
        .prevent_exit(code, main_exists)
}

pub fn stop(app: &AppHandle) {
    app.state::<RecoveryState>().0.lock().unwrap().stopped = true;
}

pub fn install(app: &AppHandle) {
    #[cfg(windows)]
    platform::install(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(not(windows))]
mod platform {
    pub fn log(_app: &tauri::AppHandle, _message: &str) {}
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::Weak;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WebviewWindowBuilder};
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{BrowserProcessExitedEventHandler, ProcessFailedEventHandler};
    use windows::core::Interface;

    fn log_path(app: &AppHandle) -> Option<PathBuf> {
        app.path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("logs/webview-recovery.log"))
    }

    fn append_log(path: &Path, message: &str) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let truncate = fs::metadata(path).is_ok_and(|m| m.len() > 128 * 1024);
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .write(true)
            .append(!truncate)
            .truncate(truncate)
            .open(path)
        {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let _ = writeln!(file, "{timestamp} [webview-recovery] {message}");
        }
    }

    pub fn log(app: &AppHandle, message: &str) {
        eprintln!("[webview-recovery] {message}");
        if let Some(path) = log_path(app) {
            append_log(&path, message);
        }
    }

    fn signal(state: &Weak<Mutex<Watchdog>>, generation: u64, action: Action) {
        if let Some(state) = state.upgrade() {
            state.lock().unwrap().request(generation, action);
        }
    }

    fn attach(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
        let state = app.state::<RecoveryState>();
        let generation = state.0.lock().unwrap().generation;
        let weak = Arc::downgrade(&state.0);
        let path = log_path(app);
        window.with_webview(move |platform| {
            // COM interfaces and callbacks stay on the WebView2 UI thread. Callbacks
            // only enqueue work; creating a WebView inside them can deadlock.
            let result = (|| unsafe {
                let core = platform.controller().CoreWebView2()?;
                let process_state = weak.clone();
                let process_path = path.clone();
                let mut token = 0;
                core.add_ProcessFailed(
                    &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                            args.ProcessFailedKind(&mut kind)?;
                            let action = match kind {
                                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
                                    Some(Action::Rebuild)
                                }
                                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                                | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
                                    Some(Action::Reload)
                                }
                                // GPU and utility process failures are recovered by WebView2.
                                // If that fails, the native heartbeat still detects an unresponsive page.
                                _ => None,
                            };
                            if let Some(action) = action {
                                if let Some(path) = &process_path {
                                    append_log(
                                        path,
                                        &format!(
                                            "process failure kind={} generation={generation}",
                                            kind.0
                                        ),
                                    );
                                }
                                signal(&process_state, generation, action);
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                let environment: ICoreWebView2Environment5 = platform.environment().cast()?;
                environment.add_BrowserProcessExited(
                    &BrowserProcessExitedEventHandler::create(Box::new(move |_, _| {
                        signal(&weak, generation, Action::Rebuild);
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok::<_, windows::core::Error>(())
            })();
            if let Err(error) = result {
                if let Some(path) = path {
                    append_log(&path, &format!("event registration failed: {error}"));
                }
            }
        })
    }

    #[derive(Default)]
    struct WindowSnapshot {
        visible: bool,
        minimized: bool,
        maximized: bool,
        fullscreen: bool,
        focused: bool,
        position: Option<PhysicalPosition<i32>>,
        size: Option<PhysicalSize<u32>>,
    }

    fn rebuild(app: &AppHandle, snapshot: &mut Option<WindowSnapshot>) -> Result<(), String> {
        if let Some(old) = app.get_webview_window("main") {
            *snapshot = Some(WindowSnapshot {
                visible: old.is_visible().unwrap_or(false),
                minimized: old.is_minimized().unwrap_or(false),
                maximized: old.is_maximized().unwrap_or(false),
                fullscreen: old.is_fullscreen().unwrap_or(false),
                focused: old.is_focused().unwrap_or(false),
                position: old.outer_position().ok(),
                size: old.inner_size().ok(),
            });
            old.destroy().map_err(|e| e.to_string())?;
        }
        // destroy() dispatches asynchronously. Wait for Tauri to release the label.
        let deadline = Instant::now() + Duration::from_secs(3);
        while app.get_webview_window("main").is_some() {
            if Instant::now() >= deadline {
                return Err("old window did not close".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
        if app.state::<RecoveryState>().0.lock().unwrap().stopped {
            return Err("application is exiting".into());
        }
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|w| w.label == "main")
            .ok_or("main window configuration missing")?;
        let window = WebviewWindowBuilder::from_config(app, config)
            .map_err(|e| e.to_string())?
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
        attach(app, &window).map_err(|e| e.to_string())?;
        if let Some(saved) = snapshot.as_ref() {
            if let Some(size) = saved.size {
                let _ = window.set_size(size);
            }
            if let Some(position) = saved.position {
                let _ = window.set_position(position);
            }
            if saved.maximized {
                let _ = window.maximize();
            }
            if saved.fullscreen {
                let _ = window.set_fullscreen(true);
            }
            if saved.visible {
                let _ = window.show();
            }
            if saved.minimized {
                let _ = window.minimize();
            }
            if saved.focused && saved.visible && !saved.minimized {
                let _ = window.set_focus();
            }
        }
        app.state::<RecoveryState>().0.lock().unwrap().window_gap = false;
        Ok(())
    }

    pub fn install(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = attach(app, &window) {
                log(app, &format!("cannot attach process monitor: {error}"));
            }
        }
        let app = app.clone();
        let worker_app = app.clone();
        if let Err(error) = thread::Builder::new().name("webview-recovery".into()).spawn(move || {
            let app = worker_app;
            let mut snapshot = None;
            loop {
                thread::sleep(Duration::from_secs(1));
                if app.state::<RecoveryState>().0.lock().unwrap().stopped { break; }
                let window = app.get_webview_window("main");
                let visible = window.as_ref().is_some_and(|w| {
                    w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)
                });
                let decision = app.state::<RecoveryState>().0.lock().unwrap().poll(Instant::now(), visible);
                match decision {
                    Decision::Wait => {}
                    Decision::Probe { generation, sequence } => {
                        if let Some(window) = window {
                            // Probe from native code: no page timer can disappear with a crashed renderer.
                            let script = format!("window.__TAURI_INTERNALS__?.invoke('webview_recovery_heartbeat', {{generation:{generation},sequence:{sequence}}}).catch(() => {{}})");
                            let _ = window.eval(script);
                        }
                    }
                    Decision::Recover(action) => {
                        log(&app, &format!("attempting {action:?}"));
                        let result = match action {
                            Action::Reload => window.ok_or_else(|| "main window missing".to_string())
                                .and_then(|w| w.reload().map_err(|e| e.to_string())),
                            Action::Rebuild => {
                                // Drop the supervisor's old handle before rebuilding, too.
                                drop(window);
                                rebuild(&app, &mut snapshot)
                            }
                        };
                        if let Err(error) = result {
                            log(&app, &format!("recovery failed: {error}"));
                            let state = app.state::<RecoveryState>();
                            let mut state = state.0.lock().unwrap();
                            let generation = state.generation;
                            state.request(generation, Action::Rebuild);
                        }
                    }
                    Decision::Exhausted => {
                        log(&app, "automatic recovery stopped: three attempts within five minutes");
                        let chinese = app.state::<crate::ui_settings::UiSettingsState>()
                            .0.lock().unwrap().language.starts_with("zh");
                        let message = if chinese {
                            "页面连续恢复失败，已停止自动重试。请退出后重新打开 OmniCross，或在浏览器访问 http://127.0.0.1:8766/ui/。后台服务仍在运行。"
                        } else {
                            "The page could not recover after repeated attempts. Automatic retries have stopped. Restart OmniCross or open http://127.0.0.1:8766/ui/ in a browser. The background service is still running."
                        };
                        app.dialog().message(message).title("OmniCross")
                            .kind(MessageDialogKind::Error).show(|_| {});
                    }
                }
            }
        }) {
            log(&app, &format!("cannot start page supervisor: {error}"));
        }
    }

    /// Real WebView2 fault injection, isolated from the normal app profile and daemon.
    /// Run explicitly on a Windows desktop with `--features custom-protocol`.
    #[cfg(all(test, feature = "custom-protocol"))]
    #[test]
    #[ignore = "opens an isolated WebView2 window and crashes its browser and renderer"]
    fn native_browser_and_renderer_crashes_recover() {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        use std::sync::mpsc;
        use tauri::RunEvent;
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::w;

        fn wait_for(app: &AppHandle, check: impl Fn(&Watchdog) -> bool) -> Result<(), String> {
            let deadline = Instant::now() + Duration::from_secs(25);
            while Instant::now() < deadline {
                if check(&app.state::<RecoveryState>().0.lock().unwrap()) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err("timed out waiting for a healthy page heartbeat".into())
        }

        fn browser_pid(app: &AppHandle) -> Result<u32, String> {
            let (tx, rx) = mpsc::channel();
            app.get_webview_window("main")
                .ok_or("main window missing")?
                .with_webview(move |platform| {
                    let result = (|| unsafe {
                        let mut pid = 0;
                        platform
                            .controller()
                            .CoreWebView2()?
                            .BrowserProcessId(&mut pid)?;
                        Ok::<_, windows::core::Error>(pid)
                    })();
                    let _ = tx.send(result.map_err(|e| e.to_string()));
                })
                .map_err(|e| e.to_string())?;
            rx.recv_timeout(Duration::from_secs(3))
                .map_err(|e| e.to_string())?
        }

        let cache = std::env::temp_dir().join(format!(
            "omnicross-webview-recovery-test-{}",
            std::process::id()
        ));
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = format!(
            "io.github.dumoedss.omnicross.recoverytest{}",
            std::process::id()
        );
        let config = &mut context.config_mut().app.windows[0];
        config.data_directory = Some(cache.clone());
        config.title = "OmniCross recovery test".into();
        config.visible = true;
        config.width = 500.0;
        config.height = 300.0;
        config.min_width = None;
        config.min_height = None;
        let (outcome_tx, outcome_rx) = mpsc::channel();
        let app = tauri::Builder::default().any_thread()
            .plugin(tauri_plugin_dialog::init())
            .manage(RecoveryState::default())
            .manage(crate::ui_settings::UiSettingsState::default())
            .invoke_handler(tauri::generate_handler![webview_recovery_heartbeat])
            .setup(move |app| {
                // Do not call the normal startup: this test never starts, adopts, or stops a daemon.
                install(app.handle());
                let app = app.handle().clone();
                thread::spawn(move || {
                    let result = (|| -> Result<(), String> {
                        wait_for(&app, |s| s.sequence > 0 && s.pending_probe.is_none())?;
                        let before = browser_pid(&app)?;
                        let killed = Command::new("taskkill").args(["/PID", &before.to_string(), "/T", "/F"])
                            .creation_flags(0x0800_0000).output().map_err(|e| e.to_string())?;
                        if !killed.status.success() { return Err("could not terminate the isolated browser".into()); }
                        wait_for(&app, |s| s.generation == 1 && s.active_action.is_none())?;
                        let after = browser_pid(&app)?;
                        if before == after { return Err("browser process was not replaced".into()); }
                        println!("Browser crash recovered: {before} -> {after}; heartbeat confirmed");

                        let (tx, rx) = mpsc::channel();
                        app.get_webview_window("main").ok_or("recovered main window missing")?
                            .with_webview(move |platform| {
                                let result = (|| unsafe {
                                    platform.controller().CoreWebView2()?.CallDevToolsProtocolMethod(
                                        w!("Page.crash"), w!("{}"),
                                        &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(()))),
                                    )
                                })();
                                let _ = tx.send(result.map_err(|e| e.to_string()));
                            }).map_err(|e| e.to_string())?;
                        rx.recv_timeout(Duration::from_secs(3)).map_err(|e| e.to_string())??;
                        wait_for(&app, |s| s.attempts.len() == 2 && s.active_action.is_none())?;
                        if browser_pid(&app)? != after { return Err("renderer crash unnecessarily replaced the browser".into()); }
                        println!("Renderer crash recovered by reload; browser PID unchanged; heartbeat confirmed");
                        Ok(())
                    })();
                    let exit_code = if result.is_ok() { 0 } else { 1 };
                    let _ = outcome_tx.send(result);
                    app.exit(exit_code);
                });
                Ok(())
            }).build(context).expect("build isolated recovery test app");
        let code = app.run_return(|app, event| {
            if let RunEvent::ExitRequested { code, ref api, .. } = event {
                if super::prevent_exit(app, code) {
                    api.prevent_exit();
                    return;
                }
                super::stop(app);
            }
        });
        let result = outcome_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("recovery test worker finished");
        assert!(result.is_ok(), "{}", result.unwrap_err());
        assert_eq!(code, 0);
        // The path is generated beneath the OS temp directory and never points at a real profile.
        if cache.parent() == Some(std::env::temp_dir().as_path()) {
            let _ = fs::remove_dir_all(cache);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_browser_events_coalesce_and_old_controls_cannot_trigger_recovery() {
        let now = Instant::now();
        let mut w = Watchdog::new(now);
        w.request(0, Action::Reload);
        w.request(0, Action::Rebuild);
        w.request(0, Action::Rebuild);
        assert_eq!(w.poll(now, true), Decision::Recover(Action::Rebuild));
        assert_eq!(w.generation, 1);
        w.request(0, Action::Rebuild);
        assert_eq!(w.poll(now, true), Decision::Wait);
        assert_eq!(w.attempts.len(), 1);
    }

    #[test]
    fn unresponsive_reload_escalates_to_rebuild_when_javascript_never_answers() {
        let now = Instant::now();
        let mut w = Watchdog::new(now);
        w.request(0, Action::Reload);
        assert_eq!(w.poll(now, true), Decision::Recover(Action::Reload));
        let probe_at = now + PROBE_INTERVAL;
        assert!(matches!(w.poll(probe_at, true), Decision::Probe { .. }));
        // Poll normally: a long pause in the supervisor is a resume, not a hung page.
        for second in 6..35 {
            assert_eq!(
                w.poll(now + Duration::from_secs(second), true),
                Decision::Wait
            );
        }
        assert_eq!(
            w.poll(probe_at + PROBE_TIMEOUT, true),
            Decision::Recover(Action::Rebuild)
        );
    }

    #[test]
    fn hiding_and_resuming_do_not_treat_throttled_timers_as_a_failure() {
        let now = Instant::now();
        let mut w = Watchdog::new(now);
        assert!(matches!(
            w.poll(now + PROBE_INTERVAL, true),
            Decision::Probe { .. }
        ));
        assert_eq!(w.poll(now + Duration::from_secs(10), false), Decision::Wait);
        assert_eq!(w.poll(now + Duration::from_secs(600), true), Decision::Wait);
        assert!(w.pending_probe.is_none());
        assert!(w.attempts.is_empty());
        assert!(matches!(
            w.poll(now + Duration::from_secs(605), true),
            Decision::Probe { .. }
        ));
    }

    #[test]
    fn only_the_current_probe_can_confirm_recovery() {
        let now = Instant::now();
        let mut w = Watchdog::new(now);
        let Decision::Probe {
            generation,
            sequence,
        } = w.poll(now + PROBE_INTERVAL, true)
        else {
            panic!("heartbeat not issued");
        };
        w.acknowledge(generation + 1, sequence);
        assert!(w.pending_probe.is_some());
        w.acknowledge(generation, sequence + 1);
        assert!(w.pending_probe.is_some());
        w.acknowledge(generation, sequence);
        assert!(w.pending_probe.is_none());
    }

    #[test]
    fn retries_are_bounded_and_the_limit_is_reported_only_once() {
        let now = Instant::now();
        let mut w = Watchdog::new(now);
        for _ in 0..MAX_ATTEMPTS {
            w.request(w.generation, Action::Rebuild);
            assert_eq!(w.poll(now, false), Decision::Recover(Action::Rebuild));
        }
        w.request(w.generation, Action::Rebuild);
        assert_eq!(w.poll(now, false), Decision::Exhausted);
        w.request(w.generation, Action::Rebuild);
        assert_eq!(w.poll(now, false), Decision::Wait);
        // Stop for this session after the limit, even if faults keep arriving.
        assert_eq!(w.poll(now + RETRY_WINDOW, false), Decision::Wait);
        w.request(w.generation, Action::Rebuild);
        assert_eq!(w.poll(now + RETRY_WINDOW, false), Decision::Wait);
    }

    #[test]
    fn rebuilding_does_not_exit_the_app_but_explicit_quit_still_works() {
        let now = Instant::now();
        let mut w = Watchdog::new(now);
        w.window_gap = true;
        assert!(w.prevent_exit(None, false));
        assert!(!w.prevent_exit(Some(0), false));
        w.window_gap = false;
        assert!(w.prevent_exit(None, true));
        assert!(!w.prevent_exit(None, false));
        w.stopped = true;
        w.window_gap = true;
        assert!(!w.prevent_exit(None, false));
        w.request(0, Action::Rebuild);
        assert_eq!(w.poll(now, true), Decision::Wait);
    }
}
