/**
 * 串口传输：零原生依赖实现。
 *
 * 为什么不用 serialport / node-usb 这类 npm 包？
 *   它们带 C++ 扩展，RK3399 的 ARM64 上要么找不到预编译产物，要么现场编译需要
 *   装 build-essential + python + 交叉工具链。刻字机服务是要求「拷贝即用」的，
 *   不能让部署步骤卡在编译上。
 *
 * 原理：串口在 Linux 上就是一个字符设备文件。stty 负责设置 termios
 * （波特率、数据位、校验、流控），之后的收发就是普通文件读写。
 * 这个做法在树莓派/PiBot 的 WebUI 上被验证过，是可靠的。
 */

import { exec, execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const PARITY_MAP = { none: '-parenb', even: 'parenb', odd: 'parenb', mark: '', space: '' };

/**
 * 构造一条带英文的 Error。
 *
 * Error 只有 message 一个字段，没地方挂第二种语言。
 * 这里把英文塞进 `errorEn` 属性，接口层就能按客户端语言取
 * （见 server/index.js 里 `err(err.message, err.errorEn)`）。
 *
 * 保持 message 为中文，是为了不破坏现有的日志与堆栈输出——
 * 那些地方按约定就是中文。
 *
 * ⚠️ 必须定义在**类之前**：模块顶层是 ESM，`const` / `function` 声明虽会提升，
 * 但这里若定义在文件后部，`new SerialTransport().write()` 在其实例化之后
 * 才调用没问题，可 `selftest` 里的「未连接就 write」会在模块求值阶段就触发，
 * 报 `biErr is not defined` ——这类错误只在特定调用顺序下出现，很难联想到是定义位置。
 */
export function biErr(zh, en) {
  const e = new Error(zh);
  e.errorEn = en;
  return e;
}

export class SerialTransport extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.path = opts.path;
    this.baud = opts.baud || 9600;
    this.dataBits = opts.dataBits || 8;
    this.stopBits = opts.stopBits || 1;
    this.parity = opts.parity || 'none';
    this.rtscts = !!opts.rtscts;
    this.open = false;
    this.fd = null;
    this._rx = null;
    this._pending = '';
  }

  static async list() {
    const out = [];
    try {
      const { stdout } = await execAsync('ls -1 /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true');
      for (const line of stdout.trim().split('\n')) {
        if (line) out.push(line.trim());
      }
    } catch { /* 无串口设备 */ }
    return out;
  }

  /**
   * 读取设备信息：VID/PID 与厂商名。
   *
   * sysfs 路径不能靠字符串替换拼：/dev/ttyUSB0 → /sys/class/tty/ttyUSB0，
   * USB 设备的 idVendor 在 device 链上（…/device/../idVendor）。
   * 早期版本用 replace 拼路径，路径不对就读不到，界面上一律显示
   * 「— [null:null]」，无法判断接的是哪块板子。
   */
  static async describe(devPath) {
    const info = {
      path: devPath,
      vendorId: null, productId: null,
      product: null, manufacturer: null, serial: null,
    };
    const name = devPath.replace(/^\/dev\//, '');
    const base = `/sys/class/tty/${name}/device/..`;
    const readOne = async (field) => {
      try {
        const s = await readFile(`${base}/${field}`, 'utf8');
        return s.trim() || null;
      } catch {
        return null;
      }
    };
    const [vid, pid, prod, manu, ser] = await Promise.all([
      readOne('idVendor'), readOne('idProduct'), readOne('product'),
      readOne('manufacturer'), readOne('serial'),
    ]);
    info.vendorId = vid;
    info.productId = pid;
    info.product = prod;
    info.manufacturer = manu;
    info.serial = ser;
    return info;
  }

  async connect() {
    if (this.open) return;
    await this._configure();
    this.fd = await open(this.path, 'r+');
    this._startRx();
    this.open = true;
    this.emit('open', { path: this.path, baud: this.baud });
  }

  async _configure() {
    // stty -F <dev> 是 Linux 专有写法，比 `stty -f`（BSD/macOS）更稳
    const args = [
      '-F', this.path,
      String(this.baud),
      'cs' + this.dataBits,
      this.stopBits === 2 ? 'cstopb' : '-cstopb',
      'raw',
      '-echo', '-echoe', '-echok',
      '-parenb',
      '-crtscts',
      'ignbrk', '-icrnl', '-inlcr', '-ixon', '-ixoff',
      'clocal', 'min', '0', 'time', '10',
    ];
    if (this.parity === 'even' || this.parity === 'odd') {
      // stty 的奇偶校验必须先清 -parenb 再置 parenb，否则后写的会覆盖前者
      args.splice(4, 0, '-parenb', 'parenb', this.parity === 'odd' ? 'oddone' : 'even');
    }
    if (this.rtscts) {
      // 同理：crtscts 要覆盖前面的 -crtscts，放到参数末尾即可生效
      args.push('crtscts');
    }
    try {
      await execFileAsync('stty', args);
    } catch (err) {
      throw biErr(`stty 配置失败（${this.path}）：${err.message}`,
        `stty configuration failed (${this.path}): ${err.message}`);
    }
  }

  _startRx() {
    // 用 FileHandle 的 read 循环。串口在无数据时返回 EAGAIN，属正常情况，
    // 不能当错误——等一小会儿再读即可。busy 轮询比流更实时，且不会丢首包。
    const buf = Buffer.alloc(1024);
    const loop = async () => {
      while (this.open) {
        try {
          const { bytesRead } = await this.fd.read(buf, 0, buf.length, null);
          if (bytesRead > 0) {
            const chunk = buf.toString('utf8', 0, bytesRead);
            this._pending += chunk;
            this.emit('data', chunk);
            if (this._pending.length > 8192) this._pending = this._pending.slice(-4096);
          }
        } catch (err) {
          if (!this.open) break;
          if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
            await new Promise((r) => setTimeout(r, 4));
            continue;
          }
          this.emit('error', err);
          break;
        }
      }
    };
    loop();
  }

  async write(data) {
    if (!this.open || !this.fd) throw biErr('串口未连接', 'Serial port not connected');
    const buf = typeof data === 'string' ? Buffer.from(data, 'ascii') : data;
    // 写入必须走 FileHandle.write（this.fd.write）。
    // 早期这里写的是 `const { write } = await import('node:fs/promises')`，
    // 但 node:fs/promises 根本没有 write 导出（只有 open），
    // 解构出来是 undefined，调用即报 "write is not a function"。
    // 而连接是成功的，所以表现为「显示已连接、一开始刻就失败」，很像连接问题。
    let written = 0;
    while (written < buf.length) {
      const r = await this.fd.write(buf, written, buf.length - written);
      written += r.bytesWritten;
    }
    return written;
  }

  async disconnect() {
    this.open = false;
    if (this.fd) {
      try { await this.fd.close(); } catch { /* 已关闭 */ }
      this.fd = null;
    }
    this.emit('close');
  }
}

