//! service — AURA's local service, supervised by the desktop shell.
//!
//! In development the service is something the developer runs by hand
//! (`npm run ai`). In a packaged application there is no developer and no
//! terminal, so the shell has to own that lifecycle itself:
//!
//!     look at the port → start if needed → wait for health → show window
//!                                                    ↓
//!                                          graceful shutdown on exit
//!
//! Two rules shape everything here.
//!
//! **Never attach to a process we cannot identify.** Port 4319 being open
//! is not evidence that AURA is behind it. Something else on this machine
//! may own that port, and pointing the UI at an unknown local server —
//! then sending it project paths and capability invocations — is worse
//! than failing to start. So the port is fingerprinted, and anything that
//! does not answer as AURA is reported rather than used. We also never
//! kill whatever we find; the port belongs to whoever got there first.
//!
//! **Never fake readiness.** The window is shown when `/health` answers,
//! not when the process has been spawned. A spawned process that is still
//! importing modules, or that died on startup, is not a running service.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The pid of the service THIS process started, or 0.
///
/// Duplicated out of `ServiceHandle` because a signal handler may not lock
/// a mutex or allocate — an atomic read is one of the few things it may
/// safely do. It is only ever set for a service we spawned, so a reused
/// one is never signalled from here.
static SERVICE_PID: AtomicI32 = AtomicI32::new(0);

/// The port AURA's service and the renderer both agree on. The renderer
/// has this baked in at build time (`aiClient.ts`), so this is not a
/// preference — the two must match or the UI talks to nothing.
pub const DEFAULT_PORT: u16 = 4319;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const READ_TIMEOUT: Duration = Duration::from_millis(4000);

/// What is currently listening on the port, if anything.
pub enum PortState {
    /// Nothing is listening — we may start our own.
    Free,
    /// AURA's service, positively identified. Safe to reuse.
    Aura,
    /// Something is listening but it is not AURA. We must not use it and
    /// must not kill it.
    Foreign(String),
}

/// How the service came to be running, for honest reporting to the user.
pub enum Startup {
    /// A compatible AURA service was already running and was reused.
    Reused,
    /// We started it, and it passed its health check.
    Spawned,
}

/// The supervised child, plus whether this process owns it.
///
/// Ownership matters at shutdown: a service we reused belongs to whoever
/// started it — quitting AURA must not take it down.
pub struct ServiceHandle {
    child: Mutex<Option<Child>>,
    /// Port the supervised service listens on, for a graceful shutdown
    /// request on platforms without POSIX signals (Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    port: u16,
}

impl ServiceHandle {
    pub fn new(port: u16) -> Self {
        Self { child: Mutex::new(None), port }
    }

    fn adopt(&self, child: Child) {
        SERVICE_PID.store(child.id() as i32, Ordering::SeqCst);
        *self.child.lock().unwrap() = Some(child);
    }

    /// True when the supervised service is still alive. A child that has
    /// exited is reaped here, so this doubles as crash detection.
    pub fn is_alive(&self) -> bool {
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut() {
            None => false,
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                // Exited, or we cannot tell any more. Either way it is gone;
                // drop it so we never signal a recycled pid.
                _ => {
                    *guard = None;
                    false
                }
            },
        }
    }

    /// Stop the service we started, politely first.
    ///
    /// `start.ts` installs SIGTERM/SIGINT handlers that close the server
    /// and flush state, so on Unix SIGTERM is the correct signal and
    /// SIGKILL is the fallback for a process that ignores it. Windows has
    /// no SIGTERM at all — a hard `TerminateProcess` (what `kill` becomes
    /// there) would deny the service its graceful close — so the shell
    /// asks the service to shut itself down over its own loopback port
    /// first, and only force-terminates a process that ignores that.
    /// A service we did not start is never signalled — `child` is only
    /// ever populated by `adopt`, which only `ensure_running` calls after
    /// spawning.
    pub fn shutdown(&self) {
        let mut guard = self.child.lock().unwrap();
        SERVICE_PID.store(0, Ordering::SeqCst);
        let Some(mut child) = guard.take() else { return };

        // Already gone — nothing to signal, and no zombie to leave behind
        // because `try_wait` reaps it.
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }

        #[cfg(unix)]
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }

        #[cfg(windows)]
        {
            // Ask the service to close gracefully. `x-aura-shutdown` is a
            // required header the renderer can never send cross-origin
            // (browsers would need a CORS preflight that this service does
            // not allow), which keeps the endpoint no more exposed to other
            // local processes than the SIGTERM any local user can send on
            // Unix.
            let _ = request_graceful_shutdown(self.port);
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }

        // It would not leave on its own. Take it down rather than orphan it.
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Default for ServiceHandle {
    fn default() -> Self {
        Self::new(DEFAULT_PORT)
    }
}

