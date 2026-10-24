#![windows_subsystem = "windows"]

mod clipboard;
mod engine;
mod virtual_desktop;

use clipboard::ClipboardManager;
use engine::EngineProcess;
use std::net::TcpStream;
use std::time::Duration;
use tauri::{Manager, Window, WindowEvent};

pub struct AppState {
    pub clipboard: ClipboardManager,
    pub engine: EngineProcess,
}

#[tauri::command]
fn window_control(window: Window, action: String) {
    match action.as_str() {
        "minimize" => {
            let _ = window.minimize();
        }
        "maximize" => {
            if let Ok(is_max) = window.is_maximized() {
                if is_max {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
        }
        "close" => {
            let state: tauri::State<AppState> = window.state();
            state.engine.terminate();
            std::process::exit(0);
        }
        "fullscreen" => {
            if let Ok(is_fs) = window.is_fullscreen() {
                let _ = window.set_fullscreen(!is_fs);
            }
        }
        "start_dragging" => {
            let _ = window.start_dragging();
        }
        _ => {}
    }
}

#[tauri::command]
fn probe_device(host: String, port: u16) -> bool {
    let addr = format!("{}:{}", host, port);
    if let Ok(socket_addr) = addr.parse() {
        TcpStream::connect_timeout(&socket_addr, Duration::from_millis(600)).is_ok()
    } else {
        false
    }
}

#[tauri::command]
fn start_virtual_desktop(
    host: String,
    username: String,
    password: String,
    display: u32,
    geometry: String,
) -> Result<String, String> {
    virtual_desktop::start_virtual_desktop(&host, &username, &password, display, &geometry)
}

#[tauri::command]
fn kill_virtual_desktop(
    host: String,
    username: String,
    password: String,
    display: u32,
) -> Result<String, String> {
    virtual_desktop::kill_virtual_desktop(&host, &username, &password, display)
}

#[tauri::command]
fn fix_cursor(
    host: String,
    username: String,
    password: String,
    display: u32,
) -> Result<String, String> {
    virtual_desktop::fix_cursor(&host, &username, &password, display)
}

#[tauri::command]
fn read_clipboard(state: tauri::State<AppState>) -> Option<String> {
    state.clipboard.get_text()
}

#[tauri::command]
fn write_clipboard(state: tauri::State<AppState>, text: String) -> bool {
    state.clipboard.set_text(&text)
}

fn main() {
    let state = AppState {
        clipboard: ClipboardManager::new(),
        engine: EngineProcess::new(),
    };

    state.engine.ensure_running();

    let _ = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            window_control,
            probe_device,
            start_virtual_desktop,
            kill_virtual_desktop,
            fix_cursor,
            read_clipboard,
            write_clipboard
        ])
        .on_window_event(|event| {
            if let WindowEvent::Destroyed = event.event() {
                let state: tauri::State<AppState> = event.window().state();
                state.engine.terminate();
            }
        })
        .run(tauri::generate_context!());
}