/**
 * TCP 传输：部分刻字机控制板自带网口（多为一根线直接接交换机）。
 * 协议与串口完全相同，只是换成 socket。
 */
export class TcpTransport extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host;
    this.port = opts.port || 9100;
    this.socket = null;
    this.open = false;
  }

  async connect() {
    const net = await import('node:net');
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port }, () => {
        this.open = true;
        this.emit('open', { host: this.host, port: this.port });
        resolve();
      });
      s.setNoDelay(true);
      s.on('data', (d) => this.emit('data', d.toString('ascii')));
      s.on('error', (err) => {
        if (!this.open) reject(err);
        else this.emit('error', err);
      });
      s.on('close', () => { this.open = false; this.emit('close'); });
      this.socket = s;
      setTimeout(() => {
        if (!this.open) { s.destroy(); reject(biErr('TCP 连接超时', 'TCP connection timed out')); }
      }, 8000);
    });
  }

  async write(data) {
    if (!this.open || !this.socket) throw biErr('TCP 未连接', 'TCP not connected');
    return new Promise((resolve, reject) => {
      this.socket.write(Buffer.from(data, 'ascii'), (err) => (err ? reject(err) : resolve(data.length)));
    });
  }

  async disconnect() {
    this.open = false;
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    this.emit('close');
  }
}

