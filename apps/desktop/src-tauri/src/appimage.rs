/**
 * appimage — turning a downloaded AppImage into an installed application.
 * ==================================================================
 *
 * An AppImage is a single file that runs from wherever it lands. That is its
 * virtue and, for a desktop application, its whole problem: nothing puts it in
 * the launcher, nothing registers its icon, and the file stays in ~/Downloads
 * forever. The `.deb` solves this with dpkg; the AppImage has no equivalent,
 * because the AppImage project's own answer — `appimaged` / AppImageLauncher —
 * is a separate daemon that almost nobody has installed. On a stock Arch + i3,
 * GNOME, KDE or XFCE system there is nothing at all to integrate it.
 *
 * So the application integrates itself, on request, using only the standard
 * XDG mechanisms every one of those desktops already reads:
 *
 *     ~/.local/lib/aura-hub/AURA-Hub.AppImage        the application
 *     ~/.local/share/applications/com.aura.hub.desktop   the launcher entry
 *     ~/.local/share/icons/hicolor/<size>/apps/aura-hub.png   the icon
 *     ~/.local/bin/aura-hub                          convenience symlink
 *
 * Everything is per-user. Nothing here needs root, writes outside $HOME, or
 * touches a system path — which is also why it works identically on all four
 * desktops: they all read `~/.local/share/applications`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not download anything. The only bytes it copies are the ones already
 * running — `$APPIMAGE`, the file the user launched — verbatim, so the copy is
 * bit-identical to the artifact they downloaded and its updater signature
 * still verifies. It cannot be used to fetch or execute anything else.
 *
 * It refuses to run unless `$APPIMAGE` is set, which the AppImage runtime sets
 * and nothing else does. A `.deb` install therefore can never trigger this and
 * clobber its own system-wide entry.
 *
 * SECURITY
 *
 * There is no new trust boundary. By the time this code can run, the user has
 * already executed the AppImage; arbitrary code is already running as them.
 * Integration adds file writes under $HOME that the same process could have
 * made anyway. What it avoids is the thing that WOULD add one: no privilege
 * escalation, no `sudo`, no system-wide paths, no post-install script hook, no
 * network.
 *
 * UPDATER
 *
 * Untouched. Tauri's Linux updater replaces the file named by `$APPIMAGE` in
 * place. Launched from the integrated copy, `$APPIMAGE` is that copy, so
 * updates land on it and the launcher entry keeps pointing at the right file.
 * The signature and trust anchor are not involved here at all.
 */
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const DESKTOP_FILE: &str = "com.aura.hub.desktop";
pub const ICON_NAME: &str = "aura-hub";
/// Sizes swept on uninstall, and the fallback when the AppDir is unreadable.
/// Deliberately a superset of both packagings: the AppImage ships
/// 16/32/64/128/256 + scalable, the .deb ships 32/128/256@2. Removing an icon
/// that was never installed is a no-op, so a superset is safe here in a way a
/// fixed install list is not.
const ICON_SIZES: [&str; 8] = [
    "16x16", "32x32", "48x48", "64x64", "128x128", "256x256", "256x256@2", "scalable",
];

/// The hicolor size directories this AppDir actually provides.
fn available_icon_sizes(appdir: Option<&Path>) -> Vec<String> {
    let hicolor = match appdir {
        Some(d) => d.join("usr/share/icons/hicolor"),
        None => return ICON_SIZES.iter().map(|s| s.to_string()).collect(),
    };
    match fs::read_dir(&hicolor) {
        Ok(entries) => {
            let mut sizes: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            sizes.sort();
            if sizes.is_empty() {
                ICON_SIZES.iter().map(|s| s.to_string()).collect()
            } else {
                sizes
            }
        }
        Err(_) => ICON_SIZES.iter().map(|s| s.to_string()).collect(),
    }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct IntegrationStatus {
    /// Running from an AppImage at all — false for the .deb and for `cargo run`.
    pub is_appimage: bool,
    /// A launcher entry exists AND the application it names is present.
    pub installed: bool,
    /// True when this AppImage IS the installed copy — launched from the menu.
    pub running_installed: bool,
    pub app_path: Option<String>,
    pub desktop_path: Option<String>,
    /// Whether the in-app updater can replace THIS copy of the application.
    ///
    /// False for a distribution package: `tauri-plugin-updater` replaces a
    /// file in place, and a .deb or .rpm puts that file under a root-owned
    /// system prefix. The update would download, verify, and then fail to
    /// write — which reads to a user as a broken updater rather than as an
    /// unsupported installation method. Reporting it up front is the fix;
    /// attempting it silently is the bug.
    pub updatable: bool,
    /// Why not, in words the UI can show verbatim. `None` when it is.
    pub update_note: Option<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// XDG data home, honouring the override rather than assuming `~/.local/share`.
fn data_home() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
        let p = PathBuf::from(x);
        if p.is_absolute() {
            return Some(p);
        }
    }
    home().map(|h| h.join(".local/share"))
}

