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
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

import { sendJson, readBody, tokenEquals, serveStatic, WebSocketServer, DATA_ROOT, WEB_ROOT } from './api/httpKit.js';
import { SerialTransport, TcpTransport, VirtualPlotter, NullTransport, createTransport } from './machine/transport.js';
import { JobEngine, JobState } from './machine/jobEngine.js';
import { MACHINE_PRESETS, MATERIAL_PRESETS, ORIGIN_POSITIONS, getOriginCorner, compileToPlotterLanguage, buildFrameCommand, HpglBuilder } from './machine/hpgl.js';
import { buildManualCommand } from './machine/manual.js';
import { getDialect } from './machine/dialects.js';
import { compileToolpath, analyze, estimateTime, Direction } from './cam/toolpath.js';
import { parseDxf } from './import/dxf.js';
import { parseSvg, parseSvgPath } from './import/svg.js';
import { parseHpgl } from './import/hpglReader.js';
import { textToPath } from './cam/textToPath.js';
import { pathBBox, pathLength, applyMatrixToPath, mapPathPoints, makePath, polylineToPath, matrixTranslate, matrixScale, matrixRotate, makeSubpath, addLine, circleToPath, ellipseToPath } from './geom/path.js';

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

/**
 * 手动控制的「当前刀头绝对坐标」缓存（机器单位，按 machineId 分）。
 * 只有不支持 PR/IP 的流式方言（skm）需要：它没有相对移动指令，
 * 必须由上位机累加坐标。换机型或服务重启后归零（拿不到机器真实位置，
 * 界面应提示重新对刀），所以只在内存里、不写 config.json。
 */
const manualPositions = new Map();

