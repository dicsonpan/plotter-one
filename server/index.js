/**
 * 刻字机 Web 控制服务 —— 主入口。
 *
 * 一台 RK3399（Armbian）上跑着，插 USB 转串口线连刻字机，
 * 同一局域网内任何设备用浏览器打开就能用：Windows、Mac、iPad、安卓手机、
 * 甚至没装任何东西的瘦客户端。
 *
 * 启动：node server/index.js [--port 8080] [--host 0.0.0.0]
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

import { sendJson, readBody, tokenEquals, serveStatic, WebSocketServer, DATA_ROOT, WEB_ROOT } from './api/httpKit.js';
import { SerialTransport, TcpTransport, VirtualPlotter, NullTransport, createTransport } from './machine/transport.js';
import { JobEngine, JobState } from './machine/jobEngine.js';
import { MACHINE_PRESETS, MATERIAL_PRESETS, compileToPlotterLanguage, HpglBuilder } from './machine/hpgl.js';
import { buildManualCommand } from './machine/manual.js';
import { buildCalibrationStep, CALIBRATION_STEPS } from './machine/calibrate.js';
import { compileToolpath, analyze, estimateTime, Direction } from './cam/toolpath.js';
import { parseDxf } from './import/dxf.js';
import { parseSvg, parseSvgPath } from './import/svg.js';
import { parseHpgl } from './import/hpglReader.js';
import { textToPath } from './cam/textToPath.js';
import { pathBBox, pathLength, applyMatrixToPath, makePath, polylineToPath, matrixTranslate, matrixScale, matrixRotate, makeSubpath, addLine, circleToPath, ellipseToPath } from './geom/path.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// 配置与状态
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(argVal('--port', process.env.PORT || '8080'), 10);
const HOST = argVal('--host', '0.0.0.0');
const CONFIG_PATH = resolve(DATA_ROOT, 'config.json');

const DEFAULT_CONFIG = {
  machineId: 'liyue-sc630',
  serial: { type: 'serial', path: '', baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
  lastMaterial: 'ivory-board',
  originMode: 'user',
  defaultSpeed: 30,
  defaultForce: 250,
  direction: Direction.CCW,
  optimize: true,
};

let config = { ...DEFAULT_CONFIG };
async function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
      config = { ...DEFAULT_CONFIG, ...raw };
    }
  } catch (err) {
    console.error('配置读取失败，使用默认配置：', err.message);
  }
  if (!config.token) config.token = randomBytes(16).toString('hex');
}
async function saveConfig() {
  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

await loadConfig();

let transport = new NullTransport();
let connected = false;
let deviceInfo = null;

/** 手动指令的中文名，用于任务列表与日志显示 */
const MANUAL_LABELS = {
  move: '移动', home: '回原点', penup: '抬刀', pendown: '落刀',
  setorigin: '设原点', feed: '进纸', eject: '出纸',
  stop: '停止', pause: '暂停', end: '结束',
};

const engine = new JobEngine(transport);
const wss = new WebSocketServer();

function getPreset(id) {
  return MACHINE_PRESETS[id] || MACHINE_PRESETS[config.machineId] || MACHINE_PRESETS['liyue-sc630'];
}

function broadcast(type, payload) {
  wss.broadcast({ type, payload, t: Date.now() });
}

engine.on('state', (s) => broadcast('job:state', s));
engine.on('progress', (p) => broadcast('job:progress', p));
engine.on('log', (l) => broadcast('job:log', l));
engine.on('queue', (q) => broadcast('job:queue', q));
engine.on('jobdone', (j) => broadcast('job:done', j));

function attachTransport(t) {
  transport = t;
  engine.transport = t;
  t.on('data', (d) => broadcast('device:data', { data: String(d).slice(0, 400) }));
  t.on('status', (s) => broadcast('device:status', s));
  t.on('error', (e) => broadcast('device:error', { message: e.message }));
  t.on('close', () => { connected = false; broadcast('device:closed', {}); });
}

function fullState() {
  const preset = getPreset(config.machineId);
  return {
    config,
    preset,
    presets: MACHINE_PRESETS,
    materials: MATERIAL_PRESETS,
    device: { connected, info: deviceInfo, type: transport.constructor.name },
    job: { state: engine.state, queue: engine.list(), log: engine.log.slice(-50) },
    server: { hostname: os.hostname(), port: PORT, version: '1.0.0' },
  };
}

// ---------------------------------------------------------------------------
// 导入处理
// ---------------------------------------------------------------------------

