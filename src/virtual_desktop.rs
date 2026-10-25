use std::io::Read;
use std::net::TcpStream;
use std::time::Duration;
use ssh2::Session;

pub fn execute_ssh_command(host: &str, user: &str, pass: &str, cmd: &str) -> Result<String, String> {
    let addr = if host.contains(':') {
        host.to_string()
    } else {
        format!("{}:22", host)
    };

    let socket_addr = addr.parse().map_err(|e| format!("Invalid address {}: {}", addr, e))?;
    let tcp = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(4))
        .map_err(|e| format!("Failed to connect to SSH {}: {}", addr, e))?;
    
    let mut sess = Session::new().map_err(|e| format!("Failed to create SSH session: {}", e))?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(6000);
    sess.handshake().map_err(|e| format!("SSH handshake failed: {}", e))?;
    sess.userauth_password(user, pass).map_err(|e| format!("SSH authentication failed: {}", e))?;

    let mut channel = sess.channel_session().map_err(|e| format!("Failed to open SSH channel: {}", e))?;
    channel.exec(cmd).map_err(|e| format!("Failed to exec command: {}", e))?;

    let mut output = String::new();
    channel.read_to_string(&mut output).map_err(|e| format!("Failed to read SSH output: {}", e))?;
    channel.wait_close().ok();

    Ok(output)
}

pub fn start_virtual_desktop(host: &str, user: &str, pass: &str, display: u32, geom: &str) -> Result<String, String> {
    let port = 5900 + display;
    // Accurate check if port is listening (avoids pgrep self-matching in shell)
    let check_cmd = format!(
        "if (netstat -tlpn 2>/dev/null | grep -E ':{port} ' >/dev/null || ss -tln 2>/dev/null | grep -E ':{port} ' >/dev/null); then echo RUNNING; else echo STOPPED; fi"
    );
    let check_out = execute_ssh_command(host, user, pass, &check_cmd).unwrap_or_default();
    let is_running = check_out.trim() == "RUNNING";

    if !is_running {
        // Clean up stale lock files and start vncserver-virtual
        let start_cmd = format!(
            "rm -f /tmp/.X{disp}-lock /tmp/.X11-unix/X{disp} /home/{user}/.vnc/*:{disp}.pid 2>/dev/null ; \
             vncserver-virtual :{disp} -geometry {geom} 2>&1 || vncserver :{disp} -geometry {geom} -depth 24 2>&1",
            disp = display,
            user = user,
            geom = geom
        );
        let out = execute_ssh_command(host, user, pass, &start_cmd)?;
        println!("SSH vncserver-virtual output: {}", out);

        // Wait up to 3 seconds for Xvnc to bind to port
        for _ in 0..6 {
            std::thread::sleep(Duration::from_millis(500));
            let check_again = execute_ssh_command(host, user, pass, &check_cmd).unwrap_or_default();
            if check_again.trim() == "RUNNING" {
                break;
            }
        }
    }

    // Fix the X11 cursor from ugly cross 'X' to standard left_ptr arrow pointer
    let fix_cmd = format!("DISPLAY=:{disp} xsetroot -cursor_name left_ptr 2>/dev/null || true", disp = display);
    execute_ssh_command(host, user, pass, &fix_cmd).ok();

    Ok(format!("Desktop :{} is active (port {})", display, port))
}

pub fn kill_virtual_desktop(host: &str, user: &str, pass: &str, display: u32) -> Result<String, String> {
    let kill_cmd = format!(
        "vncserver-virtual -kill :{disp} 2>&1 || vncserver -kill :{disp} 2>&1 ; \
         rm -f /tmp/.X{disp}-lock /tmp/.X11-unix/X{disp} /home/{user}/.vnc/*:{disp}.pid 2>/dev/null || true",
        disp = display,
        user = user
    );
    let out = execute_ssh_command(host, user, pass, &kill_cmd)?;
    println!("SSH kill output: {}", out);
    Ok(format!("Desktop :{} terminated", display))
}

pub fn fix_cursor(host: &str, user: &str, pass: &str, display: u32) -> Result<String, String> {
    let fix_cmd = format!("DISPLAY=:{disp} xsetroot -cursor_name left_ptr 2>/dev/null || true", disp = display);
    execute_ssh_command(host, user, pass, &fix_cmd)
}
