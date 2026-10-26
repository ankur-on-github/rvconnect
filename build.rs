fn main() {
    tauri_build::build();

    // Ensure WebView2Loader.dll is copied to the target directory on Windows
    #[cfg(windows)]
    copy_webview2_loader();
}

#[cfg(windows)]
fn copy_webview2_loader() {
    use std::path::PathBuf;
    use std::{env, fs};

    if let Ok(out_dir) = env::var("OUT_DIR") {
        let out_path = PathBuf::from(&out_dir);
        // OUT_DIR is target/(debug|release)/build/crate-hash/out
        // Go up 3 levels to reach target/(debug|release)
        if let Some(target_dir) = out_path.ancestors().nth(3) {
            let target_dll = target_dir.join("WebView2Loader.dll");
            if !target_dll.exists() {
                // Search common locations for WebView2Loader.dll
                let mut candidates = vec![PathBuf::from("WebView2Loader.dll")];
                if let Ok(cargo_home) = env::var("CARGO_HOME") {
                    candidates.push(PathBuf::from(cargo_home).join("bin").join("WebView2Loader.dll"));
                }
                if let Ok(userprofile) = env::var("USERPROFILE") {
                    candidates.push(
                        PathBuf::from(userprofile)
                            .join(".cargo")
                            .join("bin")
                            .join("WebView2Loader.dll"),
                    );
                }

                for src in candidates {
                    if src.exists() {
                        let _ = fs::copy(&src, &target_dll);
                        break;
                    }
                }
            }
        }
    }
}
