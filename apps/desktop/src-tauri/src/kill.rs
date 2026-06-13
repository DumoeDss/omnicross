// kill.rs — cross-platform process-tree termination for a daemon WE spawned.
//
// A bare `child.kill()` only signals the direct `node` process and leaks any
// worker processes it forked. We kill the whole tree:
//   - Windows: `taskkill /PID <pid> /T /F` (/T = tree, /F = force).
//   - Unix: the child is spawned in its own process group, so `kill(-pgid, …)`
//     reaches the group; we send SIGTERM then SIGKILL.
//
// This is reimplemented in Rust (no cross-repo import). It is ONLY ever called
// for a child the app spawned itself — an adopted daemon is never killed.

/// Kill the process tree rooted at `pid`. Best-effort: errors are swallowed
/// (the process may already be gone). `pid` is the OS process id of the spawned
/// `node` parent.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        // /T = terminate the process tree; /F = force.
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        // The child was placed in its own process group whose group id equals
        // the child pid (see spawn). Negative pid signals the whole group.
        let gid = pid as i32;
        unsafe {
            libc::kill(-gid, libc::SIGTERM);
            // Give the group a moment to exit cleanly, then force-kill.
            std::thread::sleep(std::time::Duration::from_millis(300));
            libc::kill(-gid, libc::SIGKILL);
        }
    }
}