const DEFAULT_CONFIG = {
  machineId: 'liyue-sc630',
  serial: { type: 'serial', path: '/dev/ttyACM0', baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
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

const HISTORY_PATH = resolve(DATA_ROOT, 'history.json');
let historyList = [];

async function loadHistory() {
  try {
    if (existsSync(HISTORY_PATH)) {
      historyList = JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
      if (!Array.isArray(historyList)) historyList = [];
    }
  } catch (err) {
    console.error('历史记录读取失败，重置为空：', err.message);
    historyList = [];
  }
}

async function saveHistory() {
  await mkdir(DATA_ROOT, { recursive: true });
  if (historyList.length > 100) historyList = historyList.slice(0, 100);
  await writeFile(HISTORY_PATH, JSON.stringify(historyList, null, 2));
}

await loadHistory();

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

/**
 * 当前生效的机器朝向与原点方位配置。
 *
 * 原点位置（originPosition）默认取机型预设（如力宇滚筒机均为 'bottom-right' 右下角），
 * 也支持用户在界面中针对不同机器切换原点位置（右下/左下/右上/左上），并联动推导版面旋转角。
 */
function axisOptions(presetOverride) {
  const preset = presetOverride || getPreset(config.machineId);
  const originPosition = (config.originPosition && ORIGIN_POSITIONS[config.originPosition])
    ? config.originPosition
    : (preset.originPosition || 'bottom-right');
  const layoutRotate = ORIGIN_POSITIONS[originPosition]
    ? ORIGIN_POSITIONS[originPosition].rotate
    : (preset.layoutRotate ?? 0);
  return {
    originPosition,
    axisX: preset.axisX ?? 1,
    axisY: preset.axisY ?? 1,
    swapAxes: !!preset.swapAxes,
    layoutRotate,
  };
}

function broadcast(type, payload) {
  wss.broadcast({ type, payload, t: Date.now() });
}

/**
 * 连接后的链路探测（2026-10-19 实测驱动的加固）。
 */
async function probeLink(t, preset = getPreset(config.machineId)) {
  const dialect = getDialect(preset.dialect);
  // skm 这类纯单工被动机型不认 IN;，发了只会往机载缓冲里塞脏字节。
  // 直接判为单工链路（完成状态按运动学仿真推算，日志会提示目视确认）。
  if (!dialect.probeCommand) {
    console.log('  · 链路探测：跳过（该机型为纯单工被动型，无查询指令）');
    return true;
  }
  await t.write(dialect.probeCommand);
  await new Promise((r) => setTimeout(r, 300));
  const silent = t.everRx === false;
  if (t instanceof SerialTransport || t instanceof TcpTransport) {
    if (silent) {
      console.log('  · 链路探测：机器无应答（单向链路，完成状态将按仿真推算）');
    } else {
      console.log('  · 链路探测：收到机器应答（双向链路）');
    }
  }
  return silent;
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
  t.on('error', (e) => {
    broadcast('device:error', { message: e.message });
    if (!t.open) {
      connected = false;
      deviceInfo = null;
      broadcast('device:closed', {});
      startReconnectLoop();
    }
  });
  t.on('close', () => {
    connected = false;
    deviceInfo = null;
    broadcast('device:closed', {});
    startReconnectLoop();
  });
}

// ---------------------------------------------------------------------------
// 自动重连
// ---------------------------------------------------------------------------
const RECONNECT_INTERVAL_MS = 3000;
let reconnectTimer = null;
let lastConnected = null;

async function currentSerialCandidates() {
  const list = await SerialTransport.list();
  list.sort((a, b) => {
    const aAcm = a.includes('ttyACM') ? 0 : 1;
    const bAcm = b.includes('ttyACM') ? 0 : 1;
    return aAcm - bAcm;
  });
  const saved = config.serial?.path;
  const out = [];
  if (saved && list.includes(saved)) out.push(saved);
  for (const p of list) if (!out.includes(p)) out.push(p);
  return out;
}

async function tryReconnect() {
  if (connected && transport && transport.open) return true;
  connected = false;

  const list = await SerialTransport.list();
  if (!list.length) return false;
  if (list.length > 1) return false;

  const candidates = await currentSerialCandidates();
  for (const path of candidates) {
    try {
      const baud = +(config.serial?.baud || 115200);
      const t = new SerialTransport({
        path,
        baud,
        dataBits: +(config.serial?.dataBits || 8),
        stopBits: +(config.serial?.stopBits || 1),
        parity: config.serial?.parity || 'none',
        rtscts: !!config.serial?.rtscts,
      });
      await t.connect();
      let silent = false;
      try {
        silent = await probeLink(t, getPreset(config.machineId));
      } catch (probeErr) {
        try { await t.disconnect(); } catch { /* 忽略 */ }
        continue;
      }
      attachTransport(t);
      connected = true;
      deviceInfo = await SerialTransport.describe(path);
      if (deviceInfo) deviceInfo.silent = silent;
      if (config.serial?.path !== path || config.serial?.baud !== baud) {
        config.serial = { ...config.serial, path, baud };
        await saveConfig();
      }
      console.log(`  ✓ 检测到唯一串口设备，已自动连接 ${path} ${baud}`);
      broadcast('device:connected', { connected: true, info: deviceInfo });
      return true;
    } catch {
      // 这个口连不上就试下一个，不刷日志
    }
  }
  return false;
}

function startReconnectLoop() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (shuttingDown) return;
    if (connected) {
      if (!transport || !transport.open) {
        connected = false;
        deviceInfo = null;
        broadcast('device:closed', {});
      } else if (transport instanceof SerialTransport && transport.path) {
        try {
          await access(transport.path);
        } catch {
          console.log(`  ! 串口设备 ${transport.path} 离线，标记断开`);
          try { await transport.disconnect(); } catch {}
          connected = false;
          deviceInfo = null;
          broadcast('device:closed', {});
        }
      }
    }
    const ok = await tryReconnect();
    if (ok !== lastConnected) {
      lastConnected = ok;
      if (!ok) broadcast('device:closed', {});
    }
  }, RECONNECT_INTERVAL_MS);
  if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
}

let shuttingDown = false;
function stopReconnectLoop() {
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
}

