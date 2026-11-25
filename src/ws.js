'use strict';
/**
 * 轻量级 WebSocket 广播中心（RFC 6455 最小实现，零外部依赖）
 */
const crypto = require('crypto');

class WSHub {
  constructor() {
    this.clients = new Set();
    this._hb = setInterval(() => this._pingAll(), 30000);
    if (this._hb.unref) this._hb.unref();
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const c = { socket, alive: true };
    this.clients.add(c);
    socket.on('close', () => this.clients.delete(c));
    socket.on('error', () => this.clients.delete(c));
    socket.on('data', buf => this._onData(c, buf));
  }

  _onData(c, buf) {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    c.alive = true;
    if (opcode === 0x8) {
      this.clients.delete(c);
      try { c.socket.end(); } catch {}
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      try { c.socket.write(Buffer.from([0x8a, 0x00])); } catch {}
      return;
    }
    // 0xA = pong, 0x1 = text (目前仅下行广播)
  }

  _pingAll() {
    for (const c of this.clients) {
      if (!c.alive) {
        this.clients.delete(c);
        try { c.socket.destroy(); } catch {}
        continue;
      }
      c.alive = false;
      try { c.socket.write(Buffer.from([0x89, 0x00])); } catch {
        this.clients.delete(c);
      }
    }
  }

  send(obj) {
    if (!this.clients.size) return;
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x81, data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const frame = Buffer.concat([header, data]);
    for (const c of this.clients) {
      try { c.socket.write(frame); } catch { this.clients.delete(c); }
    }
  }

  close() {
    clearInterval(this._hb);
    for (const c of this.clients) {
      try { c.socket.destroy(); } catch {}
    }
    this.clients.clear();
  }

  get count() { return this.clients.size; }
}

module.exports = { WSHub };
