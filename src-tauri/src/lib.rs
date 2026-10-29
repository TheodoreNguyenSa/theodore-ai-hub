// The Theodore AI Hub window: a thin shell with no logic of its own. It starts `relay serve` on the bundled Node, waits for the
// line `relay serve: <url>` and shows that page. Everything else (agents, store, approvals) lives in the server.
//
// - The server's stdin is a pipe we hold open and never write to: `--exit-with-stdin` makes the server (and its agents)
//   stop when this process is gone, even if it is killed.
// - On Windows the server also runs in a Job Object with KILL_ON_JOB_CLOSE, so no agent survives the app.
// - Files dragged onto the window arrive here with their full paths and are handed to the page (window.relayDrop).
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{DragDropEvent, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct Server {
    child: Mutex<Option<Child>>,
    _stdin: Mutex<Option<ChildStdin>>,
    #[cfg(windows)]
    _job: Mutex<Option<job::Job>>,
}

fn relay_home() -> PathBuf {
    if let Ok(h) = std::env::var("RELAY_HOME") {
        return PathBuf::from(h);
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".theodore")
}

fn log(msg: &str) {
    let dir = relay_home();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        let _ = writeln!(f, "[{:?}] {}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), msg);
    }
}

/// Node to run the server with: RELAY_NODE, the one bundled with the app, else `node` on PATH.
fn find_node(resources: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RELAY_NODE") {
        return Some(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = resources.join("node").join(exe);
    if bundled.exists() {
        return Some(bundled);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| p.exists())
}

/// The server entry: RELAY_SERVER_ENTRY, the bundled copy, else this source tree (development builds).
fn find_entry(resources: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RELAY_SERVER_ENTRY") {
        return Some(PathBuf::from(p));
    }
    let bundled = resources.join("app").join("server").join("index.mjs");
    if bundled.exists() {
        return Some(bundled);
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("server").join("index.mjs");
    if dev.exists() {
        return Some(dev);
    }
    None
}

fn show_error(app: &tauri::AppHandle, msg: &str) {
    log(msg);
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.relayError && window.relayError({})", serde_json::to_string(msg).unwrap_or_default());
        let _ = w.eval(js);
    }
}

fn start_server(app: tauri::AppHandle) {
    let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let Some(node) = find_node(&resources) else {
        return show_error(&app, "Theodore AI Hub could not find Node to run its server. Reinstall Theodore AI Hub, or install Node.js 20+ and start Theodore AI Hub again.");
    };
    let Some(entry) = find_entry(&resources) else {
        return show_error(&app, "Theodore AI Hub's server files are missing. Reinstall Theodore AI Hub.");
    };
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let logs = relay_home();
    let _ = std::fs::create_dir_all(&logs);
    let stderr = OpenOptions::new().create(true).append(true).open(logs.join("server.log")).map(Stdio::from).unwrap_or_else(|_| Stdio::null());

    let mut cmd = Command::new(&node);
    cmd.arg(&entry).args(["serve", "--port", "0", "--exit-with-stdin"]).current_dir(&home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(stderr);
    if let Ok(p) = std::env::var("RELAY_PROJECT") {
        cmd.env("RELAY_PROJECT", p);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    log(&format!("starting {} {} serve", node.display(), entry.display()));
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return show_error(&app, &format!("Theodore AI Hub could not start its server ({}): {}", node.display(), e)),
    };
    #[cfg(windows)]
    let job = job::kill_on_close(&child);
    let stdout = child.stdout.take();
    let stdin = child.stdin.take();
    if let Some(state) = app.try_state::<Server>() {
        *state.child.lock().unwrap() = Some(child);
        *state._stdin.lock().unwrap() = stdin;
        #[cfg(windows)]
        {
            *state._job.lock().unwrap() = job;
        }
    }

    let Some(stdout) = stdout else { return show_error(&app, "Theodore AI Hub's server gave no output.") };
    let started = Instant::now();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return show_error(&app, &format!("Theodore AI Hub's server stopped while starting. Details: {}", logs.join("server.log").display())),
            Ok(_) => {
                if let Some(rest) = line.trim().strip_prefix("relay serve: ") {
                    match url::Url::parse(rest) {
                        Ok(u) => {
                            log(&format!("server up after {:?}", started.elapsed()));
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.navigate(u);
                            }
                        }
                        Err(e) => show_error(&app, &format!("Theodore AI Hub's server printed a bad address: {}", e)),
                    }
                    break;
                }
            }
            Err(e) => return show_error(&app, &format!("Reading Theodore AI Hub's server failed: {}", e)),
        }
    }
    // keep reading (and dropping) whatever the server prints, so its stdout pipe never fills up
    std::thread::spawn(move || {
        let mut sink = String::new();
        while reader.read_line(&mut sink).map(|n| n > 0).unwrap_or(false) {
            sink.clear();
        }
    });
}

fn stop_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Server>() {
        // closing stdin asks the server to stop its agents and exit; give it a moment, then make sure
        *state._stdin.lock().unwrap() = None;
        if let Some(mut c) = state.child.lock().unwrap().take() {
            let until = Instant::now() + Duration::from_millis(1500);
            while Instant::now() < until {
                if let Ok(Some(_)) = c.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = c.kill();
        }
    }
}

fn drop_js(kind: &str, paths: &[PathBuf], x: f64, y: f64) -> String {
    let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
    format!(
        "window.relayDrop && window.relayDrop({{kind:{},paths:{},x:{},y:{}}})",
        serde_json::to_string(kind).unwrap(),
        serde_json::to_string(&paths).unwrap(),
        x,
        y
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    {
        // one window per user: a second start focuses the first
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Server {
            child: Mutex::new(None),
            _stdin: Mutex::new(None),
            #[cfg(windows)]
            _job: Mutex::new(None),
        })
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Theodore AI Hub")
                .inner_size(1320.0, 840.0)
                .min_inner_size(760.0, 480.0)
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || start_server(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(ev) = event {
                let js = match ev {
                    DragDropEvent::Enter { paths, position } => drop_js("enter", paths, position.x, position.y),
                    DragDropEvent::Over { position } => drop_js("over", &[], position.x, position.y),
                    DragDropEvent::Drop { paths, position } => drop_js("drop", paths, position.x, position.y),
                    DragDropEvent::Leave => drop_js("leave", &[], 0.0, 0.0),
                    _ => return,
                };
                if let Some(w) = window.app_handle().get_webview_window("main") {
                    let _ = w.eval(js);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Theodore AI Hub");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_server(handle);
        }
    });
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Holding this keeps the job open; when the app exits (or is killed) Windows closes it and ends every process in it.
    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn kill_on_close(child: &std::process::Child) -> Option<Job> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let job = Job(h);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return None;
            }
            if AssignProcessToJobObject(h, child.as_raw_handle() as HANDLE) == 0 {
                return None;
            }
            Some(job)
        }
    }
}
