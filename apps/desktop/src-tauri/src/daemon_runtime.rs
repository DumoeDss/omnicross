// daemon_runtime.rs — adopt-or-spawn lifecycle for the local daemon.
//
// On app startup the app must reach a daemon on 127.0.0.1:8766. This module:
//   1. probes the admin port and classifies the listener via the identity
//      headers (`x-omnicross-daemon` version / `x-omnicross-pid`):
//        - omnicross + matching version (release) ⇒ ADOPT (no spawn);
//        - omnicross but stale — or ANY omnicross daemon in dev builds ⇒
//          kill it (by its reported pid) and respawn fresh;
//        - foreign listener (no identity header) ⇒ Failed with a clear reason
//          (never adopt, never kill what we can't identify);
//   2. else resolves the daemon command (env override or DEV default), ensures a
//      daemon-loadable config exists, and SPAWNS `node <entry> start --config …`;
//   3. waits (bounded) for the port to answer ⇒ Running, else Failed{reason}+kill.
//
// The status is a Rust state machine exposed to the React shell via the
// `daemon_status` command. A Failed state NEVER reports running. A child WE
// spawned is tree-killed on app exit; an adopted daemon is never killed.
//
// The daemon command is a `Vec<String>`: packaged builds run a BUNDLED private
// node (`[bundled_node, entry]`) so the target machine needs no system Node.js;
// dev builds and the env override use PATH `node` (`["node", entry]`).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::kill;

const ADMIN_PORT: u16 = 8766;
const PROBE_URL: &str = "http://127.0.0.1:8766/admin/api/status";
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);
const WAIT_ATTEMPTS: u32 = 20;
const WAIT_INTERVAL: Duration = Duration::from_millis(250);

/// Lifecycle state, serialized to the React shell as `{ state, reason?, port?, adopted? }`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    /// One of: probing | adopted | spawning | running | failed.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// True once a running daemon was adopted (not spawned by us).
    pub adopted: bool,
}

impl DaemonStatus {
    fn new(state: &str) -> Self {
        Self { state: state.into(), reason: None, port: None, adopted: false }
    }
    fn running(adopted: bool) -> Self {
        Self { state: "running".into(), reason: None, port: Some(ADMIN_PORT), adopted }
    }
    fn failed(reason: String) -> Self {
        Self { state: "failed".into(), reason: Some(reason), port: None, adopted: false }
    }
}

/// Shared, Tauri-managed handle. Tracks whether WE spawned (so kill-on-exit only
/// fires for our child) and the current status (read by the `daemon_status` cmd).
pub struct DaemonRuntime {
    inner: Mutex<RuntimeInner>,
}

struct RuntimeInner {
    status: DaemonStatus,
    /// True only when this app spawned the daemon (never kill an adopted one).
    spawned: bool,
    child: Option<Child>,
}

impl DaemonRuntime {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RuntimeInner {
                status: DaemonStatus::new("probing"),
                spawned: false,
                child: None,
            }),
        }
    }

    pub fn status(&self) -> DaemonStatus {
        self.inner.lock().expect("daemon runtime poisoned").status.clone()
    }

    fn set_status(&self, status: DaemonStatus) {
        self.inner.lock().expect("daemon runtime poisoned").status = status;
    }

    /// Tree-kill the spawned child (no-op if we adopted / never spawned).
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().expect("daemon runtime poisoned");
        if !guard.spawned {
            return;
        }
        if let Some(child) = guard.child.as_mut() {
            kill::kill_tree(child.id());
            let _ = child.wait();
        }
        guard.child = None;
        guard.spawned = false;
    }
}

/// What the admin-port probe found (identity handshake, adopt-or-restart).
enum Probe {
    /// Connection refused / timeout — nothing is listening.
    NoListener,
    /// Something answered HTTP but without the omnicross identity header —
    /// a foreign process owns the port; NEVER adopt and NEVER kill it.
    Foreign,
    /// An omnicross daemon answered (identity headers present even on 401).
    Daemon { version: String, pid: Option<u32> },
}