function fullState() {
  const preset = getPreset(config.machineId);
  const ax = axisOptions(preset);
  return {
    config: { ...config, originPosition: ax.originPosition },
    preset: { ...preset, originPosition: ax.originPosition, layoutRotate: ax.layoutRotate },
    presets: MACHINE_PRESETS,
    originPositions: ORIGIN_POSITIONS,
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
  let elements = null;
  if (lower.endsWith('.dxf')) {
    const r = parseDxf(text);
    path = r.path; warnings.push(...r.warnings);
  } else if (lower.endsWith('.svg')) {
    const r = parseSvg(text);
    path = r.path; elements = r.elements; warnings.push(...r.warnings);
  } else if (/\.(plt|hgl|hpgl|camm|dmpl)$/.test(lower)) {
    const r = parseHpgl(text, { stepsPerInch: getPreset(config.machineId).stepsPerInch });
    path = r.path; warnings.push(...r.warnings);
  } else {
    if (/^\s*0\s*[\r\n]+\s*SECTION/.test(text)) { path = parseDxf(text).path; }
    else if (/^\s*</.test(text)) {
      const r = parseSvg(text);
      path = r.path; elements = r.elements; warnings.push(...r.warnings);
    }
    else { path = parseHpgl(text, { stepsPerInch: getPreset(config.machineId).stepsPerInch }).path; }
  }
  return { path, elements, warnings };
}

/** 合并请求中的图层列表为单一路径 */
function mergeItemsToPath(items) {
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
    } else if (it.subpaths) {
      for (const s of it.subpaths || []) merged.subpaths.push(s);
    }
  }
  for (const it of items) {
    if (it.hidden || !it.path || !it.matrix) continue;
    const m = it.matrix;
    applyMatrixToPath(it.path, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f });
  }
  return { merged, warnings };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/state': async (req, res) => sendJson(res, 200, fullState()),

  'GET /api/serial-ports': async (req, res) => {
    const list = await SerialTransport.list();
    const detailed = await Promise.all(list.map((p) => SerialTransport.describe(p)));
    sendJson(res, 200, {
      ports: detailed,
      count: detailed.length,
      multiple: detailed.length > 1,
    });
  },

  'POST /api/connect': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const type = body.type || 'serial';
    try {
      let t;
      if (type === 'serial') {
        if (!body.path) return sendJson(res, 400, err('缺少串口路径', 'Missing serial port path'));
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
        const vp = getPreset(config.machineId);
        t = new VirtualPlotter({ width: vp.width, stepsPerInch: vp.stepsPerInch, dialect: vp.dialect });
        await t.connect();
        deviceInfo = { path: '内置虚拟刻字机（不驱动真实硬件）', pathEn: 'Built-in virtual plotter (no real hardware)' };
      } else {
        return sendJson(res, 400, err('未知连接类型', 'Unknown connection type'));
      }
      let silent = false;
      if (type === 'serial' || type === 'tcp') {
        try {
          silent = await probeLink(t, getPreset(config.machineId));
        } catch (probeErr) {
          try { await t.disconnect(); } catch { /* 忽略 */ }
          return sendJson(res, 400, err(
            '端口已打开但机器不应答：' + probeErr.message,
            'Port opened but machine not responding: ' + (probeErr.errorEn || probeErr.message)));
        }
      }
      attachTransport(t);
      connected = true;
      if (deviceInfo) deviceInfo.silent = silent;
      stopReconnectLoop();
      setTimeout(() => { if (!shuttingDown) startReconnectLoop(); }, 1000);
      if (type === 'serial') {
        config.serial = { ...config.serial, ...body };
        await saveConfig();
      }
      broadcast('device:connected', { connected: true, info: deviceInfo });
      sendJson(res, 200, { ok: true, device: deviceInfo });
    } catch (e) {
      connected = false;
      sendJson(res, 400, err(e.message, e.errorEn));
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
    // 换机器后旧机型累加出来的刀头坐标不可信，必须丢弃重新对刀
    if (body.machineId && body.machineId !== config.machineId) {
      manualPositions.delete(body.machineId);
    }
    // 当切换机型且未显式指定新的 originPosition 时，自动同步为该机型预设的默认原点位置
    if (body.machineId && body.machineId !== config.machineId && !body.originPosition) {
      const nextPreset = getPreset(body.machineId);
      body.originPosition = nextPreset.originPosition || 'bottom-right';
    }
    config = { ...config, ...body };
    await saveConfig();
    broadcast('config:updated', config);
    sendJson(res, 200, { ok: true, config });
  },

  'GET /api/history': async (req, res, url) => {
    const id = url.searchParams.get('id');
    if (id) {
      const item = historyList.find((h) => h.id === id);
      if (!item) return sendJson(res, 404, err('历史任务不存在', 'Job not found in history'));
      return sendJson(res, 200, item);
    }
    const summary = historyList.map((h) => ({
      id: h.id,
      name: h.name,
      createdAt: h.createdAt,
      machineId: h.machineId,
      materialId: h.materialId,
      speed: h.speed,
      force: h.force,
      direction: h.direction,
      layerCount: h.layers?.length || 0,
      stats: h.stats || {},
      thumbnailSvg: h.thumbnailSvg || null,
    }));
    sendJson(res, 200, { history: summary });
  },

  'POST /api/history': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.layers || !Array.isArray(body.layers)) {
      return sendJson(res, 400, err('缺少图层数据', 'Missing layers data'));
    }
    const entry = {
      id: body.id || 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: body.name || '未命名任务',
      createdAt: body.createdAt || Date.now(),
      layers: body.layers,
      userOrigin: body.userOrigin || { x: 0, y: 0 },
      machineId: body.machineId || config.machineId,
      materialId: body.materialId || config.lastMaterial,
      speed: +(body.speed || config.defaultSpeed || 30),
      force: +(body.force || config.defaultForce || 250),
      direction: body.direction || config.direction || 'ccw',
      optimize: body.optimize !== undefined ? !!body.optimize : !!config.optimize,
      stats: body.stats || {},
      thumbnailSvg: body.thumbnailSvg || null,
    };
    const idx = historyList.findIndex((h) => h.id === entry.id);
    if (idx >= 0) historyList[idx] = entry;
    else historyList.unshift(entry);
    await saveHistory();
    broadcast('history:updated', { count: historyList.length });
    sendJson(res, 200, { ok: true, entry });
  },

  'DELETE /api/history': async (req, res, url) => {
    const id = url.searchParams.get('id');
    if (!id || id === 'all') {
      historyList = [];
    } else {
      historyList = historyList.filter((h) => h.id !== id);
    }
    await saveHistory();
    broadcast('history:updated', { count: historyList.length });
    sendJson(res, 200, { ok: true });
  },

  'POST /api/import': async (req, res) => {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      const filename = req.headers['x-filename'] || 'unknown.dxf';
      const text = raw.toString('utf8');
      const { path, elements, warnings } = importVector(text, filename);
      const preset = getPreset(config.machineId);
      const ax = axisOptions(preset);
      const info = analyze(path, preset, null, ax.originPosition);
      return sendJson(res, 200, {
        path: pathToClient(path),
        elements: elements ? pathToClient(elements) : null,
        info, warnings, preset: preset.id,
      });
    }
    const { path, elements, warnings } = importVector(body.content || '', body.filename || '');
    const preset = getPreset(config.machineId);
    const ax = axisOptions(preset);
    const info = analyze(path, preset, null, ax.originPosition);
    sendJson(res, 200, {
      path: pathToClient(path),
      elements: elements ? pathToClient(elements) : null,
      info, warnings, preset: preset.id,
    });
  },

  'POST /api/geometry': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const path = buildGeometry(body.items || []);
    const preset = getPreset(config.machineId);
    const ax = axisOptions(preset);
    const info = analyze(path, preset, null, ax.originPosition);
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
      const ax = axisOptions(preset);
      const info = analyze(path, preset, null, ax.originPosition);
      sendJson(res, 200, { path: pathToClient(path), info });
    } catch (e) {
      sendJson(res, 400, err(e.message, e.errorEn));
    }
  },

  'POST /api/compile': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const preset = getPreset(body.machineId || config.machineId);
      const ax = axisOptions(preset);
      if (body.originPosition && ORIGIN_POSITIONS[body.originPosition]) {
        ax.originPosition = body.originPosition;
        ax.layoutRotate = ORIGIN_POSITIONS[body.originPosition].rotate;
      }
      const items = body.items || [];
      if (!items.length) return sendJson(res, 400, err('没有可输出的内容', 'Nothing to output'));

      const { merged, warnings } = mergeItemsToPath(items);
      if (!merged.subpaths.length) return sendJson(res, 400, err('合并后没有有效路径', 'No valid path after merging'));

      // CAM：清理、方向、从当前机器原点就近排序
      const origin = body.origin || getOriginCorner(preset, ax.originPosition);
      const compiled = compileToolpath(merged, preset, {
        direction: body.direction || config.direction,
        optimize: body.optimize !== undefined ? body.optimize : config.optimize,
        origin,
        originPosition: ax.originPosition,
      });
      warnings.push(...compiled.warnings);

      // 生成指令
      const speed = +(body.speed || config.defaultSpeed);
      const force = +(body.force || config.defaultForce);
      const result = compileToPlotterLanguage(compiled.path, preset, {
        speedMmPerSec: speed,
        force,
        origin,
        ...ax,
      });

      const baud = +(config.serial?.baud || preset.serialDefault.baud || 9600);
      const time = estimateTime(compiled.path, speed);
      const timeText = result.text;
      const transferSec = (timeText.length / (baud / 10)) / 0.88;

      sendJson(res, 200, {
        gcode: timeText,
        format: result.format || 'lines',
        bytes: result.bytes,
        commandCount: result.commandCount,
        info: compiled.info,
        warnings,
        preset: {
          id: preset.id,
          name: preset.name,
          width: preset.width,
          height: preset.height,
          originPosition: ax.originPosition,
        },
        estimate: {
          ...time,
          totalSeconds: time.totalSeconds,
          transferSeconds: transferSec,
          wallSeconds: Math.max(time.totalSeconds, transferSec),
        },
      });
    } catch (e) {
      console.error('[POST /api/compile] 编译失败：', e);
      sendJson(res, 500, err('刀路生成失败：' + (e.message || '未知错误'), 'Toolpath compile failed: ' + (e.message || 'Unknown error')));
    }
  },

  /**
   * 走框预览（范围巡边）：
   * 在真正落刀刻绘之前，让刀头保持抬刀状态（PU）沿待刻图形的外接矩形走一圈，
   * 让用户在真实机器和材料上直观确认刻字范围是否合适、是否超出材料边界。
   * 若设备已连接且 runNow !== false，立即作为高优任务下发给刻字机执行。
   */
  'POST /api/frame': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const preset = getPreset(body.machineId || config.machineId);
      const ax = axisOptions(preset);
      if (body.originPosition && ORIGIN_POSITIONS[body.originPosition]) {
        ax.originPosition = body.originPosition;
        ax.layoutRotate = ORIGIN_POSITIONS[body.originPosition].rotate;
      }
      const items = body.items || [];
      if (!items.length) return sendJson(res, 400, err('画布为空，没有可走框预览的内容', 'Canvas is empty — nothing to frame'));

      const { merged } = mergeItemsToPath(items);
      if (!merged.subpaths.length) return sendJson(res, 400, err('没有有效图形路径', 'No valid geometry path'));

      const origin = body.origin || getOriginCorner(preset, ax.originPosition);
      const speed = +(body.speed || config.defaultSpeed || 40);
      const built = buildFrameCommand(merged, preset, {
        origin,
        speedMmPerSec: speed,
        ...ax,
      });

      let jobId = null;
      const shouldSend = connected && body.runNow !== false;
      if (shouldSend) {
        const dialect = getDialect(preset.dialect);
        if (!engine.busy && dialect.probeCommand && (transport instanceof SerialTransport || transport instanceof TcpTransport)) {
          try {
            await transport.write(dialect.probeCommand);
          } catch (probeErr) {
            connected = false;
            broadcast('device:closed', {});
            return sendJson(res, 400, err(
              '机器不应答，无法执行走框预览：' + probeErr.message,
              'Machine not responding, frame check blocked: ' + (probeErr.errorEn || probeErr.message)));
          }
        }
        const baud = +(config.serial?.baud || preset.serialDefault.baud || 115200);
        const wStr = built.bbox.w.toFixed(0);
        const hStr = built.bbox.h.toFixed(0);
        jobId = engine.enqueue({
          name: `走框预览 · ${wStr}×${hStr}mm`,
          text: built.text,
          streamFormat: built.format || 'lines',
          baud,
          priority: true,
          speed,
          stepsPerInch: preset.stepsPerInch || 1000,
          meta: { bytes: built.bytes, frame: true },
        });
        engine.run();
      }

      sendJson(res, 200, {
        ok: true,
        sent: shouldSend,
        jobId,
        gcode: built.text,
        bytes: built.bytes,
        commandCount: built.commandCount,
        bbox: built.bbox,
        originBBox: built.originBBox,
        framePath: pathToClient(built.framePath),
        notes: built.notes,
      });
    } catch (e) {
      console.error('[POST /api/frame] 走框预览失败：', e);
      sendJson(res, 400, err('走框预览失败：' + (e.message || '未知错误'), 'Frame check failed: ' + (e.message || 'Unknown error')));
    }
  },

  /**
   * 手动控制：移动刀头、抬落刀、回原点、设原点、进纸出纸。
   */
  'POST /api/manual': async (req, res) => {
    if (!connected) return sendJson(res, 400, err('设备未连接', 'Device not connected'));
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.action) return sendJson(res, 400, err('缺少 action', 'Missing action'));

    const preset = getPreset(config.machineId);
    const manualKey = config.machineId;
    let built;
    try {
      built = buildManualCommand({ ...preset, ...axisOptions(preset) }, body, { pos: manualPositions.get(manualKey) });
    } catch (err) {
      return sendJson(res, 400, err('指令生成失败：' + err.message, 'Command build failed: ' + err.message));
    }
    if (!built.text) return sendJson(res, 400, err('未生成任何指令', 'No commands generated'));
    // 流式方言没有相对移动，把累加后的绝对坐标存好供下一次手动操作使用
    if (built.nextPos) manualPositions.set(manualKey, built.nextPos);

    const baud = +(config.serial?.baud || preset.serialDefault.baud || 9600);
    const id = engine.enqueue({
      name: `手动·${MANUAL_LABELS[body.action] || body.action}`,
      text: built.text,
      streamFormat: built.format || 'lines',
      baud,
      priority: true,
      meta: { bytes: built.text.length, manual: true },
    });
    if (body.runNow !== false) engine.run();
    sendJson(res, 200, { ok: true, jobId: id, notes: built.notes, gcode: built.text });
  },

  'POST /api/send': async (req, res) => {
    if (!connected) return sendJson(res, 400, err('设备未连接', 'Device not connected'));
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.gcode) return sendJson(res, 400, err('没有指令内容', 'No command content'));
    const preset = getPreset(config.machineId);

    const dialect = getDialect(preset.dialect);
    if (!engine.busy && dialect.probeCommand && (transport instanceof SerialTransport || transport instanceof TcpTransport)) {
      try {
        await transport.write(dialect.probeCommand);
      } catch (probeErr) {
        connected = false;
        broadcast('device:closed', {});
        return sendJson(res, 400, err(
          '机器不应答，已阻止本次输出：' + probeErr.message + '。请断电重启刻字机后重试。',
          'Machine not responding, output blocked: ' + (probeErr.errorEn || probeErr.message) + ' Power-cycle the plotter and retry.'));
      }
    }

    const baud = +(config.serial?.baud || preset.serialDefault.baud || 9600);
    const id = engine.enqueue({
      name: body.name || `任务 ${new Date().toLocaleTimeString('zh-CN')}`,
      text: body.gcode,
      streamFormat: dialect.stream ? 'stream' : 'lines',
      baud,
      estimate: body.estimate,
      speed: +(body.speed || config.defaultSpeed || 30),
      stepsPerInch: preset.stepsPerInch || 1000,
      meta: { bytes: body.gcode.length, estimate: body.estimate },
    });

    if (body.archive && Array.isArray(body.archive.layers) && body.archive.layers.length > 0) {
      const arch = body.archive;
      const entry = {
        id: 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: body.name || arch.name || `任务 ${new Date().toLocaleTimeString('zh-CN')}`,
        createdAt: Date.now(),
        layers: arch.layers,
        userOrigin: arch.userOrigin || { x: 0, y: 0 },
        machineId: arch.machineId || config.machineId,
        materialId: arch.materialId || config.lastMaterial,
        speed: +(arch.speed || body.speed || config.defaultSpeed || 30),
        force: +(arch.force || body.force || config.defaultForce || 250),
        direction: arch.direction || config.direction || 'ccw',
        optimize: arch.optimize !== undefined ? !!arch.optimize : !!config.optimize,
        stats: arch.stats || {},
        thumbnailSvg: arch.thumbnailSvg || null,
      };
      historyList.unshift(entry);
      if (historyList.length > 100) historyList = historyList.slice(0, 100);
      saveHistory().catch((e) => console.error('保存历史失败：', e));
      broadcast('history:updated', { count: historyList.length });
    }

    engine.run();
    sendJson(res, 200, { ok: true, jobId: id });
  },

  'POST /api/job/pause': async (req, res) => { engine.pause(); sendJson(res, 200, { ok: true, state: engine.state }); },
  'POST /api/job/resume': async (req, res) => { engine.resume(); sendJson(res, 200, { ok: true, state: engine.state }); },
  'POST /api/job/stop': async (req, res) => { engine.stop(); sendJson(res, 200, { ok: true }); },
  'POST /api/job/estop': async (req, res) => { engine.emergencyStop(); sendJson(res, 200, { ok: true }); },
  'POST /api/job/clear': async (req, res) => { engine.clearFinished(); sendJson(res, 200, { ok: true }); },

  'POST /api/preview': async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const q = body.gcode;
    if (!q) return sendJson(res, 400, err('缺少 gcode 参数', 'Missing gcode parameter'));
    const preset = getPreset(config.machineId);
    const r = parseHpgl(q, { stepsPerInch: preset.stepsPerInch });
    const b = new HpglBuilder(preset, { ...axisOptions(preset), origin: body.origin });
    mapPathPoints(r.path, (x, y) => b.toUser(x, y), b.isReflection);
    sendJson(res, 200, { path: pathToClient(r.path), stats: r.stats, warnings: r.warnings });
  },

  'GET /api/preview': async (req, res, url) => {
    const q = url.searchParams.get('gcode');
    if (!q) return sendJson(res, 400, err('缺少 gcode 参数', 'Missing gcode parameter'));
    const preset = getPreset(config.machineId);
    const r = parseHpgl(q, { stepsPerInch: preset.stepsPerInch });
    const b = new HpglBuilder(preset, axisOptions(preset));
    mapPathPoints(r.path, (x, y) => b.toUser(x, y), b.isReflection);
    sendJson(res, 200, { path: pathToClient(r.path), stats: r.stats, warnings: r.warnings });
  },
};