fn install_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".local/lib/aura-hub"))
}
fn installed_app() -> Option<PathBuf> {
    install_dir().map(|d| d.join("AURA-Hub.AppImage"))
}
fn desktop_path() -> Option<PathBuf> {
    data_home().map(|d| d.join("applications").join(DESKTOP_FILE))
}
fn bin_link() -> Option<PathBuf> {
    home().map(|h| h.join(".local/bin/aura-hub"))
}

/// The AppImage currently running, as the runtime reported it.
fn running_appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.exists())
}

/// The mounted AppDir, where the icons and desktop file we ship live.
fn appdir() -> Option<PathBuf> {
    std::env::var_os("APPDIR").map(PathBuf::from).filter(|p| p.exists())
}

/// True when this copy was installed by a distribution package manager.
///
/// The AppImage never lands under a system prefix — it runs from wherever the
/// user put it, and installing puts it under `~/.local/lib`. So a binary
/// under `/usr` or `/opt` with no `$APPIMAGE` set is a .deb or .rpm install,
/// owned by root and outside this user's authority to replace.
fn system_wide_install() -> bool {
    if running_appimage().is_some() {
        return false;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let path = exe.to_string_lossy().to_string();
    ["/usr/", "/opt/", "/bin/", "/sbin/"].iter().any(|p| path.starts_with(p))
}

pub fn status() -> IntegrationStatus {
    let running = running_appimage();
    let app = installed_app();
    let desk = desktop_path();
    // "Installed" means BOTH halves are present. A launcher entry whose target
    // has been deleted is not an installation — it is a dead menu item, and
    // reporting it as installed would hide exactly the case that needs repair.
    let installed = matches!((&app, &desk), (Some(a), Some(d)) if a.exists() && d.exists());
    let running_installed = match (&running, &app) {
        (Some(r), Some(a)) => same_file(r, a),
        _ => false,
    };
    let packaged = system_wide_install();
    IntegrationStatus {
        is_appimage: running.is_some(),
        installed,
        running_installed,
        app_path: app.map(|p| p.display().to_string()),
        desktop_path: desk.map(|p| p.display().to_string()),
        updatable: !packaged,
        update_note: packaged.then(|| {
            "AURA Hub was installed from a distribution package, so updates come from your \
             package manager rather than from inside the application. To get updates here \
             instead, install the Linux download from the AURA Hub website."
                .to_string()
        }),
    }
}

/// Compare by canonical path — the integrated copy may be reached via a symlink.
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Install, or re-install over an existing installation.
///
/// Idempotent by construction: every destination is a fixed path, so running
/// this twice overwrites rather than accumulating a second copy or a
/// "AURA Hub (1)" menu entry. Re-running after an update is the supported way
/// to repair a broken installation.
pub fn install() -> Result<IntegrationStatus, String> {
    let source = running_appimage()
        .ok_or("Not running from an AppImage — there is nothing to install from.")?;
    let dir = install_dir().ok_or("HOME is not set.")?;
    let target = installed_app().ok_or("HOME is not set.")?;
    let desk = desktop_path().ok_or("HOME is not set.")?;

    // Installing the installed copy onto itself would truncate the running
    // file. Everything else still runs, so a repair of the launcher entry
    // remains possible.
    let copying = !same_file(&source, &target);

    if copying {
        fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        // Write beside the target and rename: a crash mid-copy then leaves the
        // previous installation intact rather than a half-written binary.
        let tmp = dir.join(".AURA-Hub.AppImage.part");
        let _ = fs::remove_file(&tmp);
        fs::copy(&source, &tmp).map_err(|e| format!("Could not copy the application: {e}"))?;
        set_executable(&tmp).map_err(|e| format!("Could not mark it executable: {e}"))?;
        fs::rename(&tmp, &target).map_err(|e| format!("Could not place the application: {e}"))?;
    }

    install_icons()?;
    write_desktop_entry(&desk, &target)?;
    link_bin(&target);
    refresh_desktop_database();

    Ok(status())
}

#[cfg(unix)]
fn set_executable(p: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(p)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(p, perms)
}

/// Only Linux ships an AppImage; this exists so the shell still compiles for
/// the Windows and macOS targets, where `install()` can never be reached
/// because `$APPIMAGE` is never set.
#[cfg(not(unix))]
fn set_executable(_p: &Path) -> io::Result<()> {
    Ok(())
}

/// Copy the icons we already ship inside the AppDir into the user's hicolor
/// theme, at their real sizes, so the launcher and the window manager both
/// find them by the `Icon=aura-hub` name.
///
/// The sizes are read from the AppDir rather than hardcoded. The AppImage and
/// the .deb do not carry the same set — linuxdeploy expands ours to
/// 16/32/64/128/256 and `scalable`, while the .deb ships 32/128/256@2 — so a
/// fixed list written against one of them silently skips icons in the other,
/// which is how a launcher ends up with a blurry or missing icon at one size.
fn install_icons() -> Result<(), String> {
    let base = data_home().ok_or("HOME is not set.")?.join("icons/hicolor");
    let src_root = appdir();
    let mut installed_any = false;

    for size in available_icon_sizes(src_root.as_deref()) {
        let ext = if size == "scalable" { "svg" } else { "png" };
        let src = match src_root.as_ref() {
            Some(d) => d.join(format!("usr/share/icons/hicolor/{size}/apps/{ICON_NAME}.{ext}")),
            None => continue,
        };
        if !src.exists() {
            continue;
        }
        let dest_dir = base.join(&size).join("apps");
        fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Could not create {}: {e}", dest_dir.display()))?;
        fs::copy(&src, dest_dir.join(format!("{ICON_NAME}.{ext}")))
            .map_err(|e| format!("Could not install the icon: {e}"))?;
        installed_any = true;
    }

    // The AppImage always carries its icon at the root as `.DirIcon`. Falling
    // back to it means integration still produces a correct-looking launcher
    // entry even if the hicolor tree is ever restructured.
    if !installed_any {
        if let Some(dir_icon) = src_root.map(|d| d.join(".DirIcon")).filter(|p| p.exists()) {
            let dest_dir = base.join("256x256").join("apps");
            fs::create_dir_all(&dest_dir).map_err(|e| format!("Could not create icon dir: {e}"))?;
            fs::copy(&dir_icon, dest_dir.join(format!("{ICON_NAME}.png")))
                .map_err(|e| format!("Could not install the icon: {e}"))?;
            installed_any = true;
        }
    }

    if installed_any {
        Ok(())
    } else {
        // Not fatal on its own, but silently shipping a launcher entry with a
        // missing icon is the kind of half-installation this exists to avoid.
        Err("No icon could be found inside the AppImage.".into())
    }
}

/// `Exec` is the absolute path of the INSTALLED copy, quoted, so the entry
/// keeps working after the download is deleted — requirement 11.
fn write_desktop_entry(desk: &Path, target: &Path) -> Result<(), String> {
    let dir = desk.parent().ok_or("Bad applications path.")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let exec = target.display().to_string();
    let entry = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=AURA Hub\n\
         Comment=AURA Hub — an AI Operating Environment\n\
         Exec=\"{exec}\" %U\n\
         TryExec={exec}\n\
         Icon={ICON_NAME}\n\
         Terminal=false\n\
         Categories=Development;IDE;\n\
         Keywords=AI;agent;engineering;workspace;\n\
         StartupNotify=true\n\
         StartupWMClass=aura-hub\n\
         X-AppImage-Integrate=false\n"
    );
    let tmp = desk.with_extension("desktop.part");
    fs::write(&tmp, entry).map_err(|e| format!("Could not write the launcher entry: {e}"))?;
    fs::rename(&tmp, desk).map_err(|e| format!("Could not place the launcher entry: {e}"))?;
    Ok(())
}