/* ── Windows: dying together ─────────────────────────────────────── */

/// Tie the service's lifetime to this process, on the platform that has no
/// signals to do it with.
///
/// On Unix `install_termination_handlers` catches SIGTERM/SIGINT/SIGHUP and
/// kills the service before re-raising, so a `kill`, a logout or a
/// supervisor stop cannot orphan it. Windows has no equivalent: a
/// `TerminateProcess` — which is what Task Manager's "End task" and a hard
/// crash both are — runs no handler, no `RunEvent::Exit`, and nothing gets
/// the chance to stop the service. It survives, holding port 4319, and the
/// next launch refuses to start because the port is occupied.
///
/// A Job Object closes that gap in the kernel rather than in our code. The
/// service is assigned to a job marked `KILL_ON_JOB_CLOSE`; the job's only
/// handle is held by this process, so however this process ends — cleanly,
/// killed, or crashed — the handle closes, the job closes, and Windows
/// terminates everything in it.
///
/// Two properties are deliberate:
///
///   • **only a service we spawned is ever assigned.** `attach_to_job` is
///     called from exactly one place, immediately after our own `spawn`. A
///     reused service belongs to whoever started it and must outlive us; a
///     foreign process on the port is never touched at all.
///   • **graceful shutdown is unaffected.** The job is a backstop for
///     abnormal death only. A normal quit still runs the ordinary path —
///     `/shutdown` first, force only if ignored — so the service still gets
///     to close its server and flush state.
#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// A raw job handle. `HANDLE` is a bare pointer and therefore not `Send`
    /// or `Sync` by default; a kernel handle is process-wide and safe to use
    /// from any thread, and this one is only ever read.
    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    /// Created once and then deliberately never closed: the handle must stay
    /// open for the life of the process, because closing it is precisely what
    /// kills the service.
    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn handle() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                // A job we cannot configure would kill nothing on close, so
                // it is worse than none: drop it and fall back to the
                // ordinary shutdown path.
                CloseHandle(job);
                return None;
            }
            Some(Job(job))
        })
        .as_ref()
        .map(|j| j.0)
    }

    /// Put one pid in the job. Returns false if the OS declined, which is
    /// not fatal — graceful shutdown still works; only the abnormal-death
    /// backstop is missing, and the caller says so in the log.
    pub fn attach(pid: u32) -> bool {
        let Some(job) = handle() else { return false };
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(job, proc) != 0;
            CloseHandle(proc);
            ok
        }
    }
}

/* ── termination signals ─────────────────────────────────────────── */

/// Take the service down when this process is terminated by a signal.
///
/// `RunEvent::Exit` covers the ordinary quit — the user closes the window.
/// It does NOT cover being terminated by a signal: a session logout, a
/// `kill`, or a supervisor stopping the app. Without this the shell dies
/// and the service keeps running, holding port 4319 and outliving the
/// application that started it. That orphan is the failure this handler
/// exists to prevent.
///
/// Everything the handler does is async-signal-safe: an atomic swap, a
/// `kill`, restoring the default disposition and re-raising so the process
/// still dies from the original signal rather than silently absorbing it.
#[cfg(unix)]
extern "C" fn on_terminating_signal(sig: libc::c_int) {
    let pid = SERVICE_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

#[cfg(unix)]
pub fn install_termination_handlers() {
    unsafe {
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, on_terminating_signal as *const () as libc::sighandler_t);
        }
    }
}

#[cfg(not(unix))]
pub fn install_termination_handlers() {}

/* ── minimal HTTP, deliberately dependency-free ──────────────────── */

