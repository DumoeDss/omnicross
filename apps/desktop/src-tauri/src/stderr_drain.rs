// stderr_drain.rs — keep the spawned daemon's stderr pipe moving, and keep what
// came out of it.
//
// WHY THIS EXISTS, precisely: we spawn the daemon with `Stdio::piped()` stderr so
// a failed start can report a reason. Nothing then read that pipe for the rest of
// the process's life. Node writes to a pipe SYNCHRONOUSLY on Windows and Linux
// (only macOS is async), so once the OS pipe buffer fills, the daemon's next
// `console.error` blocks — permanently, inside the event loop, with the process
// still alive and the port still listening. Every request hangs, nothing is
// logged, and only a restart clears it. Measured on Windows: the child froze
// after ~82 KB of unread stderr and never advanced again.
//
// So a reader thread is not a nicety here, it is the thing that stops the daemon
// from deadlocking. Draining to /dev/null would be enough to fix that — we
// append to a rotating file as well, because the same wiring that hid the
// deadlock (stdout discarded, stderr unread) is why the freeze left no evidence.
//
// The ring buffer keeps the tail in memory so `stderr_tail` can explain a failed
// start WITHOUT taking the pipe away from the drain thread; the two would
// otherwise race for the same reader.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::ChildStderr;
use std::sync::{Arc, Mutex};

/// Lines kept in memory for failure reporting. Small on purpose — the file sink
/// is the durable record; this is only ever read to explain a bad start.
const RING_CAPACITY: usize = 200;

/// Size cap for one generation of `daemon-stderr.log`.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Generations kept as `daemon-stderr.log.1` … `.N` beside the live file.
const MAX_FILES: u32 = 3;

/// Shared handle to the drained stderr: an in-memory tail plus the file sink.
pub struct StderrLog {
    ring: Mutex<VecDeque<String>>,
}

impl StderrLog {
    fn new() -> Self {
        Self { ring: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)) }
    }

    fn push(&self, line: String) {
        let mut ring = self.ring.lock().expect("stderr ring poisoned");
        if ring.len() == RING_CAPACITY {
            ring.pop_front();
        }
        ring.push_back(line);
    }

    /// The last `max_chars` characters of what the daemon wrote to stderr, or
    /// `None` when it wrote nothing. Character-based (not byte-based) so a
    /// multi-byte boundary can never be split.
    pub fn tail(&self, max_chars: usize) -> Option<String> {
        let ring = self.ring.lock().expect("stderr ring poisoned");
        let joined = ring.iter().cloned().collect::<Vec<_>>().join("\n");
        let trimmed = joined.trim();
        if trimmed.is_empty() {
            return None;
        }
        let tail: String = {
            let rev: String = trimmed.chars().rev().take(max_chars).collect();
            rev.chars().rev().collect()
        };
        Some(tail)
    }
}

/// Start the drain thread for `stderr`, appending to `log_path` and keeping the
/// tail in the returned handle. Returns immediately; the thread ends at EOF (the
/// daemon exited) and is detached, so it never blocks app shutdown.
pub fn spawn_drain(stderr: ChildStderr, log_path: PathBuf) -> Arc<StderrLog> {
    let log = Arc::new(StderrLog::new());
    let thread_log = Arc::clone(&log);
    std::thread::Builder::new()
        .name("daemon-stderr-drain".into())
        .spawn(move || {
            let mut sink = FileSink::open(&log_path);
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                // A decode error on one line must not stop the drain — stopping
                // is what reintroduces the deadlock this thread exists to avoid.
                let Ok(line) = line else { continue };
                sink.write_line(&line);
                thread_log.push(line);
            }
            sink.flush();
        })
        .ok();
    log
}

/// A size-capped append sink. Every operation is best-effort: a logging failure
/// must never stop the drain, because the drain is load-bearing for liveness.
struct FileSink {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
}

impl FileSink {
    fn open(path: &Path) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new().create(true).append(true).open(path).ok();
        Self { path: path.to_path_buf(), file, bytes }
    }

    fn write_line(&mut self, line: &str) {
        let Some(file) = self.file.as_mut() else { return };
        if writeln!(file, "{line}").is_err() {
            self.file = None;
            return;
        }
        self.bytes += line.len() as u64 + 1;
        if self.bytes >= MAX_FILE_BYTES {
            self.rotate();
        }
    }

    /// `.N` dropped, `.k` → `.k+1`, live file → `.1`, then reopen empty.
    fn rotate(&mut self) {
        self.flush();
        self.file = None;
        let base = self.path.as_path();
        let _ = fs::remove_file(generation(base, MAX_FILES));
        for i in (1..MAX_FILES).rev() {
            let _ = fs::rename(generation(base, i), generation(base, i + 1));
        }
        let _ = fs::rename(base, generation(base, 1));
        self.file = OpenOptions::new().create(true).append(true).open(base).ok();
        self.bytes = 0;
    }

    fn flush(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }
}

/// `daemon-stderr.log` + `.n` — a sibling of the live file, never a new dir.
fn generation(base: &Path, n: u32) -> PathBuf {
    let mut name = base.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{n}"));
    base.with_file_name(name)
}
