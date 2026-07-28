//! AURA Hub — Tauri core.
//!
//! Deliberately thin. The desktop wrapper's only job today is to host
//! the web environment in a native window. Native capabilities (file
//! system access, local model runners, system integration) will be
//! added here as tightly-scoped `#[tauri::command]`s — one clean seam
//! between the environment and the operating system.

/// A trivial command kept as a wiring example / health check for the
/// JS <-> Rust bridge. Remove or replace when real commands land.
#[tauri::command]
fn environment_ping() -> String {
    "aura://ready".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![environment_ping])
        .run(tauri::generate_context!())
        .expect("error while running AURA Hub");
}