/** 空传输：不接机器，只做生成与模拟。上机前调刀路用这个 */
export class NullTransport extends EventEmitter {
  constructor() { super(); this.open = true; this.written = ''; }
  async connect() { this.emit('open', { mode: 'null' }); }
  async write(data) { this.written += data; return data.length; }
  async disconnect() { this.open = false; this.emit('close'); }
}

/**
 * 虚拟刻字机：在内存里模拟一台机器的响应。
 * 没有硬件时也能跑通整条链路（连同暂停、进度、限速），是做端到端自测的基础。
 */
export class VirtualPlotter extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.width = opts.width || 630;
    this.height = opts.height || 710;
    this.spi = opts.stepsPerInch || 1000;
    this.firmware = opts.firmware || 'grbl-like';
    this.open = true;
    this.pos = { x: 0, y: 0 };
    this.penDown = false;
    this.running = false;
    this._scale = this.spi / 25.4;
    // 力宇等 2D 刻字机对 IN; 返回版本行；GRBL 返回欢迎信息
    this._banner = this.firmware === 'grbl'
      ? '\r\nGrbl 1.1h [\'$ for help\']\r\n'
      : 'LIYU-PLOTTER READY\r\n';
  }

  async connect() {
    this.emit('open', { mode: 'virtual', banner: this._banner });
    setTimeout(() => this.emit('data', this._banner), 30);
  }

  async write(data) {
    if (!this.open) throw biErr('虚拟机未连接', 'Virtual plotter not connected');
    const text = typeof data === 'string' ? data : data.toString('ascii');
    this.emit('tx', text);
    // 异步回包，模拟真实设备延迟
    setTimeout(() => this._process(text), 4);
    return data.length;
  }

  _process(text) {
    const cmds = text.split(';').map((s) => s.trim()).filter(Boolean);
    for (const c of cmds) {
      const t = c.replace(/^;/, '');
      if (!t) continue;
      if (t === 'IN') {
        this.pos = { x: 0, y: 0 };
        this.emit('data', 'OK\n');
        continue;
      }
      let m;
      if ((m = t.match(/^PA(-?\d+),(-?\d+)$/))) {
        this.pos = { x: +m[1] / this._scale, y: +m[2] / this._scale };
      } else if ((m = t.match(/^PD(?:(-?\d+),(-?\d+))?$/))) {
        this.penDown = true;
        if (m[1] !== undefined) this.pos = { x: +m[1] / this._scale, y: +m[2] / this._scale };
        this.emit('status', { pos: this.pos, penDown: true });
      } else if ((m = t.match(/^PU(?:(-?\d+),(-?\d+))?$/))) {
        this.penDown = false;
        if (m[1] !== undefined) this.pos = { x: +m[1] / this._scale, y: +m[2] / this._scale };
        this.emit('status', { pos: this.pos, penDown: false });
      } else if ((m = t.match(/^AA(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/))) {
        const cx = +m[1] / this._scale, cy = +m[2] / this._scale;
        const a0 = +m[3], a1 = +m[4];
        this.pos = { x: cx, y: cy };
        this.emit('arc', { cx, cy, r: 0, a0, a1 });
      } else if (t.startsWith('SC')) {
        this._scale = this.spi / 25.4;
      } else if (t.startsWith('VS') || t.startsWith('LT') || t.startsWith('SP') || t.startsWith('IN')) {
        this.emit('data', 'ok\n');
      }
    }
  }

  async disconnect() { this.open = false; this.emit('close'); }
}

/** 按配置创建传输实例 */
export function createTransport(cfg) {
  switch (cfg.type) {
    case 'serial': return new SerialTransport(cfg);
    case 'tcp': return new TcpTransport(cfg);
    case 'virtual': return new VirtualPlotter(cfg);
    default: return new NullTransport();
  }
}