/// Probe the admin port and classify the listener via the identity headers the
/// AdminServer sets on EVERY response (`x-omnicross-daemon` / `x-omnicross-pid`).
fn probe() -> Probe {
    // `.no_proxy()` is load-bearing: the daemon is loopback-only, but a system/env
    // HTTP(S)_PROXY (e.g. Clash on 127.0.0.1:7890) would otherwise route this probe
    // through the proxy, which typically 502s on a loopback target — making a live
    // daemon look absent. Never proxy our own local daemon.
    let client = match reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return Probe::NoListener,
    };
    match client.get(PROBE_URL).send() {
        Err(_) => Probe::NoListener,
        Ok(resp) => {
            let header = |name: &str| {
                resp.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned)
            };
            match header("x-omnicross-daemon") {
                // Pre-handshake daemons (no header) classify as Foreign — they
                // predate this protocol and are by definition outdated, but we
                // can't kill what we can't identify; surface a clear reason.
                None => Probe::Foreign,
                Some(version) => Probe::Daemon {
                    version,
                    pid: header("x-omnicross-pid").and_then(|s| s.parse().ok()),
                },
            }
        }
    }
}

/// True when anything answers on the admin port (spawn-wait / teardown checks).
fn probe_alive() -> bool {
    !matches!(probe(), Probe::NoListener)
}

/// The daemon version this build EXPECTS, read at compile time from the repo's
/// `packages/daemon/package.json` (the same source `stage-daemon` packs, so a
/// packaged build's expectation always matches its bundled runtime).
const DAEMON_PKG_JSON: &str = include_str!("../../../../packages/daemon/package.json");

fn expected_daemon_version() -> String {
    serde_json::from_str::<serde_json::Value>(DAEMON_PKG_JSON)
        .ok()
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(str::to_owned))
        .unwrap_or_default()
}

/// Relative path of the bundled daemon entry inside the staged runtime
/// (`apps/desktop/scripts/build-daemon-runtime.mjs` produces it; `tauri.conf.json`
/// ships the `daemon-runtime` dir as a bundle resource).
const BUNDLED_ENTRY: &str = "daemon-runtime/node_modules/@omnicross/daemon/dist/cli.js";

/// Bundled private Node runtime (staged by `apps/desktop/scripts/stage-node.mjs`,
/// shipped inside the `daemon-runtime` resource). Lets packaged installs run the
/// pure-JS daemon with NO system Node.js requirement.
#[cfg(windows)]
const BUNDLED_NODE: &str = "daemon-runtime/runtime/node.exe";
#[cfg(not(windows))]
const BUNDLED_NODE: &str = "daemon-runtime/runtime/node";

/// Resolve the daemon launch command as a vector, in priority order:
///   1. `OMNICROSS_DAEMON_ENTRY` (absolute path to a dist/cli.js) — explicit override;
///   2. the BUNDLED runtime under the app's resource dir (packaged installs);
///   3. the DEV default in the repo checkout, anchored on the compile-time
///      `src-tauri` dir.
/// Returns Err when none of them exists.
///
/// Packaged builds prepend the BUNDLED node; dev and the env override use PATH
/// `node`. The spawn site runs `cmd[0]` with `cmd[1..]` either way.
fn resolve_daemon_command(app: &AppHandle) -> Result<Vec<String>, String> {
    if let Ok(entry) = std::env::var("OMNICROSS_DAEMON_ENTRY") {
        let path = PathBuf::from(&entry);
        if !path.exists() {
            return Err(format!("daemon entry not found: {entry}"));
        }
        return Ok(vec!["node".into(), entry]);
    }

    // BUNDLED: <resource_dir>/daemon-runtime/… — packaged installs ONLY.
    // Skipped in debug builds: `tauri dev` copies the staged daemon-runtime
    // resource into target/debug, where a STALE copy from an earlier staging
    // would shadow the live repo dist below ("I rebuilt the daemon but dev:app
    // still runs the old code"). Dev always follows the repo checkout.
    if !cfg!(debug_assertions) {
        if let Ok(res) = app.path().resource_dir() {
            let bundled = res.join(BUNDLED_ENTRY);
            if let Ok(bundled) = bundled.canonicalize() {
                // Prefer the bundled node runtime (no system Node.js required);
                // bundled_node() falls back to PATH `node` if a build shipped
                // without it.
                return Ok(vec![bundled_node(&res), strip_verbatim(&bundled)]);
            }
        }
    }

    // DEV default: <repo>/packages/daemon/dist/cli.js, anchored on the
    // compile-time manifest dir (NOT the runtime cwd, which is target/…).
    // Layout: <repo>/apps/desktop/src-tauri → three levels up to the repo root.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest.join("../../../packages/daemon/dist/cli.js");
    // canonicalize() verifies existence AND resolves the `..` segments; it errors
    // if the file is missing (→ honest "daemon entry not found").
    let dev = dev.canonicalize().map_err(|_| {
        format!(
            "daemon entry not found (no bundled runtime, no repo checkout): {}",
            dev.display()
        )
    })?;
    // strip_verbatim is LOAD-BEARING on Windows: canonicalize() returns an
    // extended-length `\\?\E:\…` path, which Node misparses as a UNC path and
    // lstat's `E:` → `EISDIR: illegal operation on a directory, lstat 'E:'`.
    Ok(vec!["node".into(), strip_verbatim(&dev)])
}

