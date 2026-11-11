//! Recovering from a window that never draws.
//!
//! On some Linux machines the WebKitGTK web process starts but never loads
//! the page: the window stays black and nothing in it can explain why (seen
//! on the owner's machine; a reboot cleared it). The renderer now reports
//! when it has drawn (`renderer_ready`). If it has not within
//! `FIRST_WAIT`, the page is reloaded once. If it still has not, the next
//! launch on Linux turns off WebKit's GPU paths (DMA-BUF renderer and
//! accelerated compositing), the usual cause of a blank WebKitGTK window.
//! A launch that then draws keeps that setting; deleting
//! `$AURA_HOME/renderer-fallback` turns it off again.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static READY: AtomicBool = AtomicBool::new(false);

const FIRST_WAIT: Duration = Duration::from_secs(20);
const AFTER_RELOAD: Duration = Duration::from_secs(20);
const MARKER: &str = "renderer-fallback";

/// Sent by the renderer once it has painted its first frame.
#[tauri::command]
pub fn renderer_ready() {
    READY.store(true, Ordering::SeqCst);
}

fn marker() -> PathBuf {
    crate::service::aura_home().join(MARKER)
}

/// The variables the fallback sets, before any webview exists.
const FALLBACK_ENV: [(&str, &str); 2] = [
    ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
    ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
];

/// Call first in `run()`, before Tauri starts WebKit. Returns whether the
/// fallback is on for this launch. Variables the user set are left as set.
pub fn apply_fallback_if_needed() -> bool {
    if !cfg!(target_os = "linux") || !marker().is_file() {
        return false;
    }
    for (key, value) in FALLBACK_ENV {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
    eprintln!("[aura] renderer: software rendering fallback is on ({})", marker().display());
    true
}

/// What the watcher should do after a wait, given what it has seen.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Done,
    Reload,
    RememberFallback,
    GiveUp,
}

fn next_step(ready: bool, reloaded: bool, fallback_active: bool) -> Step {
    match (ready, reloaded, fallback_active) {
        (true, _, _) => Step::Done,
        (false, false, _) => Step::Reload,
        (false, true, false) if cfg!(target_os = "linux") => Step::RememberFallback,
        _ => Step::GiveUp,
    }
}

/// Watch the window that was just shown. Runs on its own thread.
pub fn watch(window: tauri::WebviewWindow, fallback_active: bool) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_WAIT);
        let mut reloaded = false;
        loop {
            match next_step(READY.load(Ordering::SeqCst), reloaded, fallback_active) {
                Step::Done => return,
                Step::Reload => {
                    eprintln!("[aura] renderer: the window has not drawn after {}s; reloading it.", FIRST_WAIT.as_secs());
                    let _ = window.reload();
                    reloaded = true;
                    std::thread::sleep(AFTER_RELOAD);
                }
                Step::RememberFallback => {
                    let note = "The AURA Hub window did not draw. The next launch turns off WebKit GPU \
                                rendering. Delete this file to turn it back on.\n";
                    match std::fs::write(marker(), note) {
                        Ok(()) => eprintln!(
                            "[aura] renderer: the window still has not drawn; the next launch uses software rendering."
                        ),
                        Err(e) => eprintln!("[aura] renderer: could not record the fallback: {e}"),
                    }
                    return;
                }
                Step::GiveUp => {
                    eprintln!("[aura] renderer: the window has not drawn, even with software rendering.");
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_that_drew_needs_nothing() {
        assert_eq!(next_step(true, false, false), Step::Done);
        assert_eq!(next_step(true, true, true), Step::Done);
    }

    #[test]
    fn a_blank_window_is_reloaded_first() {
        assert_eq!(next_step(false, false, false), Step::Reload);
        assert_eq!(next_step(false, false, true), Step::Reload);
    }

    #[test]
    fn still_blank_after_a_reload_switches_rendering_next_launch_on_linux_only() {
        let expected = if cfg!(target_os = "linux") { Step::RememberFallback } else { Step::GiveUp };
        assert_eq!(next_step(false, true, false), expected);
    }

    #[test]
    fn the_fallback_is_not_applied_twice() {
        assert_eq!(next_step(false, true, true), Step::GiveUp);
    }
}
