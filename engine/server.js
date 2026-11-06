const { WebSocketServer } = require('./ws');
const RfbClient = require('./rfb');

const PORT = 28888;
const HOST = '127.0.0.1';

const wss = new WebSocketServer(PORT, HOST);
let rfbClient = null;
let activeWs = null;
let pendingAuthCallback = null;

wss.on('connection', (ws) => {
  console.log('[Engine] Frontend client connected via WebSocket');
  activeWs = ws;

  ws.on('message', ({ type, data }) => {
    if (type !== 'text') return;
    try {
      const msg = JSON.parse(data);
      handleClientMessage(ws, msg);
    } catch (e) {
      console.error('[Engine] Error parsing message:', e.message);
    }
  });

  ws.on('error', (err) => {
    console.log('[Engine] Client socket error:', err.message);
  });

  ws.on('close', () => {
    console.log('[Engine] Frontend client disconnected');
    if (activeWs === ws) activeWs = null;
    if (rfbClient) {
      rfbClient.disconnect();
      rfbClient = null;
    }
    pendingAuthCallback = null;
  });
});

function handleClientMessage(ws, msg) {
  const { action } = msg;

  if (action === 'connect') {
    if (rfbClient) {
      rfbClient.disconnect();
      rfbClient = null;
    }

    const host = msg.host || '127.0.0.1';
    const port = parseInt(msg.port, 10) || 5900;
    const fps = parseInt(msg.fps, 10) || 60;

    console.log(`[Engine] Connecting to ${host}:${port} at ${fps} FPS...`);
    rfbClient = new RfbClient();
    rfbClient.setRefreshRate(fps);

    rfbClient.on('connected', (info) => {
      console.log('[Engine] Connected:', info);
      ws.send(JSON.stringify({ type: 'connected', ...info }));
    });

    rfbClient.on('error', (err) => {
      console.error('[Engine] RFB Error:', err);
      ws.send(JSON.stringify({ type: 'error', error: err }));
    });

    rfbClient.on('disconnected', () => {
      console.log('[Engine] Disconnected');
      ws.send(JSON.stringify({ type: 'disconnected' }));
    });

    rfbClient.on('auth_required', ({ authType }, callback) => {
      console.log(`[Engine] Auth required: ${authType}`);
      pendingAuthCallback = callback;
      ws.send(JSON.stringify({ type: 'auth_required', authType, host }));
    });

    rfbClient.on('clipboard', (text) => {
      ws.send(JSON.stringify({ type: 'clipboard', text }));
    });

    rfbClient.on('resize', (size) => {
      ws.send(JSON.stringify({ type: 'resize', ...size }));
    });

    // High performance binary frame transmission:
    // Opcode 1 = RECT (Raw 32-bit RGBA) - 12-byte aligned header
    rfbClient.on('rect', ({ x, y, width, height, data }) => {
      const header = Buffer.alloc(12);
      header[0] = 0x01; // RECT
      // bytes 1..3: padding for 4-byte payload alignment
      header.writeUInt16BE(x, 4);
      header.writeUInt16BE(y, 6);
      header.writeUInt16BE(width, 8);
      header.writeUInt16BE(height, 10);
      ws.send(Buffer.concat([header, data]));
    });

    // Opcode 2 = FILL (Solid color tile)
    rfbClient.on('fill', ({ x, y, width, height, color }) => {
      const buf = Buffer.alloc(12);
      buf[0] = 0x02; // FILL
      buf.writeUInt16BE(x, 1);
      buf.writeUInt16BE(y, 3);
      buf.writeUInt16BE(width, 5);
      buf.writeUInt16BE(height, 7);
      buf[9] = color[0];
      buf[10] = color[1];
      buf[11] = color[2];
      ws.send(buf);
    });

    // Opcode 3 = COPYRECT
    rfbClient.on('copyrect', ({ x, y, width, height, srcX, srcY }) => {
      const buf = Buffer.alloc(13);
      buf[0] = 0x03; // COPYRECT
      buf.writeUInt16BE(x, 1);
      buf.writeUInt16BE(y, 3);
      buf.writeUInt16BE(width, 5);
      buf.writeUInt16BE(height, 7);
      buf.writeUInt16BE(srcX, 9);
      buf.writeUInt16BE(srcY, 11);
      ws.send(buf);
    });

    rfbClient.connect(host, port);

  } else if (action === 'submit_credentials') {
    if (pendingAuthCallback) {
      pendingAuthCallback({ username: msg.username, password: msg.password });
      pendingAuthCallback = null;
    }

  } else if (action === 'cancel_auth') {
    if (rfbClient) {
      rfbClient.disconnect();
      rfbClient = null;
    }
    pendingAuthCallback = null;

  } else if (action === 'disconnect') {
    if (rfbClient) {
      rfbClient.disconnect();
      rfbClient = null;
    }

  } else if (action === 'pointer') {
    if (rfbClient) {
      rfbClient.sendPointerEvent(msg.x, msg.y, msg.buttonMask);
    }

  } else if (action === 'key') {
    if (rfbClient) {
      rfbClient.sendKeyEvent(msg.keysym, msg.down);
    }

  } else if (action === 'clipboard') {
    if (rfbClient && msg.text) {
      rfbClient.sendClientCutText(msg.text);
    }

  } else if (action === 'set_refresh_rate') {
    if (rfbClient) {
      rfbClient.setRefreshRate(msg.hz);
    }

  } else if (action === 'cad') {
    if (rfbClient) {
      // Ctrl+Alt+Del sequence
      const XK_Control_L = 0xffe3;
      const XK_Alt_L = 0xffe9;
      const XK_Delete = 0xffff;
      rfbClient.sendKeyEvent(XK_Control_L, true);
      rfbClient.sendKeyEvent(XK_Alt_L, true);
      rfbClient.sendKeyEvent(XK_Delete, true);
      rfbClient.sendKeyEvent(XK_Delete, false);
      rfbClient.sendKeyEvent(XK_Alt_L, false);
      rfbClient.sendKeyEvent(XK_Control_L, false);
    }
  }
}

wss.listen(() => {
  console.log(`[Engine] RVConnect RFB Bridge listening on ws://${HOST}:${PORT}`);
});

