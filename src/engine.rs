use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct EngineProcess {
    child: Mutex<Option<Child>>,
}

impl EngineProcess {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub fn ensure_running(&self) {
        // If an old bridge is running on port 28888, request it to shutdown so fresh code runs
        if let Ok(mut stream) = TcpStream::connect_timeout(&"127.0.0.1:28888".parse().unwrap(), Duration::from_millis(300)) {
            use std::io::Write;
            let _ = stream.write_all(b"GET /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
            std::thread::sleep(Duration::from_millis(400));
        }

        println!("[Rust Engine] Launching headless bridge on 127.0.0.1:28888...");
        
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
        let script_path = exe_dir
            .as_ref()
            .map(|d| d.join("engine").join("server.js"))
            .filter(|p| p.exists())
            .unwrap_or_else(|| std::path::PathBuf::from("engine/server.js"));

        let node_bin = if let Some(ref dir) = exe_dir {
            let bundled_bin = dir.join("bin").join("node.exe");
            let bundled_root = dir.join("node.exe");
            if bundled_bin.exists() {
                bundled_bin
            } else if bundled_root.exists() {
                bundled_root
            } else if std::path::Path::new(r"C:\Program Files\nodejs\node.exe").exists() {
                std::path::PathBuf::from(r"C:\Program Files\nodejs\node.exe")
            } else {
                std::path::PathBuf::from("node")
            }
        } else if std::path::Path::new(r"C:\Program Files\nodejs\node.exe").exists() {
            std::path::PathBuf::from(r"C:\Program Files\nodejs\node.exe")
        } else {
            std::path::PathBuf::from("node")
        };

        let mut cmd = Command::new(&node_bin);
        cmd.arg(&script_path);
        if let Some(ref dir) = exe_dir {
            cmd.current_dir(dir);
            let log_file = dir.join("engine_bridge.log");
            if let Ok(f) = std::fs::File::create(&log_file) {
                if let Ok(err_f) = f.try_clone() {
                    cmd.stdout(std::process::Stdio::from(f));
                    cmd.stderr(std::process::Stdio::from(err_f));
                }
            }
        }
        cmd.creation_flags(CREATE_NO_WINDOW);

        let spawn_res = cmd.spawn();
        let _ = std::fs::write(
            exe_dir.as_ref().map(|d| d.join("engine_spawn.log")).unwrap_or_else(|| std::path::PathBuf::from("engine_spawn.log")),
            format!("node_bin: {:?}\nscript: {:?}\nres: {:?}", node_bin, script_path, spawn_res)
        );

        match spawn_res {
            Ok(child) => {
                println!("[Rust Engine] Bridge process started with PID {}", child.id());
                let mut guard = self.child.lock().unwrap();
                *guard = Some(child);
            }
            Err(e) => {
                eprintln!("[Rust Engine] Failed to spawn node bridge: {}", e);
            }
        }
    }

    pub fn terminate(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                println!("[Rust Engine] Terminating bridge process...");
                let _ = child.kill();
            }
        }
    }
}
