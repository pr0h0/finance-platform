// Local MCP server (PLAN §131, desktop; Settings → General → "Local MCP server", off by default).
// An MCP client (Claude Desktop, Claude Code, …) starts this same binary with `--mcp`: the relay
// below copies its stdin/stdout to the running app over 127.0.0.1. The app listens on a random port
// while the switch is on and writes {port, token} to <app config>/mcp.json, readable by this OS user
// only; the relay sends the token as its first line. Every JSON-RPC message is handed to the web
// app (event "mcp:request"), which answers from the local database (apps/web/src/mcp/local-server.ts)
// and replies through mcp_reply. The file existing means "on": the next start listens again.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

const FILE: &str = "mcp.json";
// tauri.conf.json "identifier": the relay runs without Tauri, so it builds the config path itself.
const IDENTIFIER: &str = "me.pr0h0.finplat";

#[derive(serde::Serialize, serde::Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

#[derive(Default)]
pub struct Mcp {
    server: Mutex<Option<Server>>,
    /// The web app is listening (signed in, profile open); otherwise requests get an error reply.
    attached: Arc<AtomicBool>,
}

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    conns: Arc<Mutex<HashMap<u64, TcpStream>>>,
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(FILE))
}

fn token() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn write_private(p: &PathBuf, data: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(p.parent().unwrap_or(p))?;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(p)?.write_all(data)
}

/// An error answer for a request the web app cannot take (None for notifications: no reply).
fn unavailable(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = v.get("id")?;
    Some(
        serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000,
        "message": "Finance Platform is locked or has no profile open: open the app and unlock it"}})
        .to_string(),
    )
}

fn serve<R: Runtime>(
    app: AppHandle<R>,
    stream: TcpStream,
    id: u64,
    token: String,
    conns: Arc<Mutex<HashMap<u64, TcpStream>>>,
    attached: Arc<AtomicBool>,
) {
    let mut lines = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    })
    .lines();
    if lines.next().and_then(Result::ok).as_deref() != Some(token.as_str()) {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    if let Ok(s) = stream.try_clone() {
        conns.lock().unwrap().insert(id, s);
    }
    for line in lines.map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        if attached.load(Ordering::SeqCst) {
            let _ = app.emit(
                "mcp:request",
                serde_json::json!({"conn": id, "message": line}),
            );
        } else if let Some(err) = unavailable(&line) {
            let mut s = &stream;
            let _ = writeln!(s, "{err}");
        }
    }
    conns.lock().unwrap().remove(&id);
}

fn start<R: Runtime>(app: &AppHandle<R>, m: &Mcp) -> Result<(), String> {
    let mut guard = m.server.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = token()?;
    let ep = serde_json::to_vec(&Endpoint {
        port,
        token: token.clone(),
    })
    .map_err(|e| e.to_string())?;
    write_private(&path(app)?, &ep).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let conns: Arc<Mutex<HashMap<u64, TcpStream>>> = Arc::default();
    let (app2, stop2, conns2, attached) =
        (app.clone(), stop.clone(), conns.clone(), m.attached.clone());
    std::thread::spawn(move || {
        let next = AtomicU64::new(1);
        for stream in listener.incoming() {
            if stop2.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let id = next.fetch_add(1, Ordering::SeqCst);
            let (app, token, conns, attached) = (
                app2.clone(),
                token.clone(),
                conns2.clone(),
                attached.clone(),
            );
            std::thread::spawn(move || serve(app, stream, id, token, conns, attached));
        }
    });
    *guard = Some(Server { port, stop, conns });
    Ok(())
}

fn stop(m: &Mcp) {
    if let Some(s) = m.server.lock().unwrap().take() {
        s.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", s.port)); // wakes the accept loop
        for c in s.conns.lock().unwrap().values() {
            let _ = c.shutdown(Shutdown::Both);
        }
    }
}

/// App start: listen again when the switch was left on.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if path(app).is_ok_and(|p| p.exists()) {
        if let Err(e) = start(app, &app.state::<Mcp>()) {
            eprintln!("local MCP server unavailable: {e}");
        }
    }
}

#[derive(serde::Serialize)]
pub struct McpStatus {
    on: bool,
    /// The program MCP clients run (with the argument --mcp).
    command: String,
}

fn command() -> String {
    // An AppImage runs from a temporary mount; $APPIMAGE is the file the user has.
    std::env::var("APPIMAGE")
        .ok()
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .map(|p| p.display().to_string())
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn mcp_get(m: State<'_, Mcp>) -> McpStatus {
    McpStatus {
        on: m.server.lock().unwrap().is_some(),
        command: command(),
    }
}

#[tauri::command]
pub fn mcp_set<R: Runtime>(app: AppHandle<R>, m: State<'_, Mcp>, on: bool) -> Result<(), String> {
    if on {
        return start(&app, &m);
    }
    stop(&m);
    let p = path(&app)?;
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The web app starts (true) or stops (false) answering requests.
#[tauri::command]
pub fn mcp_attach(m: State<'_, Mcp>, on: bool) {
    m.attached.store(on, Ordering::SeqCst);
}

#[tauri::command]
pub fn mcp_reply(m: State<'_, Mcp>, conn: u64, message: String) -> Result<(), String> {
    let guard = m.server.lock().unwrap();
    let s = guard.as_ref().ok_or("local MCP server is off")?;
    let conns = s.conns.lock().unwrap();
    let mut c = conns.get(&conn).ok_or("MCP client disconnected")?;
    writeln!(c, "{}", message.replace('\n', " ")).map_err(|e| e.to_string())
}

/// `finance-platform --mcp`: stdio ⇄ the running app. Returns the process exit code.
pub fn relay() -> i32 {
    let fail = |msg: &str| {
        eprintln!("finance-platform --mcp: {msg}");
        1
    };
    let Some(p) = dirs::config_dir().map(|d| d.join(IDENTIFIER).join(FILE)) else {
        return fail("no config directory");
    };
    let Ok(ep) = std::fs::read(&p)
        .map_err(|e| e.to_string())
        .and_then(|b| serde_json::from_slice::<Endpoint>(&b).map_err(|e| e.to_string()))
    else {
        return fail(
            "the local MCP server is off: Finance Platform → Settings → General → Local MCP server",
        );
    };
    let Ok(mut up) = TcpStream::connect(("127.0.0.1", ep.port)) else {
        return fail("Finance Platform is not running: start it (the local MCP server is on)");
    };
    if writeln!(up, "{}", ep.token).is_err() {
        return fail("connection to Finance Platform failed");
    }
    let Ok(down) = up.try_clone() else {
        return fail("connection to Finance Platform failed");
    };
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut up);
        let _ = up.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut BufReader::new(down), &mut std::io::stdout().lock());
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn unavailable_answers_requests_only() {
        let r = super::unavailable(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#).unwrap();
        assert!(r.contains(r#""id":7"#) && r.contains("-32000"));
        assert!(
            super::unavailable(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
                .is_none()
        );
        assert!(super::token().unwrap().len() == 64);
    }
}