function err(zh, en) {
  return { error: zh, errorEn: en || zh };
}

function pathToClient(path) {
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (routes[key]) {
    try {
      await routes[key](req, res, url);
    } catch (routeErr) {
      console.error(`[${key}]`, routeErr);
      const status = routeErr.status || 500;
      if (!res.headersSent) sendJson(res, status, err(routeErr.message, routeErr.errorEn || routeErr.message));
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, err('接口不存在', 'No such endpoint'));
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head);
});

const origHandle = wss.handleUpgrade.bind(wss);
wss.handleUpgrade = (req, socket, head) => {
  origHandle(req, socket, head);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(JSON.stringify({ type: 'state:sync', payload: fullState(), t: Date.now() }));
  }
};

server.listen(PORT, HOST, async () => {
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

  if (config.serial?.path) {
    const ok = await tryReconnect();
    if (!ok) {
      console.log(`  ! 未能自动连接 ${config.serial.path}，将持续重试`);
      console.log('    （确认设备已插好、USB 线供电正常，或在界面上手动选择串口）');
    }
    startReconnectLoop();
  } else {
    console.log('  · 尚未配置串口，请在界面上选择串口并连接');
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    stopReconnectLoop();
    try {
      if (connected) await transport.write('PU;\n');
    } catch { /* 已断开，忽略 */ }
    process.exit(0);
  });
}

function localIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

void createTransport; void TcpTransport; void HpglBuilder; void pathBBox; void pathLength; void parseSvgPath; void JobState;
