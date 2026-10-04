/**
 * HTTP + WebSocket 服务。
 *
 * WebSocket 握手与帧解析自己实现（RFC 6455 的服务端最小实现，约 100 行），
 * 换来的是零 npm 依赖 —— RK3399 上部署只要拷贝文件，不需要 npm install，
 * 也不会因为某个包要编译原生模块而卡住。
 *
 * 对内网自用场景，鉴权用一个启动时生成的访问令牌，够用且不引入账号体系。
 */

import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// 本文件位于 server/api/，因此上两级才是工程根
const PROJECT_ROOT = resolve(__dirname, '../..');
const WEB_ROOT = resolve(PROJECT_ROOT, 'web');
const DATA_ROOT = resolve(PROJECT_ROOT, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// 极简 WebSocket 实现
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketServer {
  constructor() {
    this.clients = new Set();
  }

  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const client = new WSClient(socket);
    this.clients.add(client);
    socket.on('close', () => this.clients.delete(client));
    if (head && head.length) client._onData(head);
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const c of this.clients) {
      if (c.readyState === 1) c.send(text);
    }
  }
}

class WSClient {
  constructor(socket) {
    this.socket = socket;
    this.readyState = 1;
    this.buffer = Buffer.alloc(0);
    this.onMessage = null;
    this.onClose = null;

    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this.close());
    socket.on('close', () => { this.readyState = 3; this.onClose?.(); });
    socket.setNoDelay(true);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // 客户端发来的帧都是掩码的、不分片（我们的协议简单）
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.slice(offset, offset + len);
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      this.buffer = this.buffer.slice(offset + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._send(0xa, payload); continue; }
      if (opcode === 0x1) this.onMessage?.(payload.toString('utf8'));
    }
  }

  _send(opcode, data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch { this.close(); }
  }

  send(text) { this._send(0x1, text); }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this._send(0x8, Buffer.alloc(0)); this.socket.end(); } catch { /* 已断开 */ }
  }
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenEquals(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/' || p === '') p = '/index.html';
  // 防目录穿越
  const full = normalize(join(WEB_ROOT, p));
  if (!full.startsWith(WEB_ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const st = await stat(full);
    if (!st.isFile()) throw new Error('not a file');
    const data = await readFile(full);
    const ext = extname(full).toLowerCase();

    // 用「文件大小 + 修改时间」做 ETag，配 If-None-Match 返回 304。
    // 这样：改了文件 ETag 立刻变、浏览器立刻拿到新代码（不会跑旧版逻辑）；
    // 没改时只传 304 不传正文。
    // 之前直接给 300 秒 max-age，结果改了 render.js 浏览器仍用缓存的旧版，
    // 现象是「代码明明改了却没效果」，排查极费时间。
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

export { sendJson, readBody, tokenEquals, serveStatic, WebSocketServer, WSClient, DATA_ROOT, WEB_ROOT };
