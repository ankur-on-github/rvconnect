// Zero-dependency RFC 6455 WebSocket Server
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);

    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._processBuffer();
    });

    this.socket.on('close', () => this.emit('close'));
    this.socket.on('error', (err) => this.emit('error', err));
  }

  _processBuffer() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0F;
      const isMasked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLen) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 1) { // Text
        this.emit('message', { type: 'text', data: payload.toString('utf8') });
      } else if (opcode === 2) { // Binary
        this.emit('message', { type: 'binary', data: payload });
      } else if (opcode === 8) { // Close
        this.close();
        return;
      } else if (opcode === 9) { // Ping
        this.sendPong(payload);
      }
    }
  }

  send(data) {
    if (!this.socket || this.socket.destroyed) return;
    const isBuffer = Buffer.isBuffer(data);
    const opcode = isBuffer ? 2 : 1;
    const payload = isBuffer ? data : Buffer.from(data, 'utf8');
    const len = payload.length;

    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {}
  }

  sendPong(payload) {
    if (!this.socket || this.socket.destroyed) return;
    const header = Buffer.from([0x8A, payload.length]);
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {}
  }

  close() {
    if (this.socket) {
      try {
        this.socket.write(Buffer.from([0x88, 0x00]));
        this.socket.end();
      } catch (e) {}
    }
  }
}

class WebSocketServer extends EventEmitter {
  constructor(port = 28888, host = '127.0.0.1') {
    super();
    this.port = port;
    this.host = host;
    this.server = http.createServer((req, res) => {
      if (req.url === '/shutdown') {
        res.writeHead(200);
        res.end('shutting down');
        setTimeout(() => process.exit(0), 100);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('RVConnect RFB Bridge Active');
    });

    this.server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      const hash = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
      );

      const client = new WebSocketConnection(socket);
      this.emit('connection', client);
    });
  }

  listen(cb) {
    this.server.listen(this.port, this.host, cb);
  }

  close() {
    this.server.close();
  }
}

module.exports = { WebSocketServer, WebSocketConnection };

