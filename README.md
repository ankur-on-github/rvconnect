# ⚡ RVConnect Viewer

<div align="center">

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Rust](https://img.shields.io/badge/language-Rust%202021-orange.svg)
![Tauri](https://img.shields.io/badge/framework-Tauri%20v1-informational.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey.svg)
![Raspberry Pi](https://img.shields.io/badge/compatible-Raspberry%20Pi%20OS-red.svg)

**A modern, lightweight, high-performance remote desktop client tailored for Raspberry Pi and standard RFB/VNC servers.**

*An open-source alternative to commercial VNC Connect viewers — engineered with Rust for blazing-fast 60 FPS zero-copy display streaming, native SSH virtual desktop automation, and minimal resource footprint (<25 MB).*

</div>

---

## ✨ Features

- **🚀 60 FPS Hardware-Paced Display Engine**: Zero-copy canvas blit with intelligent frame pacing that prevents CPU throttling on low-power host devices like the Raspberry Pi.
- **⚡ Native Virtual Desktop Automation (`:1`)**: Automatically starts, configures, and connects to high-resolution virtual X11 desktops via SSH without interfering with physical LCD/HDMI screens.
- **🖱️ Clean Pointer Rendering**: Automatically fixes the default X11 root crosshair cursor to the standard left pointer arrow (`left_ptr`) on remote virtual sessions.
- **🔒 Enterprise-Grade Security & Authentication**: Built-in support for Diffie-Hellman key exchange, AES-128/256 and DES challenge authentication, matching Raspberry Pi OS standard system user credentials out-of-the-box.
- **🎯 Floating Draggable Control Dock**: Smooth, non-intrusive toolbar that can be repositioned anywhere on screen. Includes quick CAD (`Ctrl+Alt+Del`), scaling options (Fit, 100%, Stretch), target refresh rate toggles (60 Hz, 120 Hz, 30 Hz), and session disconnect.
- **🔑 1-Click Auto-Connect Vault**: Securely saves passwords locally so subsequent connections to your devices launch instantly without repeated password prompts.
- **📐 Configurable Virtual Geometry**: Customize your default virtual desktop resolution directly from Settings (1080p Full HD, 900p, 720p HD, etc.).
- **📦 Ultra-Lightweight Binary**: Compiles down to a single ~23 MB executable with minimal RAM usage, eliminating the bloat of traditional heavyweight remote desktop packages.

---

## 🖥️ Raspberry Pi Compatibility Guide

RVConnect is optimized out-of-the-box for **Raspberry Pi OS** (Bookworm, Bullseye, and Buster) running the standard built-in VNC server.

### 1. Enable VNC on your Raspberry Pi
If VNC is not already enabled on your Raspberry Pi:
```bash
sudo raspi-config
```
Navigate to **Interface Options** → **VNC** → Select **Yes** to enable.

### 2. Dual-Mode Operation
- **Console Mode (`:0` on port 5900)**: Mirrors the physical display attached to the Raspberry Pi (HDMI monitor or LCD touch screen).
- **Virtual Desktop Mode (`:1` on port 5901)**: Creates an independent, high-speed virtual desktop at your chosen resolution (e.g. 1280×720 or 1920×1080) rendered entirely in memory.

When connecting via **⚡ Connect :1** or **⚡ Create :1**, RVConnect communicates with the Raspberry Pi over SSH (port 22) using your Linux credentials (`pi` / password) to verify or launch the virtual desktop automatically.

---

## 🚀 Quick Start

### 1-Click Windows Installer (Recommended)
1. Download **`RVConnect_Viewer_v1.0.0_Setup.exe`** from the [Releases](https://github.com/ankur-on-github/rvconnect/releases) section.
2. Run the installer wizard (installs to your user profile without requiring administrator privileges).
3. Check the optional **Create a desktop shortcut** box and click **Install**.
4. Launch **RVConnect Viewer** directly from your Start Menu or Desktop!

### Running Standalone
1. Download or clone this repository.
2. Launch `RVConnect Viewer.exe` (ensure `WebView2Loader.dll` is in the same folder).
3. In the **Direct LAN Connection** box, enter your Raspberry Pi's IP address (e.g., `10.32.139.180` or `raspberrypi.local`).
4. Click the arrow button (or press `Enter`) to connect to the console screen (`:0`), or use the **⚡ Connect :1** button on the device card for an automated virtual desktop session.

---

## 🛠️ Building from Source

### Prerequisites
- **Rust** (stable toolchain, 1.70+ recommended): [rustup.rs](https://rustup.rs/)
- **Node.js** (LTS v18+): [nodejs.org](https://nodejs.org/)
- **C/C++ Build Tools**: MinGW-w64 (e.g. WinLibs) or Visual Studio MSVC C++ Build Tools.
- **Inno Setup 6** *(Optional, for generating the `.exe` setup installer)*: [innosetup.com](https://jrsoftware.org/isdl.php)

### Build Steps

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ankur-on-github/rvconnect.git
   cd rvconnect
   ```

2. **Automated One-Step Build & Installer (PowerShell):**
   ```powershell
   .\build-installer.ps1
   ```
   *This compiles the optimized release binary, strips symbols down to ~19 MB, and packages the complete standalone installer (`dist\RVConnect_Viewer_v1.0.0_Setup.exe`, ~6.5 MB) automatically.*

3. **Or build manually via Cargo:**
   ```bash
   cargo build --release
   ```
   *`build.rs` will automatically ensure `WebView2Loader.dll` is copied into the target folder beside `rvconnect.exe`.*

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│                   RVConnect Viewer                     │
│                                                        │
│  ┌─────────────────────────┐  ┌──────────────────────┐ │
│  │   Tauri / Rust Core     │  │  Hardware Canvas UI  │ │
│  │ - SSH2 Desktop Manager  │  │ - Zero-Copy Blit     │ │
│  │ - Tao / Wry Window Host │  │ - Draggable Dock     │ │
│  │ - Arboard Clipboard IPC │  │ - Responsive Layout  │ │
│  └───────────┬─────────────┘  └───────────▲──────────┘ │
│              │                            │            │
│              ▼                            │ WebSockets │
│  ┌────────────────────────────────────────┴──────────┐ │
│  │               Headless RFB Bridge                 │ │
│  │ - RFC 6143 Remote Framebuffer Engine              │ │
│  │ - Diffie-Hellman / AES-128 / DES Security Handshake│ │
│  │ - Hextile / CopyRect / Raw Tile Decoders           │ │
│  └──────────────────────────┬────────────────────────┘ │
└─────────────────────────────┼──────────────────────────┘
                              │ RFB / TCP (5900, 5901)
                              ▼
                 ┌──────────────────────────┐
                 │    Target Host Device    │
                 │   (Raspberry Pi OS)      │
                 └──────────────────────────┘
```

---

## ⚙️ Configuration & Settings

| Setting | Options | Description |
| :--- | :--- | :--- |
| **Scaling** | `Fit`, `100%`, `Stretch` | Controls canvas scaling within the viewer window |
| **Target Refresh Rate** | `60 Hz`, `120 Hz`, `30 Hz`, `15 Hz` | Controls RFB update pacing to match network and host CPU capability |
| **Virtual Resolution** | `1920x1080`, `1600x900`, `1366x768`, `1280x720`, `1024x768` | Desktop geometry passed to `vncserver-virtual` via SSH |
| **Cursor Mode** | `Local Arrow Pointer`, `Remote Cursor Only`, `Dot` | Selects local mouse rendering vs server-rendered pointer |
| **Special Keys** | `Enabled` / `Disabled` | Toggles passing system keys (`Alt+Tab`, `Windows Key`) to the remote host |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

## ⚖️ Legal & Trademark Notice

*RVConnect is an independent, community-driven open-source project and is not affiliated with, endorsed by, or sponsored by RealVNC Limited, Raspberry Pi Ltd, or any of their affiliates.*

*All product names, trademarks, and registered trademarks—including **RealVNC®**, **VNC®**, **RFB®**, and **Raspberry Pi®**—are the property of their respective owners. Company, product, and service names used in this software and documentation are for identification and technical compatibility purposes only (nominative fair use). Use of these names, trademarks, and brands does not imply endorsement.*


