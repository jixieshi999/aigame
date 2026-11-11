'use strict';
const net = require('node:net');
const crypto = require('node:crypto');

/** Build a masked client frame, including malformed variants for protocol boundary tests. */
function clientFrame(opcode, value = '', options = {}) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const size = options.length ?? payload.length;
  const width = size < 126 ? 2 : size <= 65535 ? 4 : 10;
  const masked = options.mask !== false;
  const header = Buffer.alloc(width + (masked ? 4 : 0));
  header[0] = (options.fin === false ? 0 : 128) | opcode | (options.rsv || 0);
  header[1] = (masked ? 128 : 0) | (width === 2 ? size : width === 4 ? 126 : 127);
  if (width === 4) header.writeUInt16BE(size, 2);
  if (width === 10) header.writeBigUInt64BE(BigInt(size), 2);
  const copy = Buffer.from(payload);
  if (masked) {
    const mask = crypto.randomBytes(4); mask.copy(header, width);
    for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
  }
  return Buffer.concat([header, copy]);
}

class RawClient {
  constructor(port, options = {}) {
    this.messages = []; this.waiters = []; this.buffer = Buffer.alloc(0); this.handshake = false;
    this.autoPong = options.autoPong !== false;
    this.socket = net.createConnection({ port, host: '127.0.0.1' });
    this.key = crypto.randomBytes(16).toString('base64');
    this.socket.on('connect', () => this.socket.write([
      `GET ${options.path || '/'} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket',
      'Connection: keep-alive, Upgrade', `Sec-WebSocket-Key: ${options.key || this.key}`,
      `Sec-WebSocket-Version: ${options.version || '13'}`,
      ...(options.origin === null ? [] : [`Origin: ${options.origin || `http://127.0.0.1:${port}`}`]), '', ''
    ].join('\r\n')));
    this.socket.on('data', chunk => this.receive(chunk));
    this.socket.on('error', error => this.push({ type: '$error', reason: error.message }));
    this.socket.on('close', () => this.push({ type: '$tcpClose' }));
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshake) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      this.header = this.buffer.subarray(0, end).toString(); this.handshake = true;
      this.buffer = this.buffer.subarray(end + 4);
      this.push({ type: '$http', header: this.header });
      if (!this.header.startsWith('HTTP/1.1 101')) return;
    }
    while (this.buffer.length >= 2) {
      let size = this.buffer[1] & 127, offset = 2;
      if (size === 126) { if (this.buffer.length < 4) return; size = this.buffer.readUInt16BE(2); offset = 4; }
      if (size === 127) { if (this.buffer.length < 10) return; size = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + size) return;
      const op = this.buffer[0] & 15, payload = this.buffer.subarray(offset, offset + size);
      this.buffer = this.buffer.subarray(offset + size);
      if (op === 1) this.push(JSON.parse(payload.toString()));
      if (op === 8) { this.push({ type: '$close', code: size >= 2 ? payload.readUInt16BE() : 1005 }); this.socket.end(); }
      if (op === 9) {
        this.push({ type: '$ping', payload });
        if (this.autoPong) this.socket.write(clientFrame(10, payload));
      }
      if (op === 10) this.push({ type: '$pong', payload });
    }
  }
  push(message) {
    const index = this.waiters.findIndex(waiter => waiter.predicate(message));
    if (index >= 0) { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    else this.messages.push(message);
  }
  next(type, predicate = () => true, timeout = 3000) {
    const match = message => message.type === type && predicate(message);
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate: match, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`等待 ${type} 超时；已有消息：${this.messages.map(m => m.type).join(',')}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
  send(message) { this.socket.write(clientFrame(1, JSON.stringify({ v: 3, ...message }))); }
  destroy() { this.socket.destroy(); }
}
module.exports = { RawClient, clientFrame };
