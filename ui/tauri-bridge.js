// Tauri & WebSocket Bridge for RVConnect Viewer
(function() {
  function getTauri() {
    return window.__TAURI__;
  }

  let ws = null;
  let wsConnected = false;
  let messageQueue = [];

  const listeners = {
    connected: [],
    error: [],
    disconnected: [],
    authRequired: [],
    rect: [],
    fill: [],
    copyrect: [],
    resize: [],
    deviceDiscovered: [],
    clipboardSync: [],
    fullscreenChange: []
  };

  let lastLocalClipboard = '';
  let lastRemoteClipboard = '';
  let clipboardInterval = null;

  function connectWebSocket() {
    try {
      ws = new WebSocket('ws://127.0.0.1:28888');
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log('[Bridge] WebSocket connection established');
        wsConnected = true;
        while (messageQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
          const item = messageQueue.shift();
          ws.send(item);
        }
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            handleTextMessage(msg);
          } catch (e) {
            console.error('[Bridge] Error parsing JSON message:', e);
          }
        } else if (event.data instanceof ArrayBuffer) {
          handleBinaryMessage(event.data);
        }
      };

      ws.onclose = () => {
        wsConnected = false;
        setTimeout(connectWebSocket, 1000);
      };

      ws.onerror = (err) => {
        console.warn('[Bridge] WebSocket error:', err);
      };
    } catch (e) {
      setTimeout(connectWebSocket, 1000);
    }
  }

  function sendWs(data) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      messageQueue.push(payload);
    }
  }

  function handleTextMessage(msg) {
    if (msg.type === 'connected') {
      listeners.connected.forEach(cb => cb(msg));
      startClipboardSync();
    } else if (msg.type === 'error') {
      listeners.error.forEach(cb => cb(msg.error));
      stopClipboardSync();
    } else if (msg.type === 'disconnected') {
      listeners.disconnected.forEach(cb => cb());
      stopClipboardSync();
    } else if (msg.type === 'auth_required') {
      listeners.authRequired.forEach(cb => cb({ authType: msg.authType, host: msg.host }));
    } else if (msg.type === 'resize') {
      listeners.resize.forEach(cb => cb({ width: msg.width, height: msg.height }));
    } else if (msg.type === 'clipboard') {
      const text = msg.text;
      if (text && text !== lastLocalClipboard) {
        lastRemoteClipboard = text;
        lastLocalClipboard = text;
        const t = getTauri();
        if (t && t.invoke) {
          t.invoke('write_clipboard', { text }).catch(() => {});
        }
        listeners.clipboardSync.forEach(cb => cb({ direction: 'remote-to-local', text }));
      }
    }
  }

  function handleBinaryMessage(buffer) {
    const view = new DataView(buffer);
    const opcode = view.getUint8(0);

    if (opcode === 0x01) { // RECT (Raw 32-bit RGBA pixel data)
      const x = view.getUint16(4);
      const y = view.getUint16(6);
      const width = view.getUint16(8);
      const height = view.getUint16(10);
      const data = new Uint8Array(buffer, 12);
      listeners.rect.forEach(cb => cb({ x, y, width, height, data }));
    } else if (opcode === 0x02) { // FILL (Solid tile)
      const x = view.getUint16(1);
      const y = view.getUint16(3);
      const width = view.getUint16(5);
      const height = view.getUint16(7);
      const color = [view.getUint8(9), view.getUint8(10), view.getUint8(11)];
      listeners.fill.forEach(cb => cb({ x, y, width, height, color }));
    } else if (opcode === 0x03) { // COPYRECT
      const x = view.getUint16(1);
      const y = view.getUint16(3);
      const width = view.getUint16(5);
      const height = view.getUint16(7);
      const srcX = view.getUint16(9);
      const srcY = view.getUint16(11);
      listeners.copyrect.forEach(cb => cb({ x, y, width, height, srcX, srcY }));
    }
  }

  function startClipboardSync() {
    stopClipboardSync();
    clipboardInterval = setInterval(async () => {
      try {
        const t = getTauri();
        if (!t || !t.invoke) return;
        const text = await t.invoke('read_clipboard');
        if (text && text !== lastLocalClipboard && text !== lastRemoteClipboard) {
          lastLocalClipboard = text;
          sendWs({ action: 'clipboard', text });
          listeners.clipboardSync.forEach(cb => cb({ direction: 'local-to-remote', text }));
        }
      } catch (e) {}
    }, 600);
  }

  function stopClipboardSync() {
    if (clipboardInterval) {
      clearInterval(clipboardInterval);
      clipboardInterval = null;
    }
  }

  // Setup window dragging via Tauri API
  document.addEventListener('DOMContentLoaded', () => {
    const dragArea = document.querySelector('.titlebar-drag');
    if (dragArea) {
      dragArea.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const t = getTauri();
        if (t && t.window && t.window.appWindow) {
          t.window.appWindow.startDragging();
        }
      });
    }

    const titlebar = document.querySelector('.titlebar');
    if (titlebar) {
      titlebar.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        window.api.windowControl('maximize');
      });
    }
  });

  // Connect WebSocket immediately
  connectWebSocket();

  // Expose window.api
  window.api = {
    windowControl: (action) => {
      const t = getTauri();
      if (t) {
        if (typeof t.invoke === 'function') {
          return t.invoke('window_control', { action });
        }
        if (t.tauri && typeof t.tauri.invoke === 'function') {
          return t.tauri.invoke('window_control', { action });
        }
      }
      if (action === 'close') {
        window.close();
      }
    },

    connectVnc: (address) => {
      let host = address.trim();
      let port = 5900;
      if (host.includes(':')) {
        const parts = host.split(':');
        host = parts[0];
        port = parseInt(parts[1], 10) || 5900;
      }
      sendWs({ action: 'connect', host, port, fps: 60 });
      return Promise.resolve({ status: 'connecting' });
    },

    disconnectVnc: () => {
      stopClipboardSync();
      sendWs({ action: 'disconnect' });
      return Promise.resolve();
    },

    submitCredentials: (creds) => {
      sendWs({ action: 'submit_credentials', username: creds.username, password: creds.password });
      return Promise.resolve();
    },

    cancelAuth: () => {
      sendWs({ action: 'cancel_auth' });
      return Promise.resolve();
    },

    sendPointer: (x, y, buttonMask) => {
      sendWs({ action: 'pointer', x, y, buttonMask });
    },

    sendKey: (keysym, down) => {
      sendWs({ action: 'key', keysym, down });
    },

    setRefreshRate: (hz) => {
      sendWs({ action: 'set_refresh_rate', hz });
    },

    sendClipboard: (text) => {
      if (text) {
        lastLocalClipboard = text;
        sendWs({ action: 'clipboard', text });
        const t = getTauri();
        if (t && t.invoke) {
          t.invoke('write_clipboard', { text }).catch(() => {});
        }
      }
    },

    sendCad: () => {
      sendWs({ action: 'cad' });
      return Promise.resolve();
    },

    rescanLan: async () => {
      const t = getTauri();
      if (t && t.invoke) {
        // Real active network probe: only announce if Pi actually responds!
        const isOnline = await t.invoke('probe_device', { host: '10.32.139.180', port: 5900 }).catch(() => false);
        if (isOnline) {
          listeners.deviceDiscovered.forEach(cb => cb({
            name: 'raspberrypi',
            host: '10.32.139.180',
            port: 5900,
            addresses: ['10.32.139.180']
          }));
        }
      }
      return Promise.resolve();
    },

    probeDevice: (host, port) => {
      const t = getTauri();
      if (t && t.invoke) {
        return t.invoke('probe_device', {
          host: host || '10.32.139.180',
          port: parseInt(port, 10) || 5900
        });
      }
      return Promise.resolve(false);
    },

    startVirtualDesktop: (opts) => {
      const t = getTauri();
      if (t && t.invoke) {
        return t.invoke('start_virtual_desktop', {
          host: opts.host || '10.32.139.180',
          username: opts.username || 'pi',
          password: opts.password || 'raspberry',
          display: parseInt(opts.display, 10) || 1,
          geometry: opts.geometry || '1280x720'
        });
      }
      return Promise.resolve('simulated');
    },

    killVirtualDesktop: (opts) => {
      const t = getTauri();
      if (t && t.invoke) {
        return t.invoke('kill_virtual_desktop', {
          host: opts.host || '10.32.139.180',
          username: opts.username || 'pi',
          password: opts.password || 'raspberry',
          display: parseInt(opts.display, 10) || 1
        });
      }
      return Promise.resolve('simulated');
    },

    fixCursor: (opts) => {
      const t = getTauri();
      if (t && t.invoke) {
        return t.invoke('fix_cursor', {
          host: opts.host || '10.32.139.180',
          username: opts.username || 'pi',
          password: opts.password || 'raspberry',
          display: parseInt(opts.display, 10) || 1
        });
      }
      return Promise.resolve('simulated');
    },

    onConnected: (cb) => listeners.connected.push(cb),
    onError: (cb) => listeners.error.push(cb),
    onDisconnected: (cb) => listeners.disconnected.push(cb),
    onAuthRequired: (cb) => listeners.authRequired.push(cb),
    onRect: (cb) => listeners.rect.push(cb),
    onFill: (cb) => listeners.fill.push(cb),
    onCopyRect: (cb) => listeners.copyrect.push(cb),
    onResize: (cb) => listeners.resize.push(cb),
    onDeviceDiscovered: (cb) => {
      listeners.deviceDiscovered.push(cb);
      // Only do real probe, never announce fake devices!
      const t = getTauri();
      if (t && t.invoke) {
        t.invoke('probe_device', { host: '10.32.139.180', port: 5900 }).then(online => {
          if (online) {
            cb({
              name: 'raspberrypi',
              host: '10.32.139.180',
              port: 5900,
              addresses: ['10.32.139.180']
            });
          }
        }).catch(() => {});
      }
    },
    onClipboardSync: (cb) => listeners.clipboardSync.push(cb),
    onFullscreenChange: (cb) => listeners.fullscreenChange.push(cb)
  };
})();