/// One HTTP/1.0 GET against loopback, returning `(status, body)`.
///
/// Written by hand rather than pulling in an HTTP client: this only ever
/// talks to 127.0.0.1, only issues GETs, and adding a full async client
/// (and its runtime) to the desktop shell to poll a health endpoint would
/// be a poor trade. `Connection: close` plus HTTP/1.0 means the body ends
/// at EOF, so no chunked-encoding handling is needed.
fn http_get(port: u16, path: &str, timeout: Duration) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
    stream.set_write_timeout(Some(READ_TIMEOUT)).ok();

    let req = format!(
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw).to_string();

    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "no HTTP status line".to_string())?;

    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("").to_string();
    Ok((status, body))
}

/// One HTTP/1.0 POST against loopback, with no body.
///
/// The same dependency-free reasoning as `http_get`: this only ever talks
/// to AURA's own service on 127.0.0.1. The `x-aura-shutdown` header is
/// part of the request the service requires before it will stop itself.
#[cfg(windows)]
fn http_post(port: u16, path: &str, timeout: Duration) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
    stream.set_write_timeout(Some(READ_TIMEOUT)).ok();

    let req = format!(
        "POST {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nx-aura-shutdown: 1\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw).to_string();

    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "no HTTP status line".to_string())?;

    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("").to_string();
    Ok((status, body))
}

/// Ask AURA's own service to close itself, on platforms that have no
/// SIGTERM. Only ever called for a child this process spawned (the handle
/// is only populated by `adopt`), so this never reaches an unknown process.
#[cfg(windows)]
fn request_graceful_shutdown(port: u16) -> bool {
    matches!(http_post(port, "/shutdown", CONNECT_TIMEOUT), Ok((200, _)))
}

/// Is the thing on this port actually AURA's service?
///
/// Fingerprinted on two endpoints rather than one. `/health` alone is a
/// common enough path that another local dev server could answer it with
/// a 200 and something JSON-shaped; `/fabric/capabilities` returning a
/// capability catalogue *and* a policy is specific to this application.
/// Requiring both is what makes "reuse" safe rather than optimistic.
fn identify(port: u16) -> PortState {
    let health = match http_get(port, "/health", CONNECT_TIMEOUT) {
        Ok(v) => v,
        // Nothing accepted the connection: the port is genuinely free.
        Err(_) => return PortState::Free,
    };

    if health.0 != 200 {
        return PortState::Foreign(format!("answered /health with HTTP {}", health.0));
    }
    if !(health.1.contains("\"health\"") && health.1.contains("\"index\"")) {
        return PortState::Foreign("answered /health, but not in AURA's shape".into());
    }

    match http_get(port, "/fabric/capabilities", CONNECT_TIMEOUT) {
        Ok((200, body)) if body.contains("\"capabilities\"") && body.contains("\"policy\"") => PortState::Aura,
        Ok((code, _)) => PortState::Foreign(format!("has no Capability Fabric (/fabric/capabilities → HTTP {code})")),
        Err(e) => PortState::Foreign(format!("has no Capability Fabric ({e})")),
    }
}

/* ── locating what we need to run ────────────────────────────────── */

/// The user's home directory on the platform that is actually running.
///
/// Windows shells rarely set `HOME`: the canonical variable is
/// `USERPROFILE`, with `HOMEDRIVE`+`HOMEPATH` as the legacy fallback.
/// `HOME` is still honoured last — git-bash and WSL interop export it, and
/// a user who sets it deliberately should keep it. The fallback for an
/// unset-everything case is the current directory rather than `/`, which
/// has no meaning on Windows.
fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(p) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(p);
        }
        if let (Some(drive), Some(path)) = (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
            return PathBuf::from(format!("{}{}", drive.to_string_lossy(), path.to_string_lossy()));
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")))
}