/// Best-effort convenience only: `aura-hub` on PATH for people who live in a
/// terminal. Its absence never fails an install — the launcher entry is what
/// the requirement is about.
fn link_bin(target: &Path) {
    if let Some(link) = bin_link() {
        if let Some(dir) = link.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::remove_file(&link);
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(target, &link);
        #[cfg(not(unix))]
        let _ = target;
    }
}

/// GNOME, KDE and XFCE cache the application list; i3/rofi/dmenu read the
/// directory directly and need nothing. Both tools are optional, and a missing
/// one is not an error — the entry is already on disk and valid either way.
fn refresh_desktop_database() {
    if let Some(apps) = data_home().map(|d| d.join("applications")) {
        let _ = std::process::Command::new("update-desktop-database")
            .arg(&apps)
            .status();
    }
    if let Some(icons) = data_home().map(|d| d.join("icons/hicolor")) {
        let _ = std::process::Command::new("gtk-update-icon-cache")
            .args(["-q", "-t", "-f"])
            .arg(&icons)
            .status();
    }
}

/// Remove everything `install` created, and nothing else.
///
/// Deliberately leaves the user's data in AURA_HOME alone: uninstalling the
/// application is not the same request as discarding the work done with it.
pub fn uninstall() -> Result<IntegrationStatus, String> {
    let mut problems: Vec<String> = Vec::new();

    if let Some(desk) = desktop_path() {
        remove_if_present(&desk, &mut problems);
    }
    if let Some(base) = data_home().map(|d| d.join("icons/hicolor")) {
        for size in ICON_SIZES {
            let apps = base.join(size).join("apps");
            remove_if_present(&apps.join(format!("{ICON_NAME}.png")), &mut problems);
            remove_if_present(&apps.join(format!("{ICON_NAME}.svg")), &mut problems);
        }
    }
    if let Some(link) = bin_link() {
        // A symlink pointing at our install is ours to remove; anything else
        // at that name belongs to the user and is left alone.
        if link.is_symlink() {
            if matches!(fs::read_link(&link), Ok(ref t) if Some(t) == installed_app().as_ref()) {
                remove_if_present(&link, &mut problems);
            }
        }
    }
    // The application file last: if removing it fails, the launcher entry is
    // already gone, so the user is never left with a menu item that launches
    // something they asked to remove.
    if let Some(app) = installed_app() {
        remove_if_present(&app, &mut problems);
    }
    if let Some(dir) = install_dir() {
        let _ = fs::remove_dir(&dir); // only succeeds when empty, which is correct
    }
    refresh_desktop_database();

    if problems.is_empty() {
        Ok(status())
    } else {
        Err(problems.join("; "))
    }
}

fn remove_if_present(p: &Path, problems: &mut Vec<String>) {
    if p.is_symlink() || p.exists() {
        if let Err(e) = fs::remove_file(p) {
            problems.push(format!("{}: {e}", p.display()));
        }
    }
}

/* ── Tauri commands ─────────────────────────────────────────────────
   Thin wrappers. The frontend decides WHEN to ask; it cannot widen what
   any of these do. */

#[tauri::command]
pub fn appimage_status() -> IntegrationStatus {
    status()
}

#[tauri::command]
pub fn appimage_install() -> Result<IntegrationStatus, String> {
    install()
}

#[tauri::command]
pub fn appimage_uninstall() -> Result<IntegrationStatus, String> {
    uninstall()
}
