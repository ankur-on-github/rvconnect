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

#[derive(serde::Serialize, Clone, Debug)]
pub struct DiscoveredDevice {
    pub name: String,
    pub host: String,
    pub ip: String,
    pub port: u16,
    pub addresses: Vec<String>,
}

#[tauri::command]
fn probe_device(host: String, port: u16) -> bool {
    use std::net::ToSocketAddrs;
    let target = format!("{}:{}", host.trim(), port);
    if let Ok(mut addrs) = target.to_socket_addrs() {
        if let Some(socket_addr) = addrs.next() {
            return TcpStream::connect_timeout(&socket_addr, Duration::from_millis(800)).is_ok();
        }
    }
    false
}

#[tauri::command]
async fn scan_network() -> Vec<DiscoveredDevice> {
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    let local_ip = (|| {
        let s = UdpSocket::bind("0.0.0.0:0").ok()?;
        s.connect("8.8.8.8:80").ok()?;
        match s.local_addr().ok()?.ip() {
            std::net::IpAddr::V4(ip) => Some(ip),
            _ => None,
        }
    })();

    let local_ip = match local_ip {
        Some(ip) => ip,
        None => return Vec::new(),
    };

    let octets = local_ip.octets();
    let mut tasks = Vec::with_capacity(254);

    for d in 1..255 {
        let target_ip = Ipv4Addr::new(octets[0], octets[1], octets[2], d);

        tasks.push(tokio::spawn(async move {
            let addr_5900 = SocketAddr::V4(SocketAddrV4::new(target_ip, 5900));
            if let Ok(Ok(_)) = timeout(Duration::from_millis(350), TcpStream::connect(addr_5900)).await {
                let ip_str = target_ip.to_string();
                return Some(DiscoveredDevice {
                    name: format!("VNC Server ({})", ip_str),
                    host: ip_str.clone(),
                    ip: ip_str.clone(),
                    port: 5900,
                    addresses: vec![ip_str],
                });
            }

            let addr_5901 = SocketAddr::V4(SocketAddrV4::new(target_ip, 5901));
            if let Ok(Ok(_)) = timeout(Duration::from_millis(250), TcpStream::connect(addr_5901)).await {
                let ip_str = target_ip.to_string();
                return Some(DiscoveredDevice {
                    name: format!("Virtual Desktop ({})", ip_str),
                    host: ip_str.clone(),
                    ip: ip_str.clone(),
                    port: 5901,
                    addresses: vec![ip_str],
                });
            }

            None
        }));
    }

    let mut discovered = Vec::new();
    for t in tasks {
        if let Ok(Some(dev)) = t.await {
            discovered.push(dev);
        }
    }
    discovered
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
            scan_network,
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
