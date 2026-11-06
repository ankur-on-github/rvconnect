const net = require('net');
const EventEmitter = require('events');
const { encryptVncChallenge } = require('./des');
const { Ra2Session } = require('./ra2');

const SEC_NONE = 1;
const SEC_VNCAUTH = 2;
const SEC_RA2 = 5;
const SEC_RA2NE = 6;
const SEC_RA2R = 13;
const SEC_USERPASSWD = 16;
const SEC_RA2_256 = 129;
const SEC_RA2NE_256 = 130;
const SEC_RA2R_256 = 133;

const ENC_RAW = 0;
const ENC_COPYRECT = 1;
const ENC_HEXTILE = 5;
const ENC_DESKTOP_SIZE = -223;
const ENC_LAST_RECT = -224;
const ENC_CURSOR = -239;

function readColor32(buffer, offset, isBgr) {
  let r, g, b;
  if (isBgr) {
    b = buffer[offset];
    g = buffer[offset + 1];
    r = buffer[offset + 2];
  } else {
    r = buffer[offset];
    g = buffer[offset + 1];
    b = buffer[offset + 2];
  }
  return ((0xFF << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function getHextileRectLength(buf, startOffset, rw, rh) {
  let off = startOffset;
  for (let ty = 0; ty < rh; ty += 16) {
    const th = Math.min(16, rh - ty);
    for (let tx = 0; tx < rw; tx += 16) {
      const tw = Math.min(16, rw - tx);
      if (buf.length < off + 1) return -1;
      const subenc = buf[off++];

      if (subenc & 1) { // Raw tile
        const len = tw * th * 4;
        if (buf.length < off + len) return -1;
        off += len;
        continue;
      }

      if (subenc & 2) { // BackgroundSpecified
        if (buf.length < off + 4) return -1;
        off += 4;
      }

      if (subenc & 4) { // ForegroundSpecified
        if (buf.length < off + 4) return -1;
        off += 4;
      }

      if (subenc & 8) { // AnySubrects
        if (buf.length < off + 1) return -1;
        const numSub = buf[off++];
        const subLen = (subenc & 16) ? 6 : 2;
        if (buf.length < off + numSub * subLen) return -1;
        off += numSub * subLen;
      }
    }
  }
  return off - startOffset;
}

class RfbClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.state = 'DISCONNECTED';
    this.buffer = Buffer.alloc(0);
    this.rawBuffer = Buffer.alloc(0);
    this.isEncrypted = false;
    this.ra2Session = null;
    this.width = 0;
    this.height = 0;
    this.desktopName = '';
    this.selectedSecType = null;
    this.pendingAuthCallback = null;
    this.refreshRate = 60;
    this.pumpTimer = null;
    this.pendingUpdate = false;
    this.updateScheduledTimer = null;
    this.watchdogTimer = null;
    this.lastFrameTime = 0;
    this.lastButtonMask = 0;
    this.expectedRects = 0;
    this.isBgr = false;
    this.serverRedShift = 0;
    this.serverGreenShift = 8;
    this.serverBlueShift = 16;
  }

  connect(host, port = 5900) {
    this.disconnect();
    this.state = 'CONNECTING';
    this.buffer = Buffer.alloc(0);
    this.rawBuffer = Buffer.alloc(0);
    this.isEncrypted = false;
    this.ra2Session = null;
    this.pendingUpdate = false;
    this.expectedRects = 0;
    this.isBgr = false;

    this.socket = net.createConnection({ host, port }, () => {
      this.socket.setNoDelay(true);
      this.state = 'HANDSHAKE_VERSION';
    });

    this.socket.on('data', (chunk) => {
      if (this.isEncrypted) {
        this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);
        this.processEncryptedStream();
      } else {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
      }
    });

    this.socket.on('error', (err) => {
      this.emit('error', err.message);
      this.disconnect();
    });

    this.socket.on('close', () => {
      this.state = 'DISCONNECTED';
      this.pendingUpdate = false;
      this.emit('disconnected');
    });
  }

  disconnect() {
    this.stopUpdateWatchdog();
    this.stopUpdatePump();
    if (this.socket) {
      try {
        this.socket.end();
        this.socket.destroy();
      } catch (e) {}
      this.socket = null;
    }
    this.state = 'DISCONNECTED';
    this.pendingUpdate = false;
    this.isEncrypted = false;
    this.ra2Session = null;
  }

  write(data) {
    if (!this.socket || this.socket.destroyed) return;
    if (this.isEncrypted && this.ra2Session) {
      const wrapped = this.ra2Session.wrapStreamData(data);
      this.socket.write(wrapped);
    } else {
      this.socket.write(data);
    }
  }

  processEncryptedStream() {
    try {
      while (this.rawBuffer.length >= 2) {
        const msgLen = this.rawBuffer.readUInt16BE(0);
        if (this.rawBuffer.length < 2 + msgLen + 16) break;

        const encPayload = this.rawBuffer.subarray(2, 2 + msgLen);
        const mac = this.rawBuffer.subarray(2 + msgLen, 2 + msgLen + 16);
        this.rawBuffer = this.rawBuffer.subarray(2 + msgLen + 16);

        const decrypted = this.ra2Session.decryptIncomingMessage(encPayload, mac);
        if (!decrypted) {
          this.emit('error', 'Encrypted stream MAC verification failed');
          this.disconnect();
          return;
        }

        this.buffer = Buffer.concat([this.buffer, decrypted]);
      }

      if (this.buffer.length > 0) {
        this.processBuffer();
      }
    } catch (err) {
      console.error('Error processing encrypted stream:', err);
      this.emit('error', `Decryption error: ${err.message}`);
      this.disconnect();
    }
  }

  processBuffer() {
    try {
      while (this.buffer.length > 0) {
        if (this.state === 'HANDSHAKE_VERSION') {
          if (this.buffer.length < 12) return;
          const verStr = this.buffer.slice(0, 12).toString('ascii');
          this.buffer = this.buffer.slice(12);

          if (!verStr.startsWith('RFB ')) {
            this.emit('error', 'Invalid RFB protocol header from server');
            this.disconnect();
            return;
          }

          // Reply with standard RFB 003.008\n
          this.socket.write(Buffer.from('RFB 003.008\n', 'ascii'));
          this.state = 'HANDSHAKE_SECURITY';

        } else if (this.state === 'HANDSHAKE_SECURITY') {
          if (this.buffer.length < 1) return;
          const count = this.buffer[0];

          if (count === 0) {
            if (this.buffer.length < 5) return;
            const reasonLen = this.buffer.readUInt32BE(1);
            if (this.buffer.length < 5 + reasonLen) return;
            const reason = this.buffer.slice(5, 5 + reasonLen).toString('utf8');
            this.buffer = this.buffer.slice(5 + reasonLen);
            this.emit('error', `Server rejected connection: ${reason}`);
            this.disconnect();
            return;
          }

          if (this.buffer.length < 1 + count) return;
          const types = [];
          for (let i = 0; i < count; i++) {
            types.push(this.buffer[1 + i]);
          }
          this.buffer = this.buffer.slice(1 + count);

          // Select best security type supported
          if (types.includes(SEC_RA2) || types.includes(SEC_RA2_256) || types.includes(SEC_RA2R)) {
            const chosen = types.includes(SEC_RA2) ? SEC_RA2 : (types.includes(SEC_RA2_256) ? SEC_RA2_256 : SEC_RA2R);
            this.selectedSecType = chosen;
            this.ra2Session = new Ra2Session(chosen);
            this.socket.write(Buffer.from([chosen]));
            this.state = 'RA2_SERVER_KEY';
          } else if (types.includes(SEC_NONE)) {
            this.selectedSecType = SEC_NONE;
            this.socket.write(Buffer.from([SEC_NONE]));
            this.state = 'SECURITY_RESULT';
          } else if (types.includes(SEC_VNCAUTH)) {
            this.selectedSecType = SEC_VNCAUTH;
            this.socket.write(Buffer.from([SEC_VNCAUTH]));
            this.state = 'VNC_AUTH_CHALLENGE';
          } else if (types.includes(SEC_USERPASSWD)) {
            this.selectedSecType = SEC_USERPASSWD;
            this.socket.write(Buffer.from([SEC_USERPASSWD]));
            this.state = 'WAITING_SYSTEM_AUTH';
            this.promptCredentials('system');
          } else {
            this.emit('error', `No compatible security type offered: ${types.join(', ')}`);
            this.disconnect();
            return;
          }

        } else if (this.state === 'RA2_SERVER_KEY') {
          if (this.buffer.length < 4) return;
          const keyBits = this.buffer.readUInt32BE(0);
          const keyBytes = Math.ceil(keyBits / 8);
          const totalKeyMsgLen = 4 + keyBytes * 2;
          if (this.buffer.length < totalKeyMsgLen) return;

          const serverKeyData = this.buffer.subarray(0, totalKeyMsgLen);
          this.buffer = this.buffer.subarray(totalKeyMsgLen);

          this.ra2Session.setServerPublicKey(serverKeyData);
          // Send Client Public Key (516 bytes)
          this.socket.write(this.ra2Session.clientPublicKeyMsg);
          this.state = 'RA2_SERVER_RANDOM';

        } else if (this.state === 'RA2_SERVER_RANDOM') {
          if (this.buffer.length < 2) return;
          const encLen = this.buffer.readUInt16BE(0);
          if (this.buffer.length < 2 + encLen) return;

          const encServerRandom = this.buffer.subarray(2, 2 + encLen);
          this.buffer = this.buffer.subarray(2 + encLen);

          const clientRandomMsg = this.ra2Session.handleServerEncryptedRandom(encServerRandom);
          this.socket.write(clientRandomMsg);
          this.state = 'RA2_SERVER_HASH';

        } else if (this.state === 'RA2_SERVER_HASH') {
          if (this.buffer.length < 2) return;
          const msgLen = this.buffer.readUInt16BE(0);
          if (this.buffer.length < 2 + msgLen + 16) return;

          const encPayload = this.buffer.subarray(2, 2 + msgLen);
          const mac = this.buffer.subarray(2 + msgLen, 2 + msgLen + 16);
          this.buffer = this.buffer.subarray(2 + msgLen + 16);

          const valid = this.ra2Session.verifyServerHash(encPayload, mac);
          if (!valid) {
            this.emit('error', 'Server identity hash verification failed');
            this.disconnect();
            return;
          }

          // Send Client Hash
          const clientHashMsg = this.ra2Session.createClientHashMsg();
          this.socket.write(clientHashMsg);
          this.state = 'RA2_SERVER_SUBTYPE';

        } else if (this.state === 'RA2_SERVER_SUBTYPE') {
          if (this.buffer.length < 2) return;
          const msgLen = this.buffer.readUInt16BE(0);
          if (this.buffer.length < 2 + msgLen + 16) return;

          const encPayload = this.buffer.subarray(2, 2 + msgLen);
          const mac = this.buffer.subarray(2 + msgLen, 2 + msgLen + 16);
          this.buffer = this.buffer.subarray(2 + msgLen + 16);

          const subtype = this.ra2Session.decryptSubtype(encPayload, mac);
          if (subtype === null) {
            this.emit('error', 'Failed to decrypt authentication subtype');
            this.disconnect();
            return;
          }

          this.state = 'RA2_WAITING_AUTH';
          this.promptCredentials(subtype === 2 ? 'vnc' : 'system');

        } else if (this.state === 'RA2_SECURITY_RESULT') {
          if (this.buffer.length < 2) return;
          const msgLen = this.buffer.readUInt16BE(0);
          if (this.buffer.length < 2 + msgLen + 16) return;

          const encPayload = this.buffer.subarray(2, 2 + msgLen);
          const mac = this.buffer.subarray(2 + msgLen, 2 + msgLen + 16);
          this.buffer = this.buffer.subarray(2 + msgLen + 16);

          const result = this.ra2Session.decryptSecurityResult(encPayload, mac);
          if (!result.success) {
            this.emit('error', result.reason || 'Authentication failed');
            this.disconnect();
            return;
          }

          // Full Session Encryption is now ACTIVE
          this.isEncrypted = true;
          if (this.buffer.length > 0) {
            this.rawBuffer = Buffer.concat([this.buffer, this.rawBuffer]);
            this.buffer = Buffer.alloc(0);
          }
          this.sendClientInit();
          if (this.rawBuffer.length > 0) {
            this.processEncryptedStream();
          }

        } else if (this.state === 'SECURITY_RESULT') {
          if (this.buffer.length < 4) return;
          const res = this.buffer.readUInt32BE(0);
          this.buffer = this.buffer.slice(4);
          if (res !== 0) {
            this.emit('error', 'Security handshake rejected by server');
            this.disconnect();
            return;
          }
          this.sendClientInit();

        } else if (this.state === 'VNC_AUTH_CHALLENGE') {
          if (this.buffer.length < 16) return;
          const challenge = Buffer.from(this.buffer.slice(0, 16));
          this.buffer = this.buffer.slice(16);
          this.state = 'WAITING_VNC_PASSWORD';
          this.promptCredentials('vnc', challenge);

        } else if (this.state === 'VNC_AUTH_RESULT') {
          if (this.buffer.length < 4) return;
          const res = this.buffer.readUInt32BE(0);
          this.buffer = this.buffer.slice(4);
          if (res !== 0) {
            this.emit('error', 'Authentication failed (Incorrect Password)');
            this.disconnect();
            return;
          }
          this.sendClientInit();

        } else if (this.state === 'SERVER_INIT') {
          if (this.buffer.length < 24) return;
          const w = this.buffer.readUInt16BE(0);
          const h = this.buffer.readUInt16BE(2);
          const redShift = this.buffer[14];
          const greenShift = this.buffer[15];
          const blueShift = this.buffer[16];
          this.serverRedShift = redShift;
          this.serverGreenShift = greenShift;
          this.serverBlueShift = blueShift;
          this.isBgr = (blueShift === 0 && redShift === 16);
          const nameLen = this.buffer.readUInt32BE(20);

          if (this.buffer.length < 24 + nameLen) return;
          const name = this.buffer.slice(24, 24 + nameLen).toString('utf8');
          this.buffer = this.buffer.slice(24 + nameLen);

          this.width = w;
          this.height = h;
          this.desktopName = name;
          this.framebuffer = Buffer.alloc(w * h * 4);

          this.state = 'CONNECTED';
          this.startUpdateWatchdog();
          this.restartUpdatePump();

          this.sendSetPixelFormat();
          this.sendSetEncodings();
          this.requestUpdate(false);

          this.emit('connected', { width: w, height: h, name });

        } else if (this.state === 'CONNECTED') {
          if (!this.processServerMessage()) return;
        } else {
          return;
        }
      }
    } catch (e) {
      console.error('Error processing buffer:', e);
      this.emit('error', `Protocol error: ${e.message}`);
      this.disconnect();
    }
  }

  promptCredentials(authType, challenge = null) {
    this.emit('auth_required', { authType }, (credentials) => {
      if (this.state === 'RA2_WAITING_AUTH') {
        const username = credentials.username || '';
        const password = credentials.password || '';
        const credsMsg = this.ra2Session.createCredentialsMsg(username, password);
        this.socket.write(credsMsg);
        this.state = 'RA2_SECURITY_RESULT';
      } else if (authType === 'vnc') {
        const response = encryptVncChallenge(challenge, credentials.password || '');
        this.socket.write(response);
        this.state = 'VNC_AUTH_RESULT';
      } else if (authType === 'system') {
        const user = credentials.username || '';
        const pass = credentials.password || '';
        const userBuf = Buffer.from(user, 'utf8');
        const passBuf = Buffer.from(pass, 'utf8');
        const payload = Buffer.alloc(8 + userBuf.length + passBuf.length);
        payload.writeUInt32BE(userBuf.length, 0);
        payload.writeUInt32BE(passBuf.length, 4);
        userBuf.copy(payload, 8);
        passBuf.copy(payload, 8 + userBuf.length);

        this.socket.write(payload);
        this.state = 'SECURITY_RESULT';
      }
    });
  }

  sendClientInit() {
    this.state = 'SERVER_INIT';
    this.write(Buffer.from([1])); // shared = 1
  }

  sendSetPixelFormat() {
    // 32-bit TrueColour RGBA (little endian: byte 0=R, byte 1=G, byte 2=B, byte 3=Pad/Alpha)
    // Directly matches HTML5 Canvas ImageData byte layout with 0 conversion overhead
    const buf = Buffer.alloc(20);
    buf[0] = 0; // msg type SetPixelFormat
    buf[4] = 32; // bits per pixel
    buf[5] = 24; // depth
    buf[6] = 0;  // big-endian = 0
    buf[7] = 1;  // true-colour = 1
    buf.writeUInt16BE(255, 8);  // red max
    buf.writeUInt16BE(255, 10); // green max
    buf.writeUInt16BE(255, 12); // blue max
    buf[14] = 0;  // red shift: 0 (byte 0)
    buf[15] = 8;  // green shift: 8 (byte 1)
    buf[16] = 16; // blue shift: 16 (byte 2)
    this.write(buf);
  }

  sendSetEncodings(quality = 'auto') {
    // Enable Hextile, CopyRect, DesktopSize, LastRect, and Cursor pseudo-encodings
    const encodings = [ENC_COPYRECT, ENC_HEXTILE, ENC_RAW, ENC_DESKTOP_SIZE, ENC_LAST_RECT, ENC_CURSOR];

    const buf = Buffer.alloc(4 + encodings.length * 4);
    buf[0] = 2; // msg type SetEncodings
    buf[1] = 0; // pad
    buf.writeUInt16BE(encodings.length, 2);
    for (let i = 0; i < encodings.length; i++) {
      buf.writeInt32BE(encodings[i], 4 + i * 4);
    }
    this.write(buf);
  }

  setRefreshRate(hz) {
    this.refreshRate = parseInt(hz, 10) || 60;
  }

  restartUpdatePump() {
    this.stopUpdatePump();
    if (this.state !== 'CONNECTED') return;
    // Request initial full frame if not requested
    this.requestUpdate(false, true);
  }

  stopUpdatePump() {
    if (this.updateScheduledTimer) {
      clearTimeout(this.updateScheduledTimer);
      this.updateScheduledTimer = null;
    }
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  startUpdateWatchdog() {
    this.stopUpdateWatchdog();
    this.lastFrameTime = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (this.state === 'CONNECTED' && Date.now() - this.lastFrameTime > 750) {
        // Recover if an update request was dropped
        this.pendingUpdate = false;
        this.requestUpdate(true, true);
      }
    }, 400);
  }

  stopUpdateWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  requestUpdate(incremental = true, force = false) {
    if (!this.socket || this.state !== 'CONNECTED' || !this.width || !this.height) return;
    if (this.pendingUpdate && !force) return;

    this.pendingUpdate = true;
    const buf = Buffer.alloc(10);
    buf[0] = 3; // FramebufferUpdateRequest
    buf[1] = incremental ? 1 : 0;
    buf.writeUInt16BE(0, 2);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(this.width, 6);
    buf.writeUInt16BE(this.height, 8);
    this.write(buf);
  }

  scheduleNextUpdate() {
    if (this.updateScheduledTimer) {
      clearTimeout(this.updateScheduledTimer);
      this.updateScheduledTimer = null;
    }
    if (this.state !== 'CONNECTED') return;

    // Rate-limit next update request based on target refreshRate
    const targetInterval = Math.max(8, Math.round(1000 / (this.refreshRate || 60)));
    this.updateScheduledTimer = setTimeout(() => {
      this.updateScheduledTimer = null;
      if (this.state === 'CONNECTED') {
        this.requestUpdate(true, false);
      }
    }, targetInterval);
  }

  processServerMessage() {
    while (true) {
      if (this.expectedRects === 0) {
        if (this.buffer.length < 1) return false;
        const msgType = this.buffer[0];

        if (msgType === 0) { // FramebufferUpdate header
          if (this.buffer.length < 4) return false;
          this.expectedRects = this.buffer.readUInt16BE(2);
          this.buffer = this.buffer.slice(4);
          if (this.expectedRects === 0) {
            this.pendingUpdate = false;
            this.scheduleNextUpdate();
            continue;
          }
        } else if (msgType === 2) { // Bell
          this.buffer = this.buffer.slice(1);
          this.emit('bell');
          continue;
        } else if (msgType === 3) { // ServerCutText
          if (this.buffer.length < 8) return false;
          const len = this.buffer.readUInt32BE(4);
          if (this.buffer.length < 8 + len) return false;
          const text = this.buffer.slice(8, 8 + len).toString('utf8');
          this.buffer = this.buffer.slice(8 + len);
          this.emit('clipboard', text);
          continue;
        } else {
          // Unknown message, discard 1 byte
          this.buffer = this.buffer.slice(1);
          continue;
        }
      }

      // We are consuming rectangles for the current FramebufferUpdate
      if (this.expectedRects > 0) {
        if (this.buffer.length < 12) return false;

        const rx = this.buffer.readUInt16BE(0);
        const ry = this.buffer.readUInt16BE(2);
        const rw = this.buffer.readUInt16BE(4);
        const rh = this.buffer.readUInt16BE(6);
        const enc = this.buffer.readInt32BE(8);

        if (enc === ENC_DESKTOP_SIZE) {
          this.buffer = this.buffer.slice(12);
          this.width = rw;
          this.height = rh;
          this.framebuffer = Buffer.alloc(rw * rh * 4);
          this.framebuffer32 = new Uint32Array(this.framebuffer.buffer, this.framebuffer.byteOffset, rw * rh);
          this.emit('resize', { width: rw, height: rh });
          this.expectedRects--;
          if (this.expectedRects === 0) {
            this.lastFrameTime = Date.now();
            this.pendingUpdate = false;
            this.scheduleNextUpdate();
          }
          continue;
        }

        if (enc === ENC_LAST_RECT) {
          this.buffer = this.buffer.slice(12);
          this.expectedRects = 0;
          this.lastFrameTime = Date.now();
          this.pendingUpdate = false;
          this.scheduleNextUpdate();
          continue;
        }

        if (enc === ENC_CURSOR) {
          const bitmaskLen = Math.floor((rw + 7) / 8) * rh;
          const totalCursorLen = rw * rh * 4 + bitmaskLen;
          if (this.buffer.length < 12 + totalCursorLen) return false;
          this.buffer = this.buffer.slice(12 + totalCursorLen);
          this.expectedRects--;
          if (this.expectedRects === 0) {
            this.lastFrameTime = Date.now();
            this.pendingUpdate = false;
            this.scheduleNextUpdate();
          }
          continue;
        }

        if (enc === ENC_RAW) {
          const byteLen = rw * rh * 4;
          if (this.buffer.length < 12 + byteLen) return false; // Wait for full rectangle
          const pixelData = this.buffer.slice(12, 12 + byteLen);
          this.buffer = this.buffer.slice(12 + byteLen);

          // Guarantee alpha is 0xFF and swap BGR to RGBA if server sends BGR
          if (this.isBgr) {
            for (let p = 0; p < pixelData.length; p += 4) {
              const b = pixelData[p];
              pixelData[p] = pixelData[p + 2];
              pixelData[p + 2] = b;
              pixelData[p + 3] = 0xFF;
            }
          } else {
            for (let p = 3; p < pixelData.length; p += 4) {
              pixelData[p] = 0xFF;
            }
          }

          if (this.framebuffer) {
            for (let y = 0; y < rh; y++) {
              const src = y * rw * 4;
              const dst = ((ry + y) * this.width + rx) * 4;
              if (dst + rw * 4 <= this.framebuffer.length) {
                pixelData.copy(this.framebuffer, dst, src, src + rw * 4);
              }
            }
          }

          this.emit('rect', { x: rx, y: ry, width: rw, height: rh, encoding: 'raw', data: pixelData });
          this.expectedRects--;
          if (this.expectedRects === 0) {
            this.lastFrameTime = Date.now();
            this.pendingUpdate = false;
            this.scheduleNextUpdate();
          }
          continue;
        }

        if (enc === ENC_COPYRECT) {
          if (this.buffer.length < 12 + 4) return false;
          const srcX = this.buffer.readUInt16BE(12);
          const srcY = this.buffer.readUInt16BE(14);
          this.buffer = this.buffer.slice(16);

          if (this.framebuffer) {
            for (let y = 0; y < rh; y++) {
              const src = ((srcY + y) * this.width + srcX) * 4;
              const dst = ((ry + y) * this.width + rx) * 4;
              if (src + rw * 4 <= this.framebuffer.length && dst + rw * 4 <= this.framebuffer.length) {
                this.framebuffer.copy(this.framebuffer, dst, src, src + rw * 4);
              }
            }
          }

          this.emit('copyrect', { x: rx, y: ry, width: rw, height: rh, srcX, srcY });
          this.expectedRects--;
          if (this.expectedRects === 0) {
            this.lastFrameTime = Date.now();
            this.pendingUpdate = false;
            this.scheduleNextUpdate();
          }
          continue;
        }

        if (enc === ENC_HEXTILE) {
          const hLen = getHextileRectLength(this.buffer, 12, rw, rh);
          if (hLen === -1) return false; // Wait for full Hextile rectangle

          let offset = 12;
          if (!this.framebuffer || this.framebuffer.length !== this.width * this.height * 4) {
            this.framebuffer = Buffer.alloc(this.width * this.height * 4);
            this.framebuffer32 = new Uint32Array(this.framebuffer.buffer, this.framebuffer.byteOffset, this.width * this.height);
          } else if (!this.framebuffer32) {
            this.framebuffer32 = new Uint32Array(this.framebuffer.buffer, this.framebuffer.byteOffset, this.width * this.height);
          }
          let curBg = 0xFF000000;
          let curFg = 0xFFFFFFFF;

          for (let ty = 0; ty < rh; ty += 16) {
            const th = Math.min(16, rh - ty);
            for (let tx = 0; tx < rw; tx += 16) {
              const tw = Math.min(16, rw - tx);
              const subenc = this.buffer[offset++];

              if (subenc & 1) { // Raw tile
                for (let y = 0; y < th; y++) {
                  const src = offset + y * tw * 4;
                  const dst = ((ry + ty + y) * this.width + (rx + tx)) * 4;
                  if (dst + tw * 4 <= this.framebuffer.length) {
                    this.buffer.copy(this.framebuffer, dst, src, src + tw * 4);
                    if (this.isBgr) {
                      for (let p = dst; p < dst + tw * 4; p += 4) {
                        const b = this.framebuffer[p];
                        this.framebuffer[p] = this.framebuffer[p + 2];
                        this.framebuffer[p + 2] = b;
                        this.framebuffer[p + 3] = 0xFF;
                      }
                    } else {
                      for (let p = dst + 3; p < dst + tw * 4; p += 4) {
                        this.framebuffer[p] = 0xFF;
                      }
                    }
                  }
                }
                offset += tw * th * 4;
                continue;
              }

              if (subenc & 2) {
                curBg = readColor32(this.buffer, offset, this.isBgr);
                offset += 4;
              }

              for (let y = 0; y < th; y++) {
                const rowStart = (ry + ty + y) * this.width + (rx + tx);
                this.framebuffer32.fill(curBg, rowStart, rowStart + tw);
              }

              if (subenc & 4) {
                curFg = readColor32(this.buffer, offset, this.isBgr);
                offset += 4;
              }

              if (subenc & 8) {
                const numSub = this.buffer[offset++];
                const colored = (subenc & 16) !== 0;

                for (let s = 0; s < numSub; s++) {
                  let subColor = curFg;
                  if (colored) {
                    subColor = readColor32(this.buffer, offset, this.isBgr);
                    offset += 4;
                  }
                  const xy = this.buffer[offset++];
                  const wh = this.buffer[offset++];
                  const sx = xy >> 4;
                  const sy = xy & 0x0F;
                  const sw = (wh >> 4) + 1;
                  const sh = (wh & 0x0F) + 1;

                  for (let y = 0; y < sh; y++) {
                    const rowStart = (ry + ty + sy + y) * this.width + (rx + tx + sx);
                    this.framebuffer32.fill(subColor, rowStart, rowStart + sw);
                  }
                }
              }
            }
          }

          // Slice buffer past this Hextile rectangle
          this.buffer = this.buffer.slice(12 + hLen);

          // Emit the decoded rectangle as one unified pixel block
          const rectBuf = Buffer.allocUnsafe(rw * rh * 4);
          for (let y = 0; y < rh; y++) {
            const src = ((ry + y) * this.width + rx) * 4;
            const dst = y * rw * 4;
            if (src + rw * 4 <= this.framebuffer.length) {
              this.framebuffer.copy(rectBuf, dst, src, src + rw * 4);
            }
          }
          this.emit('rect', { x: rx, y: ry, width: rw, height: rh, encoding: 'raw', data: rectBuf });

          this.expectedRects--;
          if (this.expectedRects === 0) {
            this.lastFrameTime = Date.now();
            this.pendingUpdate = false;
            this.scheduleNextUpdate();
          }
          continue;
        }

        this.emit('error', `Unsupported encoding ${enc}`);
        this.disconnect();
        return false;
      }
    }
  }

  sendPointerEvent(x, y, buttonMask) {
    if (!this.socket || this.state !== 'CONNECTED') return;
    const buf = Buffer.alloc(6);
    buf[0] = 5; // PointerEvent
    buf[1] = buttonMask;
    buf.writeUInt16BE(x, 2);
    buf.writeUInt16BE(y, 4);
    this.write(buf);

    // If button state changed (down OR up/released, e.g. click to close window or right click menu),
    // immediately request an update so the resulting UI change renders without waiting!
    const buttonChanged = (buttonMask !== this.lastButtonMask);
    this.lastButtonMask = buttonMask;
    if (buttonChanged && !this.pendingUpdate) {
      this.requestUpdate(true, false);
    }
  }

  sendKeyEvent(keysym, down) {
    if (!this.socket || this.state !== 'CONNECTED') return;
    const buf = Buffer.alloc(8);
    buf[0] = 4; // KeyEvent
    buf[1] = down ? 1 : 0;
    buf[2] = 0; buf[3] = 0; // pad
    buf.writeUInt32BE(keysym, 4);
    this.write(buf);
    // If a key press occurred and no update is currently in flight, request an update
    if (down && !this.pendingUpdate) {
      this.requestUpdate(true, false);
    }
  }

  sendClientCutText(text) {
    if (!this.socket || this.state !== 'CONNECTED' || !text) return;
    const strBuf = Buffer.from(text, 'utf8');
    const buf = Buffer.alloc(8 + strBuf.length);
    buf[0] = 6; // ClientCutText
    buf[1] = 0; buf[2] = 0; buf[3] = 0; // pad
    buf.writeUInt32BE(strBuf.length, 4);
    strBuf.copy(buf, 8);
    this.write(buf);
  }
}

module.exports = RfbClient;
