//! Crash records: what went wrong on this machine, kept on this machine.
//!
//! Nothing was recorded when AURA failed on a user's computer: a panic in
//! the shell, an error that broke the window, or a background service that
//! died and was restarted all left no trace to look at afterwards. Each now
//! writes one small text file under `$AURA_HOME/logs/crashes/`. Nothing is
//! sent anywhere. Settings → Storage lists the newest ones.
//!
//! Bounded: each record is capped, at most `PER_LAUNCH` are written per
//! launch (an error in a render loop must not fill the disk), and only the
//! newest `KEEP` files are kept.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP: usize = 30;
const PER_LAUNCH: usize = 20;
const FIELD_LIMIT: usize = 16 * 1024;
const LOG_TAIL: u64 = 16 * 1024;

static WRITTEN: AtomicUsize = AtomicUsize::new(0);

fn dir() -> PathBuf {
    crate::service::aura_home().join("logs").join("crashes")
}

fn clip(s: &str) -> &str {
    if s.len() <= FIELD_LIMIT {
        return s;
    }
    let mut end = FIELD_LIMIT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Write one record. `source` is a short fixed word (`shell`, `window`,
/// `service`). Returns the file written, if any. Never panics.
fn write(dir: &Path, source: &str, body: &str) -> Option<PathBuf> {
    if WRITTEN.fetch_add(1, Ordering::SeqCst) >= PER_LAUNCH {
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join(format!("crash-{:013}-{source}.txt", now_ms()));
    let text = format!(
        "AURA Hub {} on {} {}\nsource: {source}\n\n{body}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    std::fs::write(&path, text).ok()?;
    prune(dir, KEEP);
    Some(path)
}

fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("crash-")))
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(keep);
    for old in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

/// Record panics in the shell, then let the default hook run as before.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let body = format!("{info}\n\nbacktrace:\n{backtrace}");
        let _ = write(&dir(), "shell", clip(&body));
        previous(info);
    }));
}

/// The end of a log file, for a record about the service that wrote it.
fn log_tail(path: &Path) -> String {
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// A background service that was running has stopped and is being started
/// again. The record keeps the end of its log, which says why.
pub fn record_service_exit(what: &str, log: &Path) {
    let body = format!(
        "{what} stopped unexpectedly and is being restarted.\n\nlast lines of {}:\n{}",
        log.display(),
        log_tail(log)
    );
    let _ = write(&dir(), "service", clip(&body));
}

/// An error that reached the top of the window (sent by the renderer).
#[tauri::command]
pub fn record_renderer_error(kind: String, message: String, stack: Option<String>) {
    let kind: String = kind.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let body = format!(
        "kind: {kind}\nmessage: {}\n\nstack:\n{}",
        clip(&message),
        clip(stack.as_deref().unwrap_or("(none)"))
    );
    let _ = write(&dir(), "window", &body);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    pub file: String,
    pub at_ms: u64,
    pub source: String,
    pub summary: String,
}

fn list_in(dir: &Path) -> Vec<CrashRecord> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<CrashRecord> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let rest = name.strip_prefix("crash-")?.strip_suffix(".txt")?;
            let (at, source) = rest.split_once('-')?;
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            // The first line after the header block says what happened.
            let summary = text.split("\n\n").nth(1).and_then(|b| b.lines().next()).unwrap_or("").to_string();
            Some(CrashRecord {
                file: e.path().display().to_string(),
                at_ms: at.parse().ok()?,
                source: source.to_string(),
                summary: summary.chars().take(300).collect(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    out
}

/// The newest crash records, for Settings → Storage.
#[tauri::command]
pub fn list_crash_records() -> Vec<CrashRecord> {
    list_in(&dir()).into_iter().take(10).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aura-crash-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_record_is_written_and_listed_newest_first() {
        let d = temp("list");
        write(&d, "window", "kind: error\nmessage: boom").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        write(&d, "service", "local service stopped unexpectedly").unwrap();
        let listed = list_in(&d);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].source, "service");
        assert_eq!(listed[0].summary, "local service stopped unexpectedly");
        assert_eq!(listed[1].summary, "kind: error");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn only_the_newest_are_kept() {
        let d = temp("prune");
        std::fs::create_dir_all(&d).unwrap();
        for i in 0..5 {
            std::fs::write(d.join(format!("crash-{:013}-shell.txt", i)), "x").unwrap();
        }
        std::fs::write(d.join("keep-me.txt"), "not a record").unwrap();
        prune(&d, 2);
        let mut left: Vec<String> = std::fs::read_dir(&d).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["crash-0000000000003-shell.txt", "crash-0000000000004-shell.txt", "keep-me.txt"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn long_fields_are_clipped_on_a_char_boundary() {
        let s = "é".repeat(FIELD_LIMIT);
        let c = clip(&s);
        assert!(c.len() <= FIELD_LIMIT);
        assert!(s.starts_with(c));
    }

    #[test]
    fn the_log_tail_is_the_end_of_the_file() {
        let d = temp("tail");
        std::fs::create_dir_all(&d).unwrap();
        let log = d.join("svc.log");
        let mut text = "old line\n".repeat(5000);
        text.push_str("Error: port in use\n");
        std::fs::write(&log, text).unwrap();
        let tail = log_tail(&log);
        assert!(tail.ends_with("Error: port in use\n"));
        assert!(tail.len() as u64 <= LOG_TAIL);
        let _ = std::fs::remove_dir_all(&d);
    }
}