/// Where AURA keeps user state. Mirrors `persist.ts`, which resolves
/// `AURA_HOME || ~/.aura` — user state lives with the user, never inside
/// the installed application.
fn aura_home() -> PathBuf {
    std::env::var_os("AURA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".aura"))
}

/// A PATH the service can actually discover tools with.
///
/// This is not a convenience. `environment.ts` probes every external tool
/// with `execFile(probe.command, …)`, which resolves through the inherited
/// PATH — so the Connected Environment sees exactly what PATH allows it to
/// see. A desktop launcher hands a GUI process a minimal PATH (often just
/// `/usr/bin:/bin`), and under that AURA would report OpenCode, cargo, go
/// and everything else in a user bin directory as "not installed" — a
/// confident, wrong answer, which is the failure mode this codebase is
/// built to avoid.
///
/// So the inherited PATH is kept first (a developer's shell wins), and the
/// conventional user tool directories of the running platform are appended
/// behind it. The joined value uses the platform's own separator
/// (`:` on Unix, `;` on Windows) via `join_paths`, never a hardcoded one.
fn augmented_path(node_dir: Option<&PathBuf>) -> String {
    let home = home_dir();
    let mut parts: Vec<PathBuf> = Vec::new();

    if let Some(existing) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&existing));
    }

    // Whatever interpreter we resolved must itself stay reachable: `node`
    // and `npm` are catalogue entries and SAFE_BINARIES members, so the
    // service is expected to be able to run them.
    if let Some(dir) = node_dir {
        parts.push(dir.clone());
    }

    #[cfg(unix)]
    for candidate in [
        home.join(".local/bin"),
        home.join("bin"),
        home.join(".opencode/bin"),
        home.join(".cargo/bin"),
        home.join(".bun/bin"),
        home.join("go/bin"),
        home.join(".deno/bin"),
        // Homebrew's two prefixes: Intel (/usr/local) and Apple Silicon
        // (/opt/homebrew). macOS is not a Linux install — it gets its own
        // search rather than inheriting one by accident.
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ] {
        parts.push(candidate);
    }

    #[cfg(windows)]
    {
        // npm installs global binaries into %APPDATA%\npm; chocolatey and
        // scoop shim their own directories. Each of these is where a
        // GUI-launched process would otherwise fail to find a tool the
        // user genuinely installed.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            parts.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(program_data) = std::env::var_os("ProgramData") {
            parts.push(PathBuf::from(program_data).join("chocolatey/bin"));
        }
        for candidate in [
            home.join(".opencode/bin"),
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".bun/bin"),
            home.join("go/bin"),
            home.join(".deno/bin"),
            home.join("scoop/shims"),
            home.join("AppData/Roaming/npm"),
        ] {
            parts.push(candidate);
        }
    }

    let mut seen = std::collections::HashSet::new();
    let parts: Vec<PathBuf> = parts
        .into_iter()
        .filter(|p| !p.as_os_str().is_empty() && seen.insert(p.clone()))
        .collect();
    std::env::join_paths(parts)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Find a Node interpreter without trusting the launcher's environment.
///
/// The packaged application does not ship Node: AURA already treats it as
/// an external execution node (it is in the catalogue and in
/// `SAFE_BINARIES`), so requiring the real thing is consistent with how
/// every other tool is handled — and bundling a second copy would mean the
/// app runs on a different Node than the one it reports detecting.
fn resolve_node() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("AURA_NODE") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("AURA_NODE points at {}, which is not a file", p.display()));
    }

    let home = home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Windows ships Node as node.exe; Unix as node. The interpreter name is
    // a platform fact, not a preference.
    let exe = if cfg!(windows) { "node.exe" } else { "node" };

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(exe));
        }
    }

    #[cfg(unix)]
    candidates.extend([
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
        PathBuf::from("/opt/homebrew/bin/node"),
        home.join(".local/bin/node"),
        home.join(".bun/bin/node"),
    ]);

    #[cfg(windows)]
    candidates.extend([
        // Official installer, Chocolatey, Scoop and nvm-windows each have
        // their own canonical location — checked in that order.
        PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        home.join(r"scoop\apps\nodejs\current\node.exe"),
        home.join(r"AppData\Roaming\nvm\current\node.exe"),
    ]);

    // nvm (Unix) keeps versions in their own directories and exports them
    // through a shell hook the GUI never runs, so look directly.
    #[cfg(unix)]
    if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        for entry in versions.flatten() {
            candidates.push(entry.path().join("bin/node"));
        }
    }

    // nvm-windows (Windows) keeps one version folder per install under
    // %APPDATA%\nvm, with no shell hook to export anything.
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        if let Ok(versions) = std::fs::read_dir(PathBuf::from(appdata).join("nvm")) {
            for entry in versions.flatten() {
                candidates.push(entry.path().join("node.exe"));
            }
        }
    }

    candidates
        .into_iter()
        .find(|c| c.is_file())
        .ok_or_else(|| {
            "AURA needs Node.js to run its local service, and none was found. \
             Install Node 18 or newer, or set AURA_NODE to its full path."
                .to_string()
        })
}