/// Resolve the bundled Node runtime under the app's resource dir. Falls back to
/// the system `node` on PATH when a build shipped without it (or the file is
/// missing). On unix, best-effort restores the exec bit — Tauri's resource copy
/// doesn't reliably preserve file mode.
fn bundled_node(resource_dir: &std::path::Path) -> String {
    let Ok(node) = resource_dir.join(BUNDLED_NODE).canonicalize() else {
        return "node".into();
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&node) {
            let mut perms = meta.permissions();
            if (perms.mode() & 0o111) == 0 {
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&node, perms);
            }
        }
    }
    strip_verbatim(&node)
}

/// Strip Windows' `\\?\` (and `\\?\UNC\`) extended-length prefix from a
/// canonicalized path so external tools that don't understand verbatim paths
/// (Node's main-module resolver) receive a plain `E:\…` path. No-op on paths
/// without the prefix (i.e. always a no-op on non-Windows).
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s
}

/// Ensure `<appDataDir>/omnicross.config.json` exists and is daemon-loadable.
/// Writes `{"providers":[]}\n` (UTF-8, NO BOM) when absent — a bare `{}` makes
/// the daemon crash (validateConfig requires `providers` to be an array). Never
/// overwrites an existing config. Returns the config path as a string.
fn ensure_config(app: &AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app data dir: {e}"))?;
    let cfg = dir.join("omnicross.config.json");
    if !cfg.exists() {
        // Raw bytes — std::fs::write never prepends a BOM.
        std::fs::write(&cfg, b"{\"providers\":[]}\n")
            .map_err(|e| format!("cannot write config: {e}"))?;
    }
    Ok(cfg.to_string_lossy().into_owned())
}

/// Spawn `node <entry> start --config <cfg>` as a tracked child. Windows:
/// CREATE_NO_WINDOW (no console pops up). Unix: own process group so kill-tree
/// can signal the whole group. stderr is piped so a failed start yields a reason.
fn spawn(cmd: &[String], config_path: &str) -> Result<Child, String> {
    let mut command = Command::new(&cmd[0]);
    command
        .args(&cmd[1..])
        .arg("start")
        .arg("--config")
        .arg(config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0); // new group; gid == child pid
    }

    command
        .spawn()
        .map_err(|e| format!("failed to spawn daemon ({}): {e}", cmd[0]))
}

/// Read a short tail of the child's stderr for a human failure reason.
fn stderr_tail(child: &mut Child) -> Option<String> {
    use std::io::Read;
    let mut buf = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut buf);
    }
    let trimmed = buf.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().rev().take(400).collect::<String>().chars().rev().collect())
    }
}

