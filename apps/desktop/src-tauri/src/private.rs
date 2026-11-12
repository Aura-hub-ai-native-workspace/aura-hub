//! AURA's data folder is private to the user who owns it.
//!
//! `$AURA_HOME` (default `~/.aura`) holds encrypted keys together with the
//! seed that unlocks them, Google account files, logs and crash records.
//! Files used to be created with the default permissions, so on a shared
//! computer any other account could read them. At every launch the folder
//! is set to owner-only (0700) — which alone stops other accounts from
//! opening anything inside it — and the files at its top level, in `logs/`
//! and in `logs/crashes/` are set to 0600 as a second layer.
//!
//! Unix only; on Windows the folder sits in the user's profile, which is
//! already private to them.

use std::path::Path;

/// Set `path` to owner-only: 0700 for a folder, 0600 for a file. Never
/// follows a symlink and never fails loudly.
pub(crate) fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = std::fs::symlink_metadata(path) else { return };
        let mode = if meta.is_dir() {
            0o700
        } else if meta.is_file() {
            0o600
        } else {
            return;
        };
        if meta.permissions().mode() & 0o777 != mode {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Make the data folder private. Skips a folder that is the user's home
/// itself or a filesystem root, so a mistaken `AURA_HOME` cannot lock down
/// something that is not AURA's.
pub(crate) fn protect_home(home: &Path, user_home: &Path) {
    if home.parent().is_none() || home == user_home {
        return;
    }
    if std::fs::create_dir_all(home).is_err() {
        return;
    }
    restrict(home);
    for folder in [home.to_path_buf(), home.join("logs"), home.join("logs").join("crashes")] {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        if folder != home {
            restrict(&folder);
        }
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                restrict(&entry.path());
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aura-private-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn the_data_folder_and_its_files_become_owner_only() {
        let root = scratch("home");
        let home = root.join(".aura");
        std::fs::create_dir_all(home.join("logs").join("crashes")).unwrap();
        std::fs::create_dir_all(home.join("gov").join("deep")).unwrap();
        for f in ["secrets.json", "providers.json", "logs/ai-service.log", "logs/crashes/crash-1-shell.txt", "gov/deep/x.js"] {
            std::fs::write(home.join(f), "x").unwrap();
            std::fs::set_permissions(home.join(f), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();

        protect_home(&home, &root);

        assert_eq!(mode(&home), 0o700);
        assert_eq!(mode(&home.join("secrets.json")), 0o600);
        assert_eq!(mode(&home.join("providers.json")), 0o600);
        assert_eq!(mode(&home.join("logs")), 0o700);
        assert_eq!(mode(&home.join("logs/ai-service.log")), 0o600);
        assert_eq!(mode(&home.join("logs/crashes")), 0o700);
        assert_eq!(mode(&home.join("logs/crashes/crash-1-shell.txt")), 0o600);
        // Deeper files are left as they are; the 0700 folder already hides them.
        assert_eq!(mode(&home.join("gov/deep/x.js")), 0o644);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_users_home_is_never_locked_down() {
        let root = scratch("self");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        protect_home(&root, &root);
        assert_eq!(mode(&root), 0o755);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_symlink_is_not_followed() {
        let root = scratch("link");
        let home = root.join(".aura");
        std::fs::create_dir_all(&home).unwrap();
        let outside = root.join("outside.txt");
        std::fs::write(&outside, "x").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("link.txt")).unwrap();
        protect_home(&home, &root);
        assert_eq!(mode(&outside), 0o644);
        let _ = std::fs::remove_dir_all(&root);
    }
}
