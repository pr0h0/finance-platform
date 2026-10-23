// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // MCP clients run `finance-platform --mcp` (stdio relay to the running app, mcp.rs).
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        std::process::exit(finplat_native_lib::mcp::relay());
    }
    finplat_native_lib::run()
}