/* ── startup ─────────────────────────────────────────────────────── */

/// Bring the service up, or explain precisely why we did not.
///
/// `script` is the resolved `ai-service.mjs` bundle — the caller owns
/// finding it, because that differs between a dev tree and a packaged
/// resource directory and the shell should not guess.
pub fn ensure_running(handle: &ServiceHandle, script: PathBuf, port: u16) -> Result<Startup, String> {
    match identify(port) {
        // Case 1 — AURA is already there (a developer's `npm run ai`, or a
        // second window). Reuse it, and leave its lifecycle to its owner.
        PortState::Aura => return Ok(Startup::Reused),

        // Case 2 — occupied by something else. Refuse, clearly. Killing it
        // would be destroying a process that was here first, and using it
        // would mean sending AURA's traffic to an unknown server.
        PortState::Foreign(why) => {
            return Err(format!(
                "Port {port} is in use by another program ({why}). AURA will not take over a port \
                 it does not own, and will not use a service it cannot identify. Stop that program, \
                 or free port {port}, then start AURA again."
            ))
        }

        PortState::Free => {}
    }

    if !script.is_file() {
        return Err(format!(
            "AURA's local service was not found at {}. The installation looks incomplete.",
            script.display()
        ));
    }

    let node = resolve_node()?;
    let node_dir = node.parent().map(PathBuf::from);

    // Logs belong with the rest of the user's AURA state, never inside the
    // installed application — which may well be read-only.
    let home = aura_home();
    let log_dir = home.join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Could not create {}: {e}", log_dir.display()))?;
    let log_path = log_dir.join("ai-service.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Could not open {}: {e}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    // What we resolved, on the shell's own stderr. When a service dies during
    // startup the failure is otherwise indistinguishable between "wrong Node",
    // "wrong script path" and "the service itself crashed" — and the path form
    // alone has already caused one silent failure on Windows (see
    // `strip_verbatim`). Two lines, printed once per launch.
    eprintln!("[aura] node   : {}", node.display());
    eprintln!("[aura] service: {}", script.display());

    let child = Command::new(&node)
        .arg(&script)
        // Without this the service resolves `process.cwd()` as a project to
        // open — which, for a packaged app, is wherever the launcher
        // happened to start us. The user's projects come from the registry.
        .arg("--none")
        .current_dir(&home)
        .env("PATH", augmented_path(node_dir.as_ref()))
        .env("AI_PORT", port.to_string())
        .env("AURA_HOME", &home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("Could not start AURA's local service using {}: {e}", node.display()))?;

    // Bind the service's lifetime to ours on Windows. This is the only call
    // site, and it is reached only for a service THIS process just spawned —
    // a reused service belongs to its own owner and a foreign process on the
    // port is never touched.
    #[cfg(windows)]
    if !job::attach(child.id()) {
        eprintln!(
            "[aura] warning: could not put the service in a job object; it may survive an \
             abnormal termination of this process and keep port {port} open."
        );
    }

    handle.adopt(child);

    match wait_healthy(handle, port, Duration::from_secs(90)) {
        Ok(()) => Ok(Startup::Spawned),
        Err(e) => {
            // Do not leave a half-started process behind on a failed launch.
            handle.shutdown();
            Err(format!("{e} The service log is at {}.", log_path.display()))
        }
    }
}

/// Poll until the service answers as AURA, it dies, or we run out of time.
///
/// Watching the child while polling is what turns "start failed" into a
/// distinct outcome from "start timed out": a process that exits during
/// startup is detected immediately instead of costing the full timeout.
fn wait_healthy(handle: &ServiceHandle, port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let PortState::Aura = identify(port) {
            return Ok(());
        }
        if !handle.is_alive() {
            return Err("AURA's local service stopped while starting up.".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "AURA's local service did not become ready within {}s.",
        timeout.as_secs()
    ))
}

/// Public probe used by the readiness command and the crash watcher.
pub fn is_healthy(port: u16) -> bool {
    matches!(identify(port), PortState::Aura)
}