function importVector(text, filename) {
  const lower = (filename || '').toLowerCase();
  const warnings = [];
  let path;
  if (lower.endsWith('.dxf')) {
    const r = parseDxf(text);
    path = r.path; warnings.push(...r.warnings);
  } else if (lower.endsWith('.svg')) {
    const r = parseSvg(text);
    path = r.path; warnings.push(...r.warnings);
  } else if (/\.(plt|hgl|hpgl|camm|dmpl)$/.test(lower)) {
    const r = parseHpgl(text, { stepsPerInch: getPreset(config.machineId).stepsPerInch });
    path = r.path; warnings.push(...r.warnings);
  } else {
    // 猜：DXF 以 0\nSECTION 开头，SVG 以 < 开头，HPGL 以 IN; 开头
    if (/^\s*0\s*[\r\n]+\s*SECTION/.test(text)) { path = parseDxf(text).path; }
    else if (/^\s*</.test(text)) { path = parseSvg(text).path; }
    else { path = parseHpgl(text, { stepsPerInch: getPreset(config.machineId).stepsPerInch }).path; }
  }
  return { path, warnings };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/state': async (req, res) => sendJson(res, 200, fullState()),

  'GET /api/serial-ports': async (req, res) => {
    const list = await SerialTransport.list();
    const detailed = await Promise.all(list.map((p) => SerialTransport.describe(p)));
    sendJson(res, 200, { ports: detailed });
  },

  'POST /api/connect': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const type = body.type || 'serial';
    try {
      let t;
      if (type === 'serial') {
        if (!body.path) return sendJson(res, 400, { error: '缺少串口路径' });
        t = new SerialTransport({
          path: body.path,
          baud: +(body.baud || 9600),
          dataBits: +(body.dataBits || 8),
          stopBits: +(body.stopBits || 1),
          parity: body.parity || 'none',
          rtscts: !!body.rtscts,
        });
        await t.connect();
        deviceInfo = await SerialTransport.describe(body.path);
      } else if (type === 'tcp') {
        t = new TcpTransport({ host: body.host, port: +(body.port || 9100) });
        await t.connect();
        deviceInfo = { path: `${body.host}:${body.port}` };
      } else if (type === 'virtual') {
        t = new VirtualPlotter({ width: getPreset(config.machineId).width, stepsPerInch: getPreset(config.machineId).stepsPerInch });
        await t.connect();
        deviceInfo = { path: '内置虚拟刻字机（不驱动真实硬件）' };
      } else {
        return sendJson(res, 400, { error: '未知连接类型' });
      }
      attachTransport(t);
      connected = true;
      if (type === 'serial') {
        config.serial = { ...config.serial, ...body };
        await saveConfig();
      }
      broadcast('device:connected', { connected: true, info: deviceInfo });
      sendJson(res, 200, { ok: true, device: deviceInfo });
    } catch (err) {
      connected = false;
      sendJson(res, 400, { error: err.message });
    }
  },

  'POST /api/disconnect': async (req, res) => {
    try { await transport.disconnect(); } catch { /* 已断开 */ }
    connected = false;
    deviceInfo = null;
    attachTransport(new NullTransport());
    sendJson(res, 200, { ok: true });
  },

  'POST /api/config': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    config = { ...config, ...body };
    await saveConfig();
    broadcast('config:updated', config);
    sendJson(res, 200, { ok: true, config });
  },

  'POST /api/import': async (req, res) => {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      // 直接传文件内容
      const filename = req.headers['x-filename'] || 'unknown.dxf';
      const text = raw.toString('utf8');
      const { path, warnings } = importVector(text, filename);
      const preset = getPreset(config.machineId);
      const info = analyze(path, preset);
      return sendJson(res, 200, {
        path: pathToClient(path), info, warnings, preset: preset.id,
      });
    }
    const { path, warnings } = importVector(body.content || '', body.filename || '');
    const preset = getPreset(config.machineId);
    const info = analyze(path, preset);
    sendJson(res, 200, { path: pathToClient(path), info, warnings, preset: preset.id });
  },

  'POST /api/geometry': async (req, res) => {
    // 轻量设计：前端构造几何，交给服务端统一处理
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const path = buildGeometry(body.items || []);
    const preset = getPreset(config.machineId);
    const info = analyze(path, preset);
    sendJson(res, 200, { path: pathToClient(path), info });
  },

  'POST /api/text-to-path': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    try {
      const path = textToPath({
        text: body.text || '',
        font: body.font || 'sans',
        sizeMm: +(body.sizeMm || 20),
        letterSpacing: +(body.letterSpacing || 0),
        singleLine: !!body.singleLine,
        x: +(body.x || 0), y: +(body.y || 0),
        rotation: +(body.rotation || 0),
      });
      const preset = getPreset(config.machineId);
      const info = analyze(path, preset);
      sendJson(res, 200, { path: pathToClient(path), info });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  },

  'POST /api/compile': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const preset = getPreset(body.machineId || config.machineId);
    const items = body.items || [];
    if (!items.length) return sendJson(res, 400, { error: '没有可输出的内容' });

    // 1. 合并所有几何
    const merged = makePath();
    const warnings = [];
    for (const it of items) {
      if (it.hidden) continue;
      if (it.kind === 'import') {
        const { path: p, warnings: w } = importVector(it.content || '', it.filename || '');
        warnings.push(...w);
        for (const s of p.subpaths) merged.subpaths.push(s);
      } else if (it.path) {
        for (const s of it.path.subpaths || []) merged.subpaths.push(s);
      }
    }
    if (!merged.subpaths.length) return sendJson(res, 400, { error: '合并后没有有效路径' });

    // 2. 施加每个对象的变换（前端已算好，这里用矩阵）
    //    若前端传的是已变换坐标则忽略；统一约定传 path + matrix
    for (const it of items) {
      if (it.hidden || !it.path || !it.matrix) continue;
      const m = it.matrix;
      applyMatrixToPath(it.path, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f });
    }

    // 3. CAM：清理、方向、排序
    const compiled = compileToolpath(merged, preset, {
      direction: body.direction || config.direction,
      optimize: body.optimize !== undefined ? body.optimize : config.optimize,
    });
    warnings.push(...compiled.warnings);

    // 4. 生成指令
    const speed = +(body.speed || config.defaultSpeed);
    const force = +(body.force || config.defaultForce);
    const result = compileToPlotterLanguage(compiled.path, preset, {
      speedMmPerSec: speed,
      force,
      origin: body.origin || { x: 0, y: 0 },
    });

    const time = estimateTime(compiled.path, speed);
    const timeText = result.text;
    const transferSec = (timeText.length / 100) / 0.88;

    sendJson(res, 200, {
      gcode: timeText,
      bytes: result.bytes,
      commandCount: result.commandCount,
      info: compiled.info,
      warnings,
      preset: { id: preset.id, name: preset.name, width: preset.width, height: preset.height },
      estimate: {
        ...time,
        totalSeconds: time.totalSeconds,
        transferSeconds: transferSec,
        // 实际耗时取「刻绘」与「传输」的较大者——两者并行发生
        wallSeconds: Math.max(time.totalSeconds, transferSec),
      },
    });
  },

  /**
   * 手动控制：移动刀头、抬落刀、回原点、设原点、进纸出纸。
   *
   * 走任务队列而不是直接写串口，原因有三：
   *  1. 手动操作常和正在跑的刻字任务冲突，排队能天然避开并发写串口
   *  2. 界面能拿到进度与日志，操作结果可追溯
   *  3. 急停对手动指令同样有效——这是安全底线，不能有绕过急停的路径
   */
  /**
   * 原点校准：只抬刀、每次只走 5mm，用来确认 X/Y 的真实方向。
   * 方向错会撞机，所以必须能安全地试——这正是这个接口存在的意义。
   */
  'POST /api/calibrate': async (req, res) => {
    if (!connected) return sendJson(res, 400, { error: '设备未连接' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const preset = getPreset(config.machineId);
    const dir = body.dir;
    if (!['x+', 'x-', 'y+', 'y-'].includes(dir)) {
      return sendJson(res, 400, { error: 'dir 必须是 x+/x-/y+/y-' });
    }

    const text = buildCalibrationStep(preset, {
      dir,
      axisX: config.axisX !== undefined ? config.axisX : (preset.axisX ?? 1),
      axisY: config.axisY !== undefined ? config.axisY : (preset.axisY ?? 1),
    });
    const id = engine.enqueue({
      name: `校准·${dir}`,
      text,
      baud: preset.serialDefault.baud,
      priority: true,
      meta: { bytes: text.length, manual: true, calibration: true },
    });
    engine.run();
    const step = CALIBRATION_STEPS.find((s) => s.dir === dir);
    sendJson(res, 200, { ok: true, jobId: id, gcode: text, ask: step?.ask || '' });
  },

  'POST /api/manual': async (req, res) => {
    if (!connected) return sendJson(res, 400, { error: '设备未连接' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.action) return sendJson(res, 400, { error: '缺少 action' });

    const preset = getPreset(config.machineId);
    let built;
    try {
      built = buildManualCommand(preset, body);
    } catch (err) {
      return sendJson(res, 400, { error: '指令生成失败：' + err.message });
    }
    if (!built.text) return sendJson(res, 400, { error: '未生成任何指令' });

    // 每条手动指令都短小，直接插队但仍走引擎，保证限速与急停有效
    const id = engine.enqueue({
      name: `手动·${MANUAL_LABELS[body.action] || body.action}`,
      text: built.text,
      baud: preset.serialDefault.baud,
      priority: true,
      meta: { bytes: built.text.length, manual: true },
    });
    if (body.runNow !== false) engine.run();
    sendJson(res, 200, { ok: true, jobId: id, notes: built.notes, gcode: built.text });
  },

  'POST /api/send': async (req, res) => {
    if (!connected) return sendJson(res, 400, { error: '设备未连接' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.gcode) return sendJson(res, 400, { error: '没有指令内容' });
    const preset = getPreset(config.machineId);
    const id = engine.enqueue({
      name: body.name || `任务 ${new Date().toLocaleTimeString('zh-CN')}`,
      text: body.gcode,
      baud: preset.serialDefault.baud,
      meta: { bytes: body.gcode.length },
    });
    engine.run();
    sendJson(res, 200, { ok: true, jobId: id });
  },

  'POST /api/job/pause': async (req, res) => { engine.pause(); sendJson(res, 200, { ok: true, state: engine.state }); },
  'POST /api/job/resume': async (req, res) => { engine.resume(); sendJson(res, 200, { ok: true, state: engine.state }); },
  'POST /api/job/stop': async (req, res) => { engine.stop(); sendJson(res, 200, { ok: true }); },
  'POST /api/job/estop': async (req, res) => { engine.emergencyStop(); sendJson(res, 200, { ok: true }); },
  'POST /api/job/clear': async (req, res) => { engine.clearFinished(); sendJson(res, 200, { ok: true }); },

  'GET /api/preview': async (req, res, url) => {
    // 回显自检：把自己生成的 HPGL 读回来，验证解析器与生成器一致
    const q = url.searchParams.get('gcode');
    if (!q) return sendJson(res, 400, { error: '缺少 gcode 参数' });
    const preset = getPreset(config.machineId);
    const r = parseHpgl(q, { stepsPerInch: preset.stepsPerInch });
    sendJson(res, 200, { path: pathToClient(r.path), stats: r.stats, warnings: r.warnings });
  },
};

function pathToClient(path) {
  // 圆弧/椭圆在 JSON 里原样传输即可，前端用同一套渲染
  return JSON.parse(JSON.stringify(path));
}

function buildGeometry(items) {
  const p = makePath();
  for (const it of items) {
    let g = null;
    if (it.type === 'line') {
      g = makePath();
      const s = makeSubpath(it.x1, it.y1);
      addLine(s, it.x2, it.y2);
      g.subpaths.push(s);
    } else if (it.type === 'rect') {
      g = makePath();
      const s = makeSubpath(it.x, it.y);
      addLine(s, it.x + it.w, it.y);
      addLine(s, it.x + it.w, it.y + it.h);
      addLine(s, it.x, it.y + it.h);
      s.closed = true;
      g.subpaths.push(s);
    } else if (it.type === 'circle') {
      g = circleToPath(it.x, it.y, it.r);
    } else if (it.type === 'ellipse') {
      g = ellipseToPath(it.x, it.y, it.rx, it.ry);
    } else if (it.type === 'polyline') {
      g = polylineToPath(it.points || [], !!it.closed);
    }
    if (g) {
      if (it.rotation) {
        const m = matrixMultiplySafe(
          matrixTranslate(it.x || 0, it.y || 0),
          matrixRotate(it.rotation || 0),
          matrixScale(it.scale || 1, it.scale || 1)
        );
        applyMatrixToPath(g, m);
      }
      for (const s of g.subpaths) p.subpaths.push(s);
    }
  }
  return p;
}

function matrixMultiplySafe(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  // 允许局域网跨域调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (routes[key]) {
    try {
      await routes[key](req, res, url);
    } catch (err) {
      console.error(`[${key}]`, err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: '接口不存在' });
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head);
});

// 新客户端接入：推一次全量状态
const origHandle = wss.handleUpgrade.bind(wss);
wss.handleUpgrade = (req, socket, head) => {
  origHandle(req, socket, head);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(JSON.stringify({ type: 'state:sync', payload: fullState(), t: Date.now() }));
  }
};

server.listen(PORT, HOST, () => {
  const ip = localIP();
  console.log('');
  console.log('  刻字机 Web 控制服务已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  本机访问：http://localhost:${PORT}`);
  console.log(`  局域网访问：http://${ip}:${PORT}`);
  console.log(`  根目录：${WEB_ROOT}`);
  console.log(`  当前机器：${getPreset(config.machineId).name}`);
  console.log('  ─────────────────────────────────────────');
  console.log('  手机连同一个 Wi-Fi，浏览器直接输上面的局域网地址即可');
  console.log('');
});

function localIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

void createTransport; void TcpTransport; void HpglBuilder; void pathBBox; void pathLength; void parseSvgPath; void JobState;