/// The adopt-or-spawn orchestration. Mutates the managed status as it goes.
/// Runs off the setup thread (called on tauri::async_runtime).
pub fn adopt_or_spawn(app: AppHandle) {
    let runtime = app.state::<DaemonRuntime>();
    runtime.set_status(DaemonStatus::new("probing"));

    // 1. ADOPT-OR-RESTART (identity handshake): adopt a live daemon ONLY when
    //    it identifies as omnicross AND its version matches this build's
    //    expectation (release). A stale daemon — and ANY daemon in dev builds,
    //    where versions don't bump per change — is killed and respawned: a new
    //    UI silently talking to old daemon code is worse than briefly cutting
    //    the old daemon's consumers over to fresh code.
    match probe() {
        Probe::Daemon { version, pid } => {
            let expected = expected_daemon_version();
            let fresh = !cfg!(debug_assertions) && version == expected;
            if fresh {
                runtime.set_status(DaemonStatus::running(true));
                return;
            }
            let Some(pid) = pid else {
                runtime.set_status(DaemonStatus::failed(format!(
                    "an outdated omnicross daemon (v{version}, expected v{expected}) holds port {ADMIN_PORT} \
                     and reports no pid — stop it manually and relaunch"
                )));
                return;
            };
            kill::kill_tree(pid);
            // Bounded wait for the port to actually free before we bind it.
            let mut freed = false;
            for _ in 0..WAIT_ATTEMPTS {
                if !probe_alive() {
                    freed = true;
                    break;
                }
                std::thread::sleep(WAIT_INTERVAL);
            }
            if !freed {
                runtime.set_status(DaemonStatus::failed(format!(
                    "stale omnicross daemon (v{version}, pid {pid}) did not release port {ADMIN_PORT}"
                )));
                return;
            }
            // fall through to spawn a fresh daemon
        }
        Probe::Foreign => {
            runtime.set_status(DaemonStatus::failed(format!(
                "port {ADMIN_PORT} is held by a process that is not a current omnicross daemon \
                 (no identity header) — stop it and relaunch"
            )));
            return;
        }
        Probe::NoListener => {}
    }

    // 2. Resolve the launch command.
    let cmd = match resolve_daemon_command(&app) {
        Ok(c) => c,
        Err(reason) => {
            runtime.set_status(DaemonStatus::failed(reason));
            return;
        }
    };

    // 3. Ensure a daemon-loadable config exists.
    let config_path = match ensure_config(&app) {
        Ok(p) => p,
        Err(reason) => {
            runtime.set_status(DaemonStatus::failed(reason));
            return;
        }
    };

    // 4. SPAWN.
    runtime.set_status(DaemonStatus::new("spawning"));
    let mut child = match spawn(&cmd, &config_path) {
        Ok(c) => c,
        Err(reason) => {
            runtime.set_status(DaemonStatus::failed(reason));
            return;
        }
    };

    // 5. wait_for_port: bounded re-probe; first success ⇒ running.
    for _ in 0..WAIT_ATTEMPTS {
        // Child exited early ⇒ failed with its stderr tail.
        if let Ok(Some(exit)) = child.try_wait() {
            let reason = stderr_tail(&mut child)
                .unwrap_or_else(|| format!("daemon exited early ({exit})"));
            runtime.set_status(DaemonStatus::failed(reason));
            return;
        }
        if probe_alive() {
            // Hand the live child to the managed handle so kill-on-exit owns it.
            let mut guard = runtime.inner.lock().expect("daemon runtime poisoned");
            guard.child = Some(child);
            guard.spawned = true;
            guard.status = DaemonStatus::running(false);
            return;
        }
        std::thread::sleep(WAIT_INTERVAL);
    }

    // 6. Timed out ⇒ failed; kill the child we spawned.
    kill::kill_tree(child.id());
    let _ = child.wait();
    runtime.set_status(DaemonStatus::failed(
        "daemon did not become reachable on 127.0.0.1:8766 within the startup window".into(),
    ));
}

/// Tauri command — the React shell polls this until terminal.
#[tauri::command]
pub fn daemon_status(runtime: tauri::State<'_, DaemonRuntime>) -> DaemonStatus {
    runtime.status()
}
