/**
 * 主应用逻辑。
 * 免构建、无框架——RK3399 上不需要跑 npm build，部署就是拷贝文件。
 */

import * as G from '../geom.js';
import { Renderer } from './render.js';
import * as T from './transform.js';
import { t, lang, initLang, setLang, onLangChange } from './i18n.js';
import { Vectorizer } from './vectorizer.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const renderer = new Renderer(canvas);
let vectorizer = null;
// 调试钩子：浏览器控制台里可用 __plotter.renderer / __probe.T 查状态
if (typeof window !== 'undefined') {
  window.__plotter = { renderer, get state() { return state; } };
  window.__probe = { T, G };
}

  const state = {
    config: null,
    preset: null,
    presets: {},
    originPositions: {},
    materials: [],
    connected: false,
    deviceInfo: null,
    gcode: '',
    ws: null,
    jobState: 'idle',
    compiled: null,
    selectedId: null,
    selectedIds: new Set(),
    knifePos: { x: 600, y: 0 },
    userOrigin: { x: 600, y: 0 },
    originInitialized: false,
  };

  /** 当前生效的机器原点方位（'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'） */
  function getOriginPos(presetOverride) {
    return state.config?.originPosition
      || (presetOverride || state.preset)?.originPosition
      || 'bottom-right';
  }

  /** 当前机器物理原点在画布坐标系（左下为 0,0，X 向右，Y 向上）下的角点坐标 */
  function getMechOrigin(presetOverride, posOverride) {
    const p = presetOverride || state.preset || { width: 600, height: 710 };
    const pos = posOverride || getOriginPos(p);
    const W = p.width || 600;
    const H = p.height || 710;
    switch (pos) {
      case 'bottom-right': return { x: W, y: 0 };
      case 'top-right':    return { x: W, y: H };
      case 'top-left':     return { x: 0, y: H };
      case 'bottom-left':
      default:             return { x: 0, y: 0 };
    }
  }

  /**
   * 画布坐标 (x, y) → 相对机械原点的正向距离 (ux, uy)，供状态栏显示。
   * 例如右下角原点机型在 (W, 0) 处显示为 (0.0, 0.0)。
   */
  function modelToOriginCoords(x, y) {
    const pos = getOriginPos();
    const mech = getMechOrigin();
    const isRight = pos === 'bottom-right' || pos === 'top-right';
    const isTop   = pos === 'top-right' || pos === 'top-left';
    return {
      x: isRight ? (mech.x - x) : (x - mech.x),
      y: isTop   ? (mech.y - y) : (y - mech.y),
    };
  }

  /**
   * 计算包围盒相对于当前工作原点 (state.userOrigin) 的内侧边距 (ox, oy)。
   * 在右下角原点机型上，ox 是图形右边缘距原点 X 的距离，oy 是图形下边缘距原点 Y 的距离。
   */
  function bboxToOriginOffset(bb) {
    const pos = getOriginPos();
    const uo = state.userOrigin || getMechOrigin();
    const isRight = pos === 'bottom-right' || pos === 'top-right';
    const isTop   = pos === 'top-right' || pos === 'top-left';
    return {
      x: isRight ? (uo.x - bb.maxX) : (bb.minX - uo.x),
      y: isTop   ? (uo.y - bb.maxY) : (bb.minY - uo.y),
    };
  }

  /**
   * 将单个或多个图层贴靠到当前工作原点内侧指定偏移 (marginX, marginY) 处，
   * 确保刻绘时直接从原点旁起刀，消除刻字前 Y 轴大幅空走。
   */
  function snapLayersToOrigin(layers, marginX = 10, marginY = 10) {
    const list = Array.isArray(layers) ? layers : [layers];
    if (!list.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of list) {
      const b = T.layerBBox(l);
      if (b.w || b.h) {
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
    }
    if (!Number.isFinite(minX)) return;
    const w = maxX - minX, h = maxY - minY;
    const pos = getOriginPos();
    const uo = state.userOrigin || getMechOrigin();
    const isRight = pos === 'bottom-right' || pos === 'top-right';
    const isTop   = pos === 'top-right' || pos === 'top-left';

    const targetMinX = isRight ? (uo.x - marginX - w) : (uo.x + marginX);
    const targetMinY = isTop   ? (uo.y - marginY - h) : (uo.y + marginY);
    const dx = targetMinX - minX;
    const dy = targetMinY - minY;

    const bed = state.preset || { width: 600, height: 710 };
    for (const l of list) {
      T.translateLayer(l, dx, dy);
      T.clampLayerIntoBed(l, bed.width, bed.height, 2);
    }
  }

  // ---------------------------------------------------------------- 撤销/重做
  const history = {
    undoStack: [],
    redoStack: [],
    maxSize: 50,
  };

  function pushHistory() {
    const snap = {
      layers: structuredClone(renderer.layers),
      selectedId: state.selectedId,
      selectedIds: Array.from(state.selectedIds),
    };
    history.undoStack.push(snap);
    if (history.undoStack.length > history.maxSize) history.undoStack.shift();
    history.redoStack = [];
  }

  function undo() {
    if (!history.undoStack.length) {
      toast(t('toast.noUndo'), 'warn');
      return;
    }
    const current = {
      layers: structuredClone(renderer.layers),
      selectedId: state.selectedId,
      selectedIds: Array.from(state.selectedIds),
    };
    history.redoStack.push(current);
    const prev = history.undoStack.pop();
    restoreSnapshot(prev);
    toast(t('toast.undone'), 'ok');
  }

  function redo() {
    if (!history.redoStack.length) {
      toast(t('toast.noRedo'), 'warn');
      return;
    }
    const current = {
      layers: structuredClone(renderer.layers),
      selectedId: state.selectedId,
      selectedIds: Array.from(state.selectedIds),
    };
    history.undoStack.push(current);
    const next = history.redoStack.pop();
    restoreSnapshot(next);
    toast(t('toast.redone'), 'ok');
  }

  function restoreSnapshot(snap) {
    renderer.layers = structuredClone(snap.layers);
    state.selectedId = snap.selectedId;
    state.selectedIds = new Set(snap.selectedIds || []);
    renderer.selectedId = state.selectedId;
    renderer.selectedIds = state.selectedIds;
    renderer.dirty = true;
    renderLayerList();
    updateTransformPanel();
    updateStats();
  }

  // ---------------------------------------------------------------- 全局遮罩
  function showLoading(text) {
    const overlay = $('loadingOverlay');
    const label = $('loadingText');
    if (label && text) label.textContent = text;
    if (overlay) overlay.style.display = 'flex';
  }

  function hideLoading() {
    const overlay = $('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  // ---------------------------------------------------------------- 提示
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('toastWrap').appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function logLine(text, kind = '') {
    const box = $('logView');
    const div = document.createElement('div');
    if (kind) div.className = 'log-line-' + kind;
    const stamp = new Date().toLocaleTimeString(lang() === 'en' ? 'en-GB' : 'zh-CN', { hour12: false });
    div.textContent = `[${stamp}] ${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 200) box.firstChild.remove();
  }

  // ---------------------------------------------------------------- API
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (netErr) {
      console.error(`[api] 网络请求失败 ${path}:`, netErr);
      throw new Error(t('srv.networkError'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (lang() === 'en' ? (data.errorEn || data.error) : data.error);
      throw new Error(msg || t('srv.httpFail', { code: res.status }));
    }
    return data;
  }

  // ---------------------------------------------------------------- 初始化
  async function boot() {
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    await new Promise((r) => requestAnimationFrame(r));

    initLang();

    renderer.resize();
    if (!renderer.vw) renderer.resize();
    renderer.fit();
    wireCanvas();
    wireUI();
    onLangChange(() => {
      refreshState();
      renderLayerList();
      updateStats();
      updateTransformPanel();
      renderer.dirty = true;
    });
    await refreshState();
    fitToContent();
    connectWS();
    setInterval(refreshState, 5000);
  }

  let cachedPorts = [];
  let userToggledConnManually = false;

  function updateConnCardDisplay() {
    const dot = $('connCardDot');
    const title = $('connCardTitle');
    const sub = $('connCardSub');
    const card = $('connCard');
    const details = $('connDetails');
    if (!dot || !title || !sub) return;

    if (state.connected) {
      card?.classList.remove('warn');
      dot.className = 'conn-dot on';
      title.textContent = `${state.preset?.name || t('dev.defaultMachine')} · ${t('dev.connectedSub')}`;
      const en = lang() === 'en';
      const dev = state.deviceInfo;
      const chip = dev ? (en ? (dev.chipNameEn || dev.chipName) : (dev.chipNameZh || dev.chipName)) : '';
      let subText = (dev?.path || t('btn.connected')) + (chip ? ` (${chip})` : '');
      if (dev?.silent) subText += ` · ${t('dev.oneWay')}`;
      sub.textContent = subText;
    } else {
      const n = cachedPorts.length;
      if (n > 1) {
        card?.classList.add('warn');
        dot.className = 'conn-dot warn';
        title.textContent = t('dev.multiplePorts', { n });
        sub.textContent = t('dev.multiplePortsSub');
        if (details && !userToggledConnManually) {
          details.style.display = 'block';
        }
      } else if (n === 1) {
        card?.classList.remove('warn');
        dot.className = 'conn-dot';
        title.textContent = t('dev.autoConn');
        sub.textContent = t('dev.autoConnSub');
      } else {
        card?.classList.remove('warn');
        dot.className = 'conn-dot';
        title.textContent = t('dev.noDevice');
        sub.textContent = t('dev.noDeviceSub');
      }
    }
  }

  async function refreshState() {
    try {
      const prevPos = state.preset ? getOriginPos() : null;
      const prevW = state.preset?.width;
      const prevH = state.preset?.height;

      const s = await api('/api/state');
      state.config = s.config;
      state.preset = s.preset;
      state.presets = s.presets;
      state.originPositions = s.originPositions || {};
      state.materials = s.materials;
      state.connected = s.device.connected;
      state.deviceInfo = s.device.info;

      const curPos = getOriginPos(s.preset);
      const sel = $('machineSel');
      const en = lang() === 'en';
      if (sel.options.length === 0 || sel.dataset.lang !== lang()) {
        sel.innerHTML = '';
        for (const [id, p] of Object.entries(s.presets)) {
          const o = document.createElement('option');
          o.value = id;
          o.textContent = `${en ? (p.nameEn || p.name) : p.name} · ${p.width}×${p.height}mm`;
          sel.appendChild(o);
        }
        sel.dataset.lang = lang();
      }
      if (document.activeElement !== sel) sel.value = s.config.machineId;

      const origSel = $('originPosSel');
      if (origSel && document.activeElement !== origSel) {
        origSel.value = curPos;
      }

      renderer.setPreset(s.preset, curPos);

      // 首次初始化或机器幅面/原点方位切换时，将默认原点与刀头同步到新的机械原点角点
      if (!state.originInitialized || prevPos !== curPos || prevW !== s.preset.width || prevH !== s.preset.height) {
        const mech = getMechOrigin(s.preset, curPos);
        state.userOrigin = { ...mech };
        state.knifePos = { ...mech };
        state.originInitialized = true;
      }
      updateKnifeCoordsDisplay();
      renderer.dirty = true;

      // 材料下拉
      const ms = $('matSel');
      if (ms.options.length === 0 || ms.dataset.lang !== lang()) {
        ms.innerHTML = '';
        for (const m of s.materials) {
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = `${en ? (m.nameEn || m.name) : m.name} — ${m.speed}mm/s ${m.force}g`;
          o.dataset.speed = m.speed;
          o.dataset.force = m.force;
          ms.appendChild(o);
        }
        ms.dataset.lang = lang();
        const lastId = s.config.lastMaterial || s.materials[0].id;
        ms.value = lastId;
        const selOpt = ms.selectedOptions[0];
        if (selOpt && +selOpt.dataset.speed === +s.config.defaultSpeed
                   && +selOpt.dataset.force === +s.config.defaultForce) {
          $('speedRange').value = selOpt.dataset.speed;
          $('speedVal').textContent = selOpt.dataset.speed;
          $('forceRange').value = selOpt.dataset.force;
          $('forceVal').textContent = selOpt.dataset.force;
        }
      }

      const editing = document.activeElement === $('speedRange')
                   || document.activeElement === $('forceRange')
                   || document.activeElement === $('dirSel');
      if (!editing) {
        $('speedRange').value = s.config.defaultSpeed;
        $('speedVal').textContent = s.config.defaultSpeed;
        $('forceRange').value = s.config.defaultForce;
        $('forceVal').textContent = s.config.defaultForce;
        $('dirSel').value = s.config.direction;
      }

      if ($('baudSel') && document.activeElement !== $('baudSel') && s.config?.serial?.baud) {
        $('baudSel').value = String(s.config.serial.baud);
      }

      $('serverInfo').textContent = `${s.server.hostname} · :${s.server.port}`;

      // 连接状态
      const pill = $('connPill');
      const busy = s.job.state === 'running';
      pill.className = 'conn-pill' + (busy ? ' busy' : s.device.connected ? ' on' : '');
      $('connText').textContent = busy
        ? t(state.jobState === 'paused' ? 'conn.paused' : 'conn.outputting')
        : t(s.device.connected ? 'btn.connected' : 'btn.disconnected');
      $('btnDisconnect').disabled = !s.device.connected;
      $('btnConnectTop').textContent = t(s.device.connected ? 'btn.connected' : 'btn.connect');

      updateConnCardDisplay();

      const padOff = !s.device.connected;
      document.querySelectorAll('[data-manual]').forEach((b) => { b.disabled = padOff; });
      document.querySelectorAll('.pad-key').forEach((b) => { b.disabled = padOff; b.classList.toggle('off', padOff); });

      $('qrHint').innerHTML = t('srv.qrHint') + `<br>${t('srv.qrHint2')}`;

      updateTransformPanel();
      updateStats();
    } catch (e) {
      $('serverInfo').textContent = t('srv.unresponsive');
    }
  }

  // ---------------------------------------------------------------- WebSocket
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { type, payload } = msg;

      if (type === 'state:sync') { onSync(payload); return; }
      if (type === 'job:progress') { onProgress(payload); return; }
      if (type === 'job:state') {
        state.jobState = payload.state;
        onJobState(payload);
        return;
      }
      if (type === 'job:log') { logLine(pickLang(payload)); return; }
      if (type === 'device:data') {
        if (payload.data && payload.data.trim()) logLine('← ' + payload.data.trim().slice(0, 60), 'ok');
        return;
      }
      if (type === 'device:connected') { toast(t('toast.deviceConnected'), 'ok'); refreshState(); return; }
      if (type === 'device:closed') { toast(t('toast.deviceClosed'), 'err'); refreshState(); return; }
      if (type === 'device:error') { toast(t('toast.deviceError', { msg: payload.message }), 'err'); return; }
      if (type === 'config:updated') { state.config = payload; return; }
      if (type === 'history:updated') {
        if ($('historyModal')?.style.display !== 'none') refreshHistoryList();
        return;
      }
    };

    ws.onclose = () => {
      setTimeout(connectWS, 3000);
    };
    ws.onerror = () => { /* onclose 会重连 */ };
  }

  function pickLang(p) {
    if (p === null || p === undefined) return '';
    if (typeof p === 'string') return p;
    const en = lang() === 'en';
    if (p.note !== undefined) return en ? (p.noteEn || p.note) : p.note;
    if (en) return p.en || p.zh || p.line || '';
    return p.zh || p.en || p.line || '';
  }

  function onSync(s) {
    state.config = s.config;
    state.preset = s.preset;
    state.jobState = s.job.state;
    renderer.setPreset(s.preset, getOriginPos(s.preset));
    refreshState();
  }

  function onProgress(p) {
    const fill = $('progFill');
    const pct = p.motionPercent !== undefined ? p.motionPercent : p.percent;
    fill.style.width = pct + '%';

    if (p.phase === 'caching') {
      $('progText').textContent = t('job.caching', {
        trans: p.transferPercent ?? p.percent,
        pct: p.motionPercent ?? 0,
      });
    } else if (p.phase === 'cutting') {
      $('progText').textContent = t('job.cutting', {
        pct: p.motionPercent ?? p.percent,
      });
    } else if (p.phase === 'done' || pct >= 100) {
      $('progText').textContent = t('job.done');
    } else {
      $('progText').textContent = t('job.progress', {
        pct, sent: p.sent, total: p.total,
      });
    }

    const eta = p.etaMs || 0;
    $('progEta').textContent = eta > 0 ? t('job.eta', { time: fmtTime(eta) }) : '';

    const transEl = $('progTransferText');
    if (transEl) {
      transEl.textContent = t('job.cacheInfo', {
        trans: p.transferPercent ?? 100,
        sent: p.sent,
        total: p.total,
      });
    }

    const lenEl = $('progMotionLen');
    if (lenEl) {
      if (p.cutLengthMm > 0) {
        const lenStr = p.cutLengthMm > 1000 ? (p.cutLengthMm / 1000).toFixed(2) + ' m' : Math.round(p.cutLengthMm) + ' mm';
        lenEl.textContent = t('job.motionLen', { len: lenStr });
      } else {
        lenEl.textContent = '';
      }
    }
  }

  function onJobState(s) {
    $('jobPanel').style.display = 'block';
    const fill = $('progFill');
    fill.className = 'progress-fill' + (s.state === 'done' ? ' ok' : s.state === 'aborted' ? ' stop' : '');
    if (s.state === 'idle') { $('btnPause').textContent = t('btn.pause'); }
    if (s.state === 'paused') { $('btnPause').textContent = t('btn.resume'); }
    if (s.state === 'running') { $('btnPause').textContent = t('btn.pause'); }
    if (s.state === 'done') { fill.style.width = '100%'; }
    refreshState();
  }

  function fmtTime(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return t('time.sec', { n: s });
    const m = Math.floor(s / 60);
    if (m < 60) return t('time.minSec', { m, s: s % 60 });
    return t('time.hourMin', { h: Math.floor(m / 60), m: m % 60 });
  }

  // ---------------------------------------------------------------- 画布交互
  const TUNING = {
    zoomStep: 1.06,
    panKeyStep: 40,
    dragThreshold: 4,
    pinchMin: 1.01,
  };

  function wireCanvas() {
    let mode = null;
    let lastX = 0, lastY = 0, moved = 0;
    let dragLayer = null;
    let scaleStart = null;
    let rotateStart = null;

    const localPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (document.activeElement && document.activeElement !== canvas && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        document.activeElement.blur();
      }
      canvas.focus();
      const p = localPos(e);
      lastX = e.clientX; lastY = e.clientY; moved = 0;

      if (renderer.tool === 'pan' || e.button === 1 || e.button === 2 || e.shiftKey) {
        mode = 'pan';
        canvas.style.cursor = 'grabbing';
        return;
      }

      const hd = renderer.hitHandle(p.x, p.y);
      if (hd && hd.kind === 'rotate') {
        const layer = renderer.layers.find((l) => l.id === state.selectedId);
        if (!layer) { mode = null; return; }
        const bb = T.layerBBox(layer);
        const c = renderer.toScreen(bb.cx, bb.cy);
        rotateStart = {
          angle: Math.atan2(p.y - c.y, p.x - c.x),
          cx: bb.cx, cy: bb.cy, sx: c.x, sy: c.y,
          subpaths: structuredClone(layer.subpaths),
        };
        dragLayer = layer;
        mode = 'rotate';
        return;
      }
      if (hd && hd.kind === 'scale') {
        const layer = renderer.layers.find((l) => l.id === state.selectedId);
        if (!layer) { mode = null; return; }
        const bb = T.layerBBox(layer);
        scaleStart = { bb, px: p.x, py: p.y, corner: hd.id, subpaths: structuredClone(layer.subpaths) };
        dragLayer = layer;
        mode = 'scale';
        return;
      }

      const m = renderer.toModel(p.x, p.y);
      const hit = renderer.hitTest(m.x, m.y);
      if (hit) {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (state.selectedIds.has(hit.id)) {
            state.selectedIds.delete(hit.id);
            state.selectedId = [...state.selectedIds][0] || null;
          } else {
            state.selectedIds.add(hit.id);
            state.selectedId = hit.id;
          }
        } else {
          state.selectedId = hit.id;
          state.selectedIds = new Set([hit.id]);
        }
        renderer.selectedId = state.selectedId;
        renderer.selectedIds = state.selectedIds;
        dragLayer = hit;
        mode = 'move';
      } else {
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
          state.selectedId = null;
          state.selectedIds = new Set();
          renderer.selectedId = null;
          renderer.selectedIds = state.selectedIds;
        }
        mode = 'pan';
      }
      renderer.dirty = true;
      renderLayerList();
      updateTransformPanel();
    });

    let dragStartRecorded = false;

    canvas.addEventListener('pointermove', (e) => {
      const p = localPos(e);
      const dx = e.clientX - lastX, dy = e.clientY - lastY;

      if (!mode) {
        const hd = renderer.hitHandle(p.x, p.y);
        if (hd) {
          canvas.style.cursor = hd.cursor;
        } else {
          const m = renderer.toModel(p.x, p.y);
          canvas.style.cursor = renderer.hitTest(m.x, m.y) ? 'move'
            : (renderer.tool === 'pan' ? 'grab' : 'crosshair');
        }
        return;
      }

      moved += Math.abs(dx) + Math.abs(dy);
      const past = moved > TUNING.dragThreshold;

      if (mode === 'pan') {
        renderer.panBy(dx, dy);
      } else if (mode === 'move' && dragLayer && past) {
        if (!dragStartRecorded) {
          pushHistory();
          dragStartRecorded = true;
        }
        const dxM = dx / renderer.scale;
        const dyM = -dy / renderer.scale;
        const targets = state.selectedIds.has(dragLayer.id)
          ? renderer.layers.filter((l) => state.selectedIds.has(l.id))
          : [dragLayer];
        for (const l of targets) {
          T.translateLayer(l, dxM, dyM);
        }
        renderer.dirty = true;
        updateTransformPanel();
      } else if (mode === 'scale' && dragLayer && past) {
        if (!dragStartRecorded) {
          pushHistory();
          dragStartRecorded = true;
        }
        const bb = scaleStart.bb;
        const w0 = Math.max(bb.w, 1e-6), h0 = Math.max(bb.h, 1e-6);
        const c = scaleStart.corner;
        const dxPx = p.x - scaleStart.px;
        const dyPx = p.y - scaleStart.py;
        const sx0 = (c === 'nw' || c === 'sw') ? -dxPx : dxPx;
        const sy0 = (c === 'sw' || c === 'se') ? dyPx : -dyPx;
        let fx = 1 + sx0 / (renderer.scale * w0);
        let fy = 1 + sy0 / (renderer.scale * h0);
        if (e.shiftKey) { const s = Math.max(fx, fy); fx = fy = s; }
        if (fx < 0.05) fx = 0.05;
        if (fy < 0.05) fy = 0.05;
        dragLayer.subpaths = structuredClone(scaleStart.subpaths);
        T.scaleLayer(dragLayer, fx, fy);
        renderer.dirty = true;
        updateTransformPanel();
      } else if (mode === 'rotate' && dragLayer && past) {
        if (!dragStartRecorded) {
          pushHistory();
          dragStartRecorded = true;
        }
        const cur = Math.atan2(p.y - rotateStart.sy, p.x - rotateStart.sx);
        let deg = (cur - rotateStart.angle) * 180 / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        dragLayer.subpaths = structuredClone(rotateStart.subpaths);
        T.rotateLayer(dragLayer, deg, rotateStart.cx, rotateStart.cy);
        renderer.dirty = true;
        updateTransformPanel();
      }

      lastX = e.clientX; lastY = e.clientY;
    });

    const endDrag = () => {
      if (mode === 'move' && dragLayer) {
        const bed = state.preset || { width: 600, height: 710 };
        const targets = state.selectedIds.has(dragLayer.id)
          ? renderer.layers.filter((l) => state.selectedIds.has(l.id))
          : [dragLayer];
        for (const l of targets) {
          T.clampLayerIntoBed(l, bed.width, bed.height, 2);
        }
        renderer.dirty = true;
        updateTransformPanel();
        updateStats();
      }
      mode = null; dragLayer = null;
      scaleStart = null; rotateStart = null;
      dragStartRecorded = false;
      canvas.style.cursor = renderer.tool === 'pan' ? 'grab' : 'crosshair';
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = localPos(e);
      renderer.zoomAt(e.deltaY < 0 ? TUNING.zoomStep : 1 / TUNING.zoomStep, p.x, p.y);
      updateZoomBadge();
    }, { passive: false });

    let pinchStart = null;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        pinchStart = { d, scale: renderer.scale };
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStart) {
        e.preventDefault();
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        renderer.scale = G.clamp(pinchStart.scale * (d / pinchStart.d), 0.3, 40);
        renderer.dirty = true;
        updateZoomBadge();
      }
    }, { passive: false });
    canvas.addEventListener('touchend', () => { pinchStart = null; });

    document.querySelectorAll('.tool[data-tool]').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.tool[data-tool]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        renderer.tool = b.dataset.tool;
        canvas.style.cursor = renderer.tool === 'pan' ? 'grab' : 'crosshair';
      });
    });

    $('btnFit').addEventListener('click', () => { fitToContent(); });
    $('btnGridToggle').addEventListener('click', () => {
      renderer.showGrid = !renderer.showGrid;
      renderer.dirty = true;
      $('btnGridToggle').classList.toggle('active', renderer.showGrid);
    });

    window.addEventListener('resize', () => {
      renderer.resize();
      fitToContent();
    });
  }

  function updateZoomBadge() {
    $('zoomBadge').textContent = Math.round(renderer.scale / 3 * 100) + '%';
  }

  // ---------------------------------------------------------------- 图层
  function addLayer(name, path, extra = {}) {
    const layer = {
      id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6),
      name,
      subpaths: path.subpaths,
      hidden: false,
      isGroup: !!extra.isGroup,
      children: extra.children || null,
      ...extra,
    };
    renderer.layers.push(layer);
    renderer.dirty = true;
    renderLayerList();
    updateStats();
    return layer;
  }

  function fitToContent() {
    const visible = renderer.layers.filter((l) => !l.hidden);
    if (!visible.length) { renderer.fit(); renderer.dirty = true; updateZoomBadge(); return; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const layer of visible) {
      for (const sub of layer.subpaths) {
        const pts = G.flattenSubpathOpen(sub, 0.1);
        for (const p of pts) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
    }
    if (!isFinite(minX)) { renderer.fit(); renderer.dirty = true; return; }

    const preset = state.preset || { width: 630, height: 710 };
    const boxMinX = Math.min(0, minX), boxMinY = Math.min(0, minY);
    const boxMaxX = Math.max(preset.width, maxX), boxMaxY = Math.max(preset.height, maxY);

    let { vw, vh } = renderer;
    if (!vw || !vh) {
      renderer.resize();
      vw = renderer.vw || 1;
      vh = renderer.vh || 1;
    }

    const pad = 28;
    const scaleContent = Math.min(
      (vw - pad * 2) / Math.max(1, maxX - minX),
      (vh - pad * 2) / Math.max(1, maxY - minY)
    );
    const scaleBed = Math.min(
      (vw - pad * 2) / Math.max(1, boxMaxX - boxMinX),
      (vh - pad * 2) / Math.max(1, boxMaxY - boxMinY)
    );
    renderer.scale = Math.max(0.2, scaleContent > scaleBed * 2.2 ? scaleContent * 0.9 : scaleBed);
    renderer.offsetX = (boxMinX + boxMaxX) / 2;
    renderer.offsetY = (boxMinY + boxMaxY) / 2;
    renderer.dirty = true;
    updateZoomBadge();
  }

  function renderLayerList() {
    const box = $('layerList');
    const list = renderer.layers;
    box.innerHTML = '';
    $('layerEmpty').style.display = list.length ? 'none' : '';
    $('layerCount').textContent = list.length ? t('layers.count', { n: list.length }) : '';
    $('btnSend').disabled = list.length === 0;
    if ($('btnFrame')) $('btnFrame').disabled = list.length === 0;

    for (const layer of list.slice().reverse()) {
      const el = document.createElement('div');
      const isSel = state.selectedId === layer.id || state.selectedIds.has(layer.id);
      el.className = 'layer-item' + (layer.hidden ? ' hidden' : '') +
        (isSel ? ' active' : '');
      const len = layer.subpaths.reduce((a, s) => a + G.subpathLength(s), 0);
      const groupBadge = layer.isGroup ? `<span class="group-tag">${t('prop.group')}</span>` : '';
      el.innerHTML = `
        <span class="nm">${escapeHtml(layer.name)}${groupBadge}</span>
        <span class="meta">${len.toFixed(0)}mm</span>
        <button class="btn btn-sm" data-act="vis" title="${t('layer.hidden')}">${layer.hidden ? '○' : '●'}</button>
        <button class="btn btn-sm" data-act="del" title="${t('prop.del')}">×</button>`;
      el.querySelector('[data-act=vis]').addEventListener('click', (e) => {
        e.stopPropagation();
        layer.hidden = !layer.hidden;
        renderer.dirty = true;
        renderLayerList();
        updateStats();
      });
      el.querySelector('[data-act=del]').addEventListener('click', (e) => {
        e.stopPropagation();
        renderer.layers = renderer.layers.filter((x) => x.id !== layer.id);
        state.selectedIds.delete(layer.id);
        if (state.selectedId === layer.id) {
          state.selectedId = [...state.selectedIds][0] || null;
          renderer.selectedId = state.selectedId;
        }
        renderer.dirty = true;
        renderLayerList();
        updateTransformPanel();
        updateStats();
      });
      el.addEventListener('click', (e) => {
        if (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
          document.activeElement.blur();
        }
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (state.selectedIds.has(layer.id)) {
            state.selectedIds.delete(layer.id);
            if (state.selectedId === layer.id) {
              state.selectedId = [...state.selectedIds][0] || null;
            }
          } else {
            state.selectedIds.add(layer.id);
            state.selectedId = layer.id;
          }
        } else {
          state.selectedIds = new Set([layer.id]);
          state.selectedId = layer.id;
        }
        renderer.selectedId = state.selectedId;
        renderer.selectedIds = state.selectedIds;
        renderer.dirty = true;
        renderLayerList();
        updateTransformPanel();
      });
      box.appendChild(el);
    }
  }

  function groupSelectedLayers() {
    const toGroup = renderer.layers.filter((l) => state.selectedIds.has(l.id));
    if (toGroup.length <= 1) return;
    pushHistory();
    const firstIdx = renderer.layers.indexOf(toGroup[0]);
    renderer.layers = renderer.layers.filter((l) => !state.selectedIds.has(l.id));
    const newGroup = {
      id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6),
      name: `${t('prop.group')} (${toGroup.length})`,
      isGroup: true,
      hidden: false,
      subpaths: toGroup.flatMap((l) => structuredClone(l.subpaths)),
      children: toGroup.map((l) => ({
        name: l.name,
        subpaths: structuredClone(l.subpaths),
        isGroup: !!l.isGroup,
        children: l.children ? structuredClone(l.children) : null,
      })),
    };
    renderer.layers.splice(firstIdx, 0, newGroup);
    state.selectedId = newGroup.id;
    state.selectedIds = new Set([newGroup.id]);
    renderer.selectedId = newGroup.id;
    renderer.selectedIds = state.selectedIds;
    renderer.dirty = true;
    renderLayerList();
    updateTransformPanel();
    updateStats();
    toast(t('toast.grouped', { n: toGroup.length }), 'ok');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function totalLength() {
    return renderer.layers
      .filter((l) => !l.hidden)
      .reduce((a, l) => a + l.subpaths.reduce((b, s) => b + G.subpathLength(s), 0), 0);
  }

  function updateStats() {
    const len = totalLength();
    const subs = renderer.layers.filter((l) => !l.hidden)
      .reduce((a, l) => a + l.subpaths.length, 0);
    $('statLen').textContent = len > 1000 ? (len / 1000).toFixed(2) + ' m' : len.toFixed(0) + ' mm';
    $('statSubs').textContent = subs;
    if (state.compiled) {
      const est = state.compiled.estimate;
      $('statTime').textContent = fmtTime(est.wallSeconds * 1000);
      $('statBytes').textContent = (state.compiled.bytes / 1024).toFixed(1) + ' KB';
    } else if (len > 0) {
      const spd = +$('speedRange').value;
      $('statTime').textContent = fmtTime((len / spd) * 1000);
      $('statBytes').textContent = t('stat.pending');
    } else {
      $('statTime').textContent = '—';
      $('statBytes').textContent = '—';
    }
  }

  // ---------------------------------------------------------------- 对象属性
  const round1 = (v) => Math.round(v * 10) / 10;

  function deleteSelected() {
    const toDelete = new Set(state.selectedIds);
    if (state.selectedId) toDelete.add(state.selectedId);
    if (!toDelete.size) return;
    pushHistory();
    const count = toDelete.size;
    renderer.layers = renderer.layers.filter((l) => !toDelete.has(l.id));
    state.selectedId = null;
    state.selectedIds = new Set();
    renderer.selectedId = null;
    renderer.selectedIds = state.selectedIds;
    renderer.dirty = true;
    renderLayerList();
    updateTransformPanel();
    updateStats();
    toast(t('toast.deleted', { n: count }), 'ok');
  }

  function duplicateSelected() {
    const toDup = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
    if (!toDup.length) return;
    pushHistory();
    const pos = getOriginPos();
    const isRight = pos === 'bottom-right' || pos === 'top-right';
    const copies = toDup.map((l) => {
      const copy = T.duplicateLayer(l);
      copy.name = t('prop.copySuffix', { name: l.name });
      T.translateLayer(copy, isRight ? -10 : 10, 10);
      return copy;
    });
    renderer.layers.push(...copies);
    state.selectedIds = new Set(copies.map((c) => c.id));
    state.selectedId = copies[0].id;
    renderer.selectedId = state.selectedId;
    renderer.selectedIds = state.selectedIds;
    renderer.dirty = true;
    renderLayerList();
    updateTransformPanel();
    updateStats();
  }

  function flipSelected(horizontal = true) {
    const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
    if (!selected.length) {
      const visible = renderer.layers.filter((l) => !l.hidden);
      if (!visible.length) return;
      pushHistory();
      const bed = state.preset || { width: 600, height: 710 };
      const cx = bed.width / 2, cy = bed.height / 2;
      for (const l of visible) {
        T.flipLayer(l, horizontal, !horizontal, cx, cy);
      }
      renderer.dirty = true;
      updateTransformPanel();
      updateStats();
      renderLayerList();
      toast(horizontal ? t('toast.flippedH') : t('toast.flippedV'), 'ok');
      return;
    }
    pushHistory();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of selected) {
      const bb = T.layerBBox(l);
      if (bb.w || bb.h) {
        if (bb.minX < minX) minX = bb.minX;
        if (bb.minY < minY) minY = bb.minY;
        if (bb.maxX > maxX) maxX = bb.maxX;
        if (bb.maxY > maxY) maxY = bb.maxY;
      }
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (const l of selected) {
      T.flipLayer(l, horizontal, !horizontal, cx, cy);
    }
    renderer.dirty = true;
    updateTransformPanel();
    updateStats();
    renderLayerList();
    toast(horizontal ? t('toast.flippedH') : t('toast.flippedV'), 'ok');
  }

  function ungroupSelectedLayers() {
    const toUngroup = renderer.layers.filter((l) => (state.selectedIds.has(l.id) || l.id === state.selectedId) && (l.isGroup || (l.children && l.children.length > 0) || (l.subpaths && l.subpaths.length > 1)));
    if (!toUngroup.length) return;
    pushHistory();
    let allNew = [];
    for (const l of toUngroup) {
      const idx = renderer.layers.indexOf(l);
      if (idx === -1) continue;
      let newLayers = [];
      if (l.children && l.children.length > 0) {
        newLayers = l.children.map((child, i) => ({
          id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6) + '_' + i,
          name: child.name || `${l.name} #${i + 1}`,
          subpaths: structuredClone(child.subpaths),
          hidden: false,
          isGroup: !!child.isGroup,
          children: child.children ? structuredClone(child.children) : null,
        }));
      } else if (l.subpaths.length > 1) {
        newLayers = l.subpaths.map((sub, i) => ({
          id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6) + '_' + i,
          name: `${l.name} #${i + 1}`,
          subpaths: [structuredClone(sub)],
          hidden: false,
          isGroup: false,
          children: null,
        }));
      }
      if (newLayers.length > 0) {
        renderer.layers.splice(idx, 1, ...newLayers);
        allNew.push(...newLayers);
      }
    }
    if (allNew.length) {
      state.selectedIds = new Set([allNew[0].id]);
      state.selectedId = allNew[0].id;
      renderer.selectedId = state.selectedId;
      renderer.selectedIds = state.selectedIds;
      renderer.dirty = true;
      renderLayerList();
      updateTransformPanel();
      updateStats();
      toast(t('toast.ungrouped', { n: allNew.length }), 'ok');
    }
  }

  function updateTransformPanel() {
    const sec = $('transformSect');
    const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
    if (!selected.length) { sec.style.display = 'none'; return; }
    sec.style.display = '';

    if (state.selectedIds.size > 1) {
      $('selName').textContent = t('prop.selectedCount', { n: state.selectedIds.size });
    } else {
      $('selName').textContent = selected[0].name;
    }

    let bb;
    if (state.selectedIds.size > 1) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const l of selected) {
        const b = T.layerBBox(l);
        if (b.w || b.h) {
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
        }
      }
      bb = { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
    } else {
      bb = T.layerBBox(selected[0]);
    }

    // 属性栏 X / Y 显示相对于当前原点的距离（例如右下角原点时，距右边缘 10mm、下边缘 10mm 即显示 X=10, Y=10）
    const origOff = bboxToOriginOffset(bb);
    if (document.activeElement !== $('propX')) $('propX').value = round1(origOff.x);
    if (document.activeElement !== $('propY')) $('propY').value = round1(origOff.y);
    if (document.activeElement !== $('propW')) $('propW').value = round1(bb.w);
    if (document.activeElement !== $('propH')) $('propH').value = round1(bb.h);
    if (document.activeElement !== $('propRot')) $('propRot').value = round1(selected[0].rotation || 0);

    const btnGroup = $('btnGroup');
    const btnUngroup = $('btnUngroup');
    if (btnGroup) btnGroup.disabled = state.selectedIds.size <= 1;
    if (btnUngroup) {
      btnUngroup.disabled = !selected.some((l) => l.isGroup || (l.children && l.children.length > 0) || (l.subpaths && l.subpaths.length > 1));
    }
  }

  function afterTransform() {
    renderer.dirty = true;
    updateTransformPanel();
    updateStats();
    renderLayerList();
  }

  function wireTransformPanel() {
    // 坐标：按相对于当前原点的距离 (X, Y) 定位选中对象
    const applyXY = () => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      if (!selected.length) return;
      pushHistory();
      const targetOx = +$('propX').value || 0;
      const targetOy = +$('propY').value || 0;
      snapLayersToOrigin(selected, targetOx, targetOy);
      afterTransform();
    };
    $('propX').addEventListener('change', applyXY);
    $('propY').addEventListener('change', applyXY);

    $('btnSnapOrigin')?.addEventListener('click', () => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      const targets = selected.length ? selected : renderer.layers.filter((l) => !l.hidden);
      if (!targets.length) return;
      pushHistory();
      snapLayersToOrigin(targets, 10, 10);
      afterTransform();
      toast(t('toast.snappedOrigin'), 'ok');
    });

    // 尺寸：缩放到目标宽高（可锁比例）
    const applyWH = () => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      if (!selected.length) return;
      pushHistory();
      const keep = $('btnLockRatio').classList.contains('on');
      const targetW = +$('propW').value || 1;
      const targetH = +$('propH').value || 1;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const l of selected) {
        const b = T.layerBBox(l);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      const w = maxX - minX, h = maxY - minY;
      if (w <= 0 || h <= 0) return;

      let sx = targetW / w;
      let sy = targetH / h;
      if (keep) { const s = Math.min(sx, sy); sx = s; sy = s; }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

      for (const l of selected) {
        T.scaleLayer(l, sx, sy, cx, cy);
      }
      afterTransform();
    };
    $('propW').addEventListener('change', applyWH);
    $('propH').addEventListener('change', applyWH);

    $('btnLockRatio').addEventListener('click', () => {
      $('btnLockRatio').classList.toggle('on');
    });

    // 角度
    $('propRot').addEventListener('change', () => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      if (!selected.length) return;
      pushHistory();
      const target = +$('propRot').value || 0;
      const delta = target - (selected[0].rotation || 0);
      if (delta) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const l of selected) {
          const b = T.layerBBox(l);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        for (const l of selected) {
          l.rotation = target;
          T.rotateLayer(l, delta, cx, cy);
        }
        afterTransform();
      }
    });

    const spin = (deg) => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      if (!selected.length) return;
      pushHistory();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const l of selected) {
        const b = T.layerBBox(l);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      for (const l of selected) {
        l.rotation = (l.rotation || 0) + deg;
        T.rotateLayer(l, deg, cx, cy);
      }
      afterTransform();
    };
    $('btnRotateL').addEventListener('click', () => spin(-90));
    $('btnRotateR').addEventListener('click', () => spin(90));

    // 对齐：相对材料框
    document.querySelectorAll('[data-align]').forEach((b) => {
      b.addEventListener('click', () => {
        const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
        if (!selected.length) return;
        pushHistory();
        const bed = state.preset || { width: 600, height: 710 };
        const a = b.dataset.align;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const l of selected) {
          const bb = T.layerBBox(l);
          if (bb.minX < minX) minX = bb.minX;
          if (bb.minY < minY) minY = bb.minY;
          if (bb.maxX > maxX) maxX = bb.maxX;
          if (bb.maxY > maxY) maxY = bb.maxY;
        }
        const allBb = { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
        let dx = 0, dy = 0;
        if (a === 'left') dx = 10 - allBb.minX;
        else if (a === 'right') dx = (bed.width - 10) - allBb.maxX;
        else if (a === 'hcenter') dx = bed.width / 2 - allBb.cx;
        else if (a === 'bottom') dy = 10 - allBb.minY;
        else if (a === 'top') dy = (bed.height - 10) - allBb.maxY;
        else if (a === 'vcenter') dy = bed.height / 2 - allBb.cy;
        for (const l of selected) {
          T.translateLayer(l, round1(dx), round1(dy));
        }
        afterTransform();
      });
    });

    $('btnFlipX').addEventListener('click', () => flipSelected(true));
    $('btnFlipY').addEventListener('click', () => flipSelected(false));

    $('btnDupLayer').addEventListener('click', duplicateSelected);
    $('btnFrontLayer').addEventListener('click', () => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      if (!selected.length) return;
      pushHistory();
      renderer.layers = renderer.layers.filter((x) => !selected.includes(x)).concat(selected);
      afterTransform();
    });

    $('btnDelLayer').addEventListener('click', deleteSelected);

    $('btnGroup')?.addEventListener('click', groupSelectedLayers);
    $('btnUngroup')?.addEventListener('click', ungroupSelectedLayers);
  }

  // ---------------------------------------------------------------- UI 绑定
  function wireUI() {
    document.querySelectorAll('.mtab').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.mtab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        const p = b.dataset.panel;
        $('panelLeft').classList.toggle('show', p === 'left');
        $('panelRight').classList.toggle('show', p === 'right');
        if (p === 'none') {
          requestAnimationFrame(() => { renderer.resize(); fitToContent(); });
        }
      });
    });

    $('btnConnectTop').addEventListener('click', () => {
      if (window.innerWidth <= 1080) {
        document.querySelector('.mtab[data-panel=right]').click();
        $('connType').focus();
      } else {
        const el = $('connDetails');
        if (el) el.style.display = 'block';
        $('portSel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    const toggleConn = () => {
      userToggledConnManually = true;
      const el = $('connDetails');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    };
    $('btnToggleConn')?.addEventListener('click', toggleConn);
    $('connCard')?.addEventListener('click', toggleConn);

    // 导入
    $('btnImportFile').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', onFile);
    $('btnImportDemo').addEventListener('click', loadDemo);
    $('btnOpenVectorizer')?.addEventListener('click', () => vectorizer?.open());
    $('btnOpenHistory')?.addEventListener('click', openHistoryModal);
    $('btnHistory')?.addEventListener('click', openHistoryModal);
    $('btnCloseHistory')?.addEventListener('click', closeHistoryModal);
    $('btnCloseHistoryFoot')?.addEventListener('click', closeHistoryModal);
    $('btnClearHistory')?.addEventListener('click', clearAllHistory);
    $('btnSaveCurrentTpl')?.addEventListener('click', saveCurrentAsTemplate);
    $('historySearchInput')?.addEventListener('input', () => renderHistoryItems(cachedHistoryList));

    // 矢量化工具初始化
    vectorizer = new Vectorizer({
      toast,
      onImport: async (svgText, filename) => {
        await importVectorContent(svgText, filename);
      },
    });
    vectorizer.init();

    // 文字：按距当前原点的偏移 (txtX, txtY) 自动放置，消除 Y 轴长距离空走
    $('btnAddText').addEventListener('click', async () => {
      const text = $('txtContent').value.trim();
      if (!text) { toast(t('toast.emptyText'), 'err'); return; }
      try {
        const r = await api('/api/text-to-path', {
          method: 'POST',
          body: {
            text,
            sizeMm: +$('txtSize').value,
            rotation: +$('txtRot').value,
            x: 0,
            y: 0,
          },
        });
        pushHistory();
        const layer = addLayer(t('layer.text', { text: text.slice(0, 8) }), r.path);
        const offX = +$('txtX').value || 10;
        const offY = +$('txtY').value || 10;
        snapLayersToOrigin(layer, offX, offY);
        state.selectedId = layer.id;
        state.selectedIds = new Set([layer.id]);
        renderer.selectedId = layer.id;
        renderer.selectedIds = state.selectedIds;
        afterTransform();
        const note = pickLang(r.path.meta?.note);
        toast(note || t('toast.added'), r.path.meta?.unsupported?.length ? 'err' : 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // 图形：生成后默认贴靠在当前原点内侧 10mm 处
    $('btnAddShape').addEventListener('click', async () => {
      const type = $('shpType').value;
      const size = +$('shpSize').value;
      const body = { type, x: 0, y: 0, w: size, h: size, r: size / 2, rx: size / 2, ry: size / 3, x1: 0, y1: 0, x2: size, y2: 0 };
      try {
        const r = await api('/api/geometry', { method: 'POST', body: { items: [body] } });
        pushHistory();
        const layer = addLayer($('shpType').selectedOptions[0].textContent, r.path);
        snapLayersToOrigin(layer, 10, 10);
        state.selectedId = layer.id;
        state.selectedIds = new Set([layer.id]);
        renderer.selectedId = layer.id;
        renderer.selectedIds = state.selectedIds;
        afterTransform();
        toast(t('toast.added'), 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // 连接
    $('connType').addEventListener('change', () => {
      const kind = $('connType').value;
      $('portWrap').style.display = kind === 'serial' ? '' : 'none';
      if ($('baudWrap')) $('baudWrap').style.display = kind === 'serial' ? '' : 'none';
      $('tcpWrap').style.display = kind === 'tcp' ? '' : 'none';
    });
    $('btnScanPorts').addEventListener('click', scanPorts);
    $('btnConnect').addEventListener('click', doConnect);
    $('btnDisconnect').addEventListener('click', async () => {
      await api('/api/disconnect', { method: 'POST' });
      toast(t('toast.disconnected'));
      refreshState();
    });

    $('btnLang').addEventListener('click', () => {
      setLang(lang() === 'zh' ? 'en' : 'zh');
    });

    $('machineSel').addEventListener('change', async () => {
      const machineId = $('machineSel').value;
      const nextPreset = state.presets[machineId];
      const nextOriginPos = nextPreset?.originPosition || 'bottom-right';
      await api('/api/config', { method: 'POST', body: { machineId, originPosition: nextOriginPos } });
      state.originInitialized = false;
      toast(t('toast.machineChanged'));
      await refreshState();
      if (renderer.layers.length) {
        snapLayersToOrigin(renderer.layers.filter((l) => !l.hidden), 10, 10);
        afterTransform();
      }
    });

    $('originPosSel')?.addEventListener('change', async () => {
      const originPosition = $('originPosSel').value;
      await api('/api/config', { method: 'POST', body: { originPosition } });
      state.originInitialized = false;
      toast(t('toast.originPosChanged'), 'ok');
      await refreshState();
      if (renderer.layers.length) {
        snapLayersToOrigin(renderer.layers.filter((l) => !l.hidden), 10, 10);
        afterTransform();
      }
    });

    // 参数
    $('matSel').addEventListener('change', () => {
      const o = $('matSel').selectedOptions[0];
      $('speedRange').value = o.dataset.speed;
      $('speedVal').textContent = o.dataset.speed;
      $('forceRange').value = o.dataset.force;
      $('forceVal').textContent = o.dataset.force;
      saveConfig();
    });
    $('speedRange').addEventListener('input', () => {
      $('speedVal').textContent = $('speedRange').value;
      updateStats();
    });
    $('speedRange').addEventListener('change', saveConfig);
    $('forceRange').addEventListener('input', () => { $('forceVal').textContent = $('forceRange').value; });
    $('forceRange').addEventListener('change', saveConfig);
    $('dirSel').addEventListener('change', saveConfig);

    // 输出与走框预览
    $('btnPreview').addEventListener('click', previewAnim);
    $('btnCompile').addEventListener('click', doCompile);
    $('btnFrame')?.addEventListener('click', doFrame);
    $('btnSend').addEventListener('click', doSend);

    $('btnPause').addEventListener('click', async () => {
      const pausing = state.jobState !== 'paused';
      await api(pausing ? '/api/job/pause' : '/api/job/resume', { method: 'POST' });
    });
    $('btnStop').addEventListener('click', () => api('/api/job/stop', { method: 'POST' }));
    $('btnEstop').addEventListener('click', () => {
      if (confirm(t('btn.estopTitle'))) {
        api('/api/job/estop', { method: 'POST' });
        toast(t('toast.estopped'), 'err');
      }
    });

    $('btnCopyCode').addEventListener('click', async () => {
      if (!state.gcode) { toast(t('toast.needCompile'), 'err'); return; }
      try {
        await navigator.clipboard.writeText(state.gcode);
        toast(t('toast.copied'), 'ok');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = state.gcode;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast(t('toast.copied'), 'ok');
      }
    });
    $('btnSaveCode').addEventListener('click', () => {
      if (!state.gcode) { toast(t('toast.needCompile'), 'err'); return; }
      const blob = new Blob([state.gcode], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'plotter-' + Date.now() + '.plt';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    scanPorts();
    wirePad();
    wireTransformPanel();
    updateTransformPanel();
    renderLayerList();
  }

  async function saveConfig() {
    await api('/api/config', {
      method: 'POST',
      body: {
        defaultSpeed: +$('speedRange').value,
        defaultForce: +$('forceRange').value,
        direction: $('dirSel').value,
        lastMaterial: $('matSel').value,
      },
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- 手动控制
  async function sendManual(cmd, label) {
    if (!state.connected) { toast(t('toast.noDevice'), 'err'); return; }
    try {
      const r = await api('/api/manual', { method: 'POST', body: cmd });
      if (r.notes && r.notes.length) {
        const msg = r.notes.map((x) => pickLang(x)).join(lang() === 'en' ? '; ' : '；');
        logLine(msg, 'ok');
        if (label !== 'move') toast(msg, 'ok');
      }
    } catch (e) {
      logLine(t('log.manualFail', { msg: e.message }), 'err');
      toast(e.message, 'err');
    }
  }

  function updateKnifeCoordsDisplay() {
    const kRel = modelToOriginCoords(state.knifePos.x, state.knifePos.y);
    const oRel = modelToOriginCoords(state.userOrigin.x, state.userOrigin.y);
    if ($('knifePosVal')) {
      $('knifePosVal').textContent = `X: ${kRel.x.toFixed(1)}, Y: ${kRel.y.toFixed(1)} mm`;
    }
    if ($('userOriginVal')) {
      $('userOriginVal').textContent = `X: ${oRel.x.toFixed(1)}, Y: ${oRel.y.toFixed(1)} mm`;
    }
    renderer.knifePos = state.knifePos;
    renderer.userOrigin = state.userOrigin;
  }

  function wirePad() {
    const step = () => +$('stepMm').value || 5;

    document.querySelectorAll('.pad-key[data-dx]').forEach((key) => {
      let timer = null;
      let repeat = null;

      const moveOnce = (sign) => {
        const dx = +key.dataset.dx * step() * sign;
        const dy = +key.dataset.dy * step() * sign;
        state.knifePos.x = round1(state.knifePos.x + dx);
        state.knifePos.y = round1(state.knifePos.y + dy);
        updateKnifeCoordsDisplay();
        renderer.dirty = true;
        sendManual({ action: 'move', dx, dy, speed: 20 }, 'move');
      };

      key.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        key.setPointerCapture(e.pointerId);
        key.classList.add('pressed');
        const sign = e.shiftKey ? -1 : 1;
        moveOnce(sign);
        timer = setTimeout(() => { repeat = setInterval(() => moveOnce(sign), 90); }, 400);
      });

      const stop = () => {
        key.classList.remove('pressed');
        if (timer) { clearTimeout(timer); timer = null; }
        if (repeat) { clearInterval(repeat); repeat = null; }
      };
      key.addEventListener('pointerup', stop);
      key.addEventListener('pointercancel', stop);
      key.addEventListener('lostpointercapture', stop);
    });

    const center = document.querySelector('.pad-key.center');
    if (center) {
      center.addEventListener('click', () => {
        if (!state.connected) { toast(t('toast.noDevice'), 'err'); return; }
        if (!confirm(t('confirm.pendown'))) return;
        sendManual({ action: 'pendown' }, 'pendown');
      });
    }

    document.querySelectorAll('[data-manual]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.manual;
        if (action === 'setorigin') {
          if (!confirm(t('confirm.setorigin'))) return;
          state.userOrigin = { x: state.knifePos.x, y: state.knifePos.y };
          updateKnifeCoordsDisplay();
          updateTransformPanel();
          renderer.dirty = true;
          const oRel = modelToOriginCoords(state.userOrigin.x, state.userOrigin.y);
          toast(t('toast.originSet', { x: oRel.x.toFixed(1), y: oRel.y.toFixed(1) }), 'ok');
          sendManual({ action: 'setorigin', x: state.userOrigin.x, y: state.userOrigin.y }, action);
          return;
        }
        const cmd = { action };
        if (action === 'home' || action === 'end') {
          cmd.dx = round1(state.userOrigin.x - state.knifePos.x);
          cmd.dy = round1(state.userOrigin.y - state.knifePos.y);
          state.knifePos = { x: state.userOrigin.x, y: state.userOrigin.y };
          updateKnifeCoordsDisplay();
          renderer.dirty = true;
        }
        if (btn.dataset.dist) {
          const d = +btn.dataset.dist;
          cmd.distance = d;
          if (action === 'feed') state.knifePos.y = round1(state.knifePos.y + d);
          else if (action === 'eject') state.knifePos.y = round1(state.knifePos.y - d);
          updateKnifeCoordsDisplay();
          renderer.dirty = true;
        }
        sendManual(cmd, action);
      });
    });

    // 重置原点：恢复到当前机器的机械原点角点（例如右下角 (W, 0)）
    $('btnResetOrigin')?.addEventListener('click', () => {
      const mech = getMechOrigin();
      state.userOrigin = { ...mech };
      state.knifePos = { ...mech };
      updateKnifeCoordsDisplay();
      updateTransformPanel();
      renderer.dirty = true;
      toast(t('toast.originReset'), 'ok');
    });

    document.addEventListener('keydown', (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;

      const isCmdOrCtrl = e.ctrlKey || e.metaKey;
      if (isCmdOrCtrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (isCmdOrCtrl && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }

      if (isCmdOrCtrl && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        state.selectedIds = new Set(renderer.layers.filter((l) => !l.hidden).map((l) => l.id));
        state.selectedId = [...state.selectedIds][0] || null;
        renderer.selectedId = state.selectedId;
        renderer.selectedIds = state.selectedIds;
        renderer.dirty = true;
        renderLayerList();
        updateTransformPanel();
        return;
      }

      const isDeleteKey = e.key === 'Delete' || e.key === 'Backspace' ||
                          e.code === 'Delete' || e.code === 'Backspace' ||
                          e.keyCode === 8 || e.keyCode === 46;
      if (isDeleteKey) {
        if (state.selectedIds.size > 0 || state.selectedId) {
          e.preventDefault();
          deleteSelected();
          return;
        }
      }

      const map = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      if (!map[e.key]) return;
      e.preventDefault();
      const sign = e.shiftKey ? -1 : 1;
      const [dx, dy] = map[e.key];
      const stepVal = step() * sign;
      state.knifePos.x = round1(state.knifePos.x + dx * stepVal);
      state.knifePos.y = round1(state.knifePos.y + dy * stepVal);
      updateKnifeCoordsDisplay();
      renderer.dirty = true;
      sendManual({ action: 'move', dx: dx * stepVal, dy: dy * stepVal, speed: 20 }, 'move');
    });
  }

  // ---------------------------------------------------------------- 串口
  function emptyPortOption() {
    return `<option value="" data-i18n="port.none">${t('port.none')}</option>`;
  }

  async function scanPorts() {
    try {
      const r = await api('/api/serial-ports');
      const sel = $('portSel');
      const prev = sel.value;
      sel.innerHTML = '';
      cachedPorts = r.ports || [];
      const en = lang() === 'en';
      const hint = $('multiPortHint');

      if (!cachedPorts.length) {
        sel.innerHTML = emptyPortOption();
        logLine(t('log.portNone'), 'err');
        if (hint) hint.style.display = 'none';
        updateConnCardDisplay();
        return;
      }

      if (hint) {
        hint.style.display = cachedPorts.length > 1 ? 'block' : 'none';
      }

      cachedPorts.forEach((p, idx) => {
        const o = document.createElement('option');
        o.value = p.path;

        let chip = en ? (p.chipNameEn || p.chipName) : (p.chipNameZh || p.chipName);
        let detail = chip || p.product || '';
        if (p.manufacturer && !detail.includes(p.manufacturer)) {
          detail = `${p.manufacturer} ${detail}`.trim();
        }

        if (!detail) {
          if (p.path.includes('ttyUSB')) detail = t('port.serialAdapter');
          else if (p.path.includes('ttyACM')) detail = t('port.acmDevice');
        }

        const portNum = t('port.num', { n: idx + 1 });
        o.textContent = `[${portNum}] ${p.path}${detail ? ' — ' + detail : ''}`;
        sel.appendChild(o);
      });

      if (prev && cachedPorts.some((p) => p.path === prev)) {
        sel.value = prev;
      } else if (state.config?.serial?.path && cachedPorts.some((p) => p.path === state.config.serial.path)) {
        sel.value = state.config.serial.path;
      } else {
        const best = cachedPorts.find((p) => p.chipName || p.path.includes('ttyACM')) || cachedPorts[0];
        if (best) sel.value = best.path;
      }

      logLine(t('log.portFound', { n: cachedPorts.length }));
      updateConnCardDisplay();
    } catch (e) {
      logLine(t('log.scanFail', { msg: e.message }), 'err');
    }
  }

  async function doConnect() {
    const type = $('connType').value;
    const body = { type };
    if (type === 'serial') {
      const path = $('portSel').value;
      if (!path) { toast(t('toast.needPort'), 'err'); return; }
      const baud = +($('baudSel')?.value || 115200);
      Object.assign(body, { path, baud, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false });
    } else if (type === 'tcp') {
      Object.assign(body, { host: $('tcpHost').value, port: +$('tcpPort').value });
    }
    try {
      $('btnConnect').disabled = true;
      $('btnConnect').textContent = t('btn.connecting');
      const r = await api('/api/connect', { method: 'POST', body });
      const dev = (lang() === 'en' ? (r.device?.pathEn || r.device?.path) : r.device?.path) || type;
      toast(t('toast.connectOk', { dev }), 'ok');
      logLine(t('log.connectOk', { dev }), 'ok');
      await refreshState();
    } catch (e) {
      toast(t('toast.connectFail', { msg: e.message }), 'err');
      logLine(t('log.connectFail', { msg: e.message }), 'err');
    } finally {
      $('btnConnect').disabled = false;
      $('btnConnect').textContent = t('btn.connect');
    }
  }

  // ---------------------------------------------------------------- 文件
  async function importVectorContent(text, filename = 'vectorized.svg') {
    showLoading(t('loading.importing'));
    logLine(t('toast.parsing', { name: filename }));
    try {
      const r = await api('/api/import', {
        method: 'POST',
        body: { content: text, filename },
      });
      if (!r.path.subpaths.length) {
        toast(t('toast.noPath'), 'err');
        return;
      }
      pushHistory();
      let children = null;
      if (r.elements && r.elements.length > 1) {
        children = r.elements.map((elem) => ({
          name: elem.name,
          subpaths: structuredClone(elem.subpaths),
        }));
      } else if (r.path.subpaths.length > 1) {
        children = r.path.subpaths.map((sub, i) => ({
          name: `${filename} #${i + 1}`,
          subpaths: [structuredClone(sub)],
        }));
      }
      const isGroup = !!(children && children.length > 1);
      const layer = addLayer(filename, r.path, { isGroup, children });

      // 1. 若超出幅面则等比缩放到材料框内
      const bed = state.preset || { width: 600, height: 710 };
      const curBb = T.layerBBox(layer);
      const maxW = bed.width - 20;
      const maxH = bed.height - 20;
      if (curBb.w > maxW || curBb.h > maxH) {
        const sf = Math.min(maxW / Math.max(curBb.w, 1), maxH / Math.max(curBb.h, 1));
        T.scaleLayer(layer, sf, sf, curBb.minX, curBb.minY);
      }

      // 2. 自动贴靠到当前机器原点内侧 10mm 处（右下角原点机型即自动对齐到右下角，彻底避免 Y 轴先走 590mm）
      snapLayersToOrigin(layer, 10, 10);

      state.selectedId = layer.id;
      state.selectedIds = new Set([layer.id]);
      renderer.selectedId = layer.id;
      renderer.selectedIds = state.selectedIds;
      updateTransformPanel();
      toast(t('toast.imported', { name: filename }), 'ok');
      logLine(t('log.importOk', { n: r.path.subpaths.length, len: r.info.length.toFixed(0) }));
      for (const w of r.warnings || []) { logLine(t('log.notice', { msg: pickLang(w) || w })); }
      fitToContent();
      updateStats();
    } catch (err) {
      toast(t('toast.parseFail', { msg: err.message }), 'err');
      logLine(t('log.parseFail', { msg: err.message }), 'err');
    } finally {
      hideLoading();
    }
  }

  async function onFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      await importVectorContent(text, f.name);
    } finally {
      e.target.value = '';
    }
  }

  function loadDemo() {
    const CX = 315, CY = 220;
    const p = G.makePath();

    const frame = G.makeSubpath(60, 60);
    G.addLine(frame, 570, 60);
    G.addLine(frame, 570, 380);
    G.addLine(frame, 60, 380);
    frame.closed = true;
    p.subpaths.push(frame);

    const inner = G.makeSubpath(75, 75);
    G.addLine(inner, 555, 75);
    G.addLine(inner, 555, 365);
    G.addLine(inner, 75, 365);
    inner.closed = true;
    p.subpaths.push(inner);

    for (const sub of G.circleToPath(115, CY, 26).subpaths) p.subpaths.push(sub);
    for (const sub of G.circleToPath(515, CY, 26).subpaths) p.subpaths.push(sub);

    const div = G.makeSubpath(150, 165);
    G.addLine(div, 480, 165);
    p.subpaths.push(div);

    for (let i = 0; i < 11; i++) {
      for (const sub of G.circleToPath(235 + i * 16, 300, 5).subpaths) p.subpaths.push(sub);
    }

    const signLayer = addLayer(t('demo.sign'), p);

    fetch('/api/text-to-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'SPARKMINDS', sizeMm: 42, x: 137, y: 205 }),
    })
      .then((r) => r.json())
      .then((r) => {
        const layersToSnap = [signLayer];
        if (r.path) {
          const txtLayer = addLayer(t('layer.text', { text: 'SPARKMINDS' }), r.path);
          layersToSnap.push(txtLayer);
          logLine(t('toast.demoLoaded'));
        }
        snapLayersToOrigin(layersToSnap, 10, 10);
        fitToContent();
        updateTransformPanel();
        updateStats();
      });
  }

  // ---------------------------------------------------------------- 编译、走框预览与输出
  function buildItems() {
    return renderer.layers.filter((l) => !l.hidden).map((l) => ({
      id: l.id,
      subpaths: l.subpaths,
    }));
  }

  /**
   * 走框预览（巡边确认范围）：
   * 刀头保持抬刀状态（PU）沿当前图形的外接矩形走一圈并回到原点，
   * 同时在画布上高亮并动画演示走框轨迹。
   */
  async function doFrame() {
    const items = buildItems();
    if (!items.length) { toast(t('toast.emptyLayout'), 'err'); return; }
    try {
      if ($('btnFrame')) $('btnFrame').disabled = true;
      const r = await api('/api/frame', {
        method: 'POST',
        body: {
          items: items.map((i) => ({ path: { subpaths: i.subpaths } })),
          speed: +$('speedRange').value,
          origin: state.userOrigin || getMechOrigin(),
          originPosition: getOriginPos(),
          runNow: true,
        },
      });
      if (r.framePath) {
        renderer.startFrameAnim(r.framePath, r.bbox, r.originBBox, +$('speedRange').value);
      }
      const wStr = r.bbox ? r.bbox.w.toFixed(1) : '0';
      const hStr = r.bbox ? r.bbox.h.toFixed(1) : '0';
      const noteMsg = (r.notes && r.notes.length) ? pickLang(r.notes[0]) : `${wStr}×${hStr}mm`;
      if (r.sent) {
        $('jobPanel').style.display = 'block';
        toast(t('toast.frameSent', { w: wStr, h: hStr }), 'ok');
        logLine(t('log.frameSent', { msg: noteMsg }), 'ok');
      } else {
        toast(t('toast.framePreviewOnly', { w: wStr, h: hStr }), 'ok');
        logLine(t('log.framePreviewOnly', { msg: noteMsg }));
      }
    } catch (e) {
      toast(t('toast.frameFail', { msg: e.message }), 'err');
      logLine(t('toast.frameFail', { msg: e.message }), 'err');
    } finally {
      if ($('btnFrame')) $('btnFrame').disabled = renderer.layers.length === 0;
    }
  }

  async function doCompile() {
    const items = buildItems();
    if (!items.length) { toast(t('toast.emptyLayout'), 'err'); return; }
    showLoading(t('loading.compiling'));
    try {
      $('btnCompile').disabled = true;
      const r = await api('/api/compile', {
        method: 'POST',
        body: {
          items: items.map((i) => ({ path: { subpaths: i.subpaths } })),
          speed: +$('speedRange').value,
          force: +$('forceRange').value,
          direction: $('dirSel').value,
          origin: state.userOrigin || getMechOrigin(),
          originPosition: getOriginPos(),
        },
      });
      state.gcode = r.gcode;
      state.compiled = r;
      $('gcodeView').textContent = r.gcode.split('\n').slice(0, 200).join('\n');
      updateStats();

      const warnBox = $('compileWarn');
      warnBox.innerHTML = '';
      for (const w of r.warnings || []) {
        const d = document.createElement('div');
        d.className = 'notice notice-warn';
        d.textContent = pickLang(w) || w;
        warnBox.appendChild(d);
      }
      const kb = (r.bytes / 1024).toFixed(1);
      toast(t('toast.generated', { kb }), 'ok');
      logLine(t('log.compileDone', {
        n: r.commandCount, kb, time: fmtTime(r.estimate.wallSeconds * 1000),
      }));
    } catch (e) {
      toast(t('toast.compileFail', { msg: e.message }), 'err');
      logLine(t('toast.compileFail', { msg: e.message }), 'err');
    } finally {
      hideLoading();
      $('btnCompile').disabled = false;
    }
  }

  async function previewAnim() {
    const items = buildItems();
    if (!items.length) { toast(t('toast.emptyLayout'), 'err'); return; }
    try {
      const origin = state.userOrigin || getMechOrigin();
      const r = await api('/api/compile', {
        method: 'POST',
        body: {
          items: items.map((i) => ({ path: { subpaths: i.subpaths } })),
          speed: +$('speedRange').value,
          force: +$('forceRange').value,
          direction: $('dirSel').value,
          origin,
          originPosition: getOriginPos(),
        },
      });
      const back = await api('/api/preview', {
        method: 'POST',
        body: { gcode: r.gcode, origin },
      });
      const merged = { subpaths: back.path.subpaths };
      renderer.startAnim(merged, +$('speedRange').value);
      renderer.onAnimEnd = () => { logLine(t('log.previewDone')); };
      toast(t('toast.previewStart'));
    } catch (e) { toast(t('toast.previewFail', { msg: e.message }), 'err'); }
  }

  // ---------------------------------------------------------------- 历史任务与模板归档
  let cachedHistoryList = [];

  function generateLayersThumbnailSvg(layers) {
    if (!layers || !layers.length) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 75" class="thumb-empty"><rect width="100" height="75" fill="#f1f5f9" rx="6"/><text x="50" y="42" text-anchor="middle" fill="#94a3b8" font-size="12">空</text></svg>';
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const allSubs = [];
    for (const layer of layers) {
      if (layer.hidden) continue;
      for (const sub of (layer.subpaths || [])) {
        if (!sub.start) continue;
        allSubs.push(sub);
        if (sub.start.x < minX) minX = sub.start.x;
        if (sub.start.y < minY) minY = sub.start.y;
        if (sub.start.x > maxX) maxX = sub.start.x;
        if (sub.start.y > maxY) maxY = sub.start.y;
        for (const el of (sub.elems || [])) {
          if (el.type === 'line') {
            if (el.x2 < minX) minX = el.x2;
            if (el.y2 < minY) minY = el.y2;
            if (el.x2 > maxX) maxX = el.x2;
            if (el.y2 > maxY) maxY = el.y2;
          } else if (el.type === 'arc') {
            const rad = (el.a1 * Math.PI) / 180;
            const ex = el.cx + el.r * Math.cos(rad);
            const ey = el.cy + el.r * Math.sin(rad);
            if (ex < minX) minX = ex;
            if (ey < minY) minY = ey;
            if (ex > maxX) maxX = ex;
            if (ey > maxY) maxY = ey;
          }
        }
      }
    }

    if (!isFinite(minX) || !allSubs.length) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 75" class="thumb-empty"><rect width="100" height="75" fill="#f1f5f9" rx="6"/><text x="50" y="42" text-anchor="middle" fill="#94a3b8" font-size="12">空</text></svg>';
    }

    const spanX = Math.max(1e-4, maxX - minX);
    const spanY = Math.max(1e-4, maxY - minY);
    const maxSpan = Math.max(spanX, spanY);
    const minStep = maxSpan / 250;
    const minStepSq = minStep * minStep;

    const maxSubs = 600;
    const subStride = allSubs.length > maxSubs ? Math.ceil(allSubs.length / maxSubs) : 1;

    const pathsD = [];
    let totalSegments = 0;
    const MAX_SEGMENTS = 1500;

    for (let i = 0; i < allSubs.length; i += subStride) {
      if (totalSegments >= MAX_SEGMENTS) break;
      const sub = allSubs[i];
      if (!sub.start) continue;

      let d = `M ${sub.start.x.toFixed(1)} ${sub.start.y.toFixed(1)} `;
      let lastX = sub.start.x;
      let lastY = sub.start.y;
      const elems = sub.elems || [];

      for (let j = 0; j < elems.length; j++) {
        if (totalSegments >= MAX_SEGMENTS) break;
        const el = elems[j];
        if (el.type === 'line') {
          const isLast = (j === elems.length - 1);
          const dx = el.x2 - lastX;
          const dy = el.y2 - lastY;
          if (!isLast && (dx * dx + dy * dy < minStepSq)) {
            continue;
          }
          d += `L ${el.x2.toFixed(1)} ${el.y2.toFixed(1)} `;
          lastX = el.x2;
          lastY = el.y2;
          totalSegments++;
        } else if (el.type === 'arc') {
          const rad = (el.a1 * Math.PI) / 180;
          const ex = el.cx + el.r * Math.cos(rad);
          const ey = el.cy + el.r * Math.sin(rad);
          const large = Math.abs(el.a1 - el.a0) > 180 ? 1 : 0;
          const sweep = el.a1 > el.a0 ? 1 : 0;
          d += `A ${el.r.toFixed(1)} ${el.r.toFixed(1)} 0 ${large} ${sweep} ${ex.toFixed(1)} ${ey.toFixed(1)} `;
          lastX = ex;
          lastY = ey;
          totalSegments++;
        }
      }

      if (sub.closed) d += 'Z ';
      pathsD.push(d);
    }

    const pad = maxSpan * 0.08 || 2;
    const vbX = minX - pad;
    const vbY = minY - pad;
    const vbW = Math.max(1, spanX + pad * 2);
    const vbH = Math.max(1, spanY + pad * 2);

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" class="history-svg" preserveAspectRatio="xMidYMid meet"><g transform="scale(1, -1) translate(0, ${-(vbY * 2 + vbH).toFixed(1)})" stroke="#2563eb" stroke-width="${(vbW * 0.015).toFixed(2)}" fill="none" stroke-linecap="round" stroke-linejoin="round">${pathsD.map((p) => `<path d="${p}"/>`).join('')}</g></svg>`;
  }

  async function openHistoryModal() {
    const modal = $('historyModal');
    if (!modal) return;
    modal.style.display = 'grid';
    await refreshHistoryList();
  }

  function closeHistoryModal() {
    const modal = $('historyModal');
    if (modal) modal.style.display = 'none';
  }

  async function refreshHistoryList() {
    try {
      const res = await api('/api/history');
      cachedHistoryList = res.history || [];
      const badge = $('historyCount');
      if (badge) badge.textContent = cachedHistoryList.length;
      renderHistoryItems(cachedHistoryList);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function renderHistoryItems(items) {
    const wrap = $('historyListWrap');
    if (!wrap) return;
    wrap.innerHTML = '';

    const filter = ($('historySearchInput')?.value || '').trim().toLowerCase();
    const filtered = filter
      ? items.filter((h) => (h.name || '').toLowerCase().includes(filter) || (h.materialId || '').toLowerCase().includes(filter) || (h.machineId || '').toLowerCase().includes(filter))
      : items;

    if (!filtered.length) {
      wrap.innerHTML = `<div class="history-empty">${t('history.empty')}</div>`;
      return;
    }

    const en = lang() === 'en';
    for (const item of filtered) {
      const card = document.createElement('div');
      card.className = 'history-card';
      const timeStr = new Date(item.createdAt).toLocaleString(en ? 'en-GB' : 'zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      });

      const preset = state.presets[item.machineId];
      const machName = preset ? (en ? (preset.nameEn || preset.name) : preset.name) : item.machineId;
      const mat = state.materials.find((m) => m.id === item.materialId);
      const matName = mat ? (en ? (mat.nameEn || mat.name) : mat.name) : (item.materialId || t('history.defaultMat'));

      const cutLenMm = item.stats?.cutLengthMm || 0;
      const cutStr = cutLenMm > 1000 ? (cutLenMm / 1000).toFixed(2) + 'm' : Math.round(cutLenMm) + 'mm';
      const durSec = item.stats?.totalSeconds || 0;
      const timeEstStr = fmtTime(durSec * 1000);

      const thumbSvg = item.thumbnailSvg || `<svg viewBox="0 0 100 75"><rect width="100" height="75" fill="#f8fafc" rx="4"/><text x="50" y="42" text-anchor="middle" fill="#cbd5e1" font-size="11">预览</text></svg>`;

      card.innerHTML = `
        <div class="history-thumb">${thumbSvg}</div>
        <div class="history-info">
          <div class="history-title-row">
            <span class="history-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="history-time">${timeStr}</span>
          </div>
          <div class="history-tags">
            <span class="history-tag highlight">${escapeHtml(matName)}</span>
            <span class="history-tag">${item.speed} mm/s</span>
            <span class="history-tag">${item.force} g</span>
            <span class="history-tag">${escapeHtml(machName)}</span>
          </div>
          <div class="history-meta">
            ${t('history.meta', { layers: item.layerCount || 1, cut: cutStr, time: timeEstStr })}
          </div>
        </div>
        <div class="history-actions">
          <button class="btn btn-sm" data-act="load" data-id="${item.id}">${t('history.load')}</button>
          <button class="btn btn-sm btn-ok" data-act="recut" data-id="${item.id}">${t('history.recut')}</button>
          <button class="btn btn-sm btn-danger btn-icon" data-act="del" data-id="${item.id}" title="${t('history.del')}">×</button>
        </div>
      `;

      card.querySelector('[data-act=load]').addEventListener('click', () => loadHistoryJob(item.id));
      card.querySelector('[data-act=recut]').addEventListener('click', () => recutHistoryJob(item.id));
      card.querySelector('[data-act=del]').addEventListener('click', () => deleteHistoryJob(item.id));

      wrap.appendChild(card);
    }
  }

  async function loadHistoryJob(id) {
    try {
      showLoading(t('loading.importing'));
      const full = await api('/api/history?id=' + encodeURIComponent(id));
      if (!full || !full.layers) throw new Error(t('history.incomplete'));

      pushHistory();

      renderer.layers = structuredClone(full.layers);
      if (full.machineId && state.presets[full.machineId]) {
        $('machineSel').value = full.machineId;
        state.config.machineId = full.machineId;
        state.preset = state.presets[full.machineId];
        renderer.setPreset(state.preset, getOriginPos(state.preset));
      }
      const mech = getMechOrigin();
      if (full.userOrigin && (full.userOrigin.x !== 0 || full.userOrigin.y !== 0)) {
        state.userOrigin = { ...full.userOrigin };
      } else {
        state.userOrigin = { ...mech };
      }
      updateKnifeCoordsDisplay();

      if (full.materialId) {
        $('matSel').value = full.materialId;
        state.config.lastMaterial = full.materialId;
      }
      if (full.speed !== undefined) {
        $('speedRange').value = full.speed;
        $('speedVal').textContent = full.speed;
        state.config.defaultSpeed = full.speed;
      }
      if (full.force !== undefined) {
        $('forceRange').value = full.force;
        $('forceVal').textContent = full.force;
        state.config.defaultForce = full.force;
      }
      if (full.direction) {
        $('dirSel').value = full.direction;
        state.config.direction = full.direction;
      }

      state.selectedId = null;
      state.selectedIds = new Set();
      renderer.selectedId = null;
      renderer.selectedIds = state.selectedIds;
      renderer.dirty = true;

      renderLayerList();
      updateTransformPanel();
      updateStats();
      fitToContent();
      closeHistoryModal();

      toast(t('history.loaded'), 'ok');
      logLine(`${t('history.loaded')}：${full.name}`);
      return full;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    } finally {
      hideLoading();
    }
  }

  async function recutHistoryJob(id) {
    const full = await loadHistoryJob(id);
    if (!full) return;

    const en = lang() === 'en';
    const mat = state.materials.find((m) => m.id === full.materialId);
    const matName = mat ? (en ? (mat.nameEn || mat.name) : mat.name) : (full.materialId || '');

    const ok = confirm(t('history.recutConfirm', {
      name: full.name,
      mat: matName,
      speed: full.speed,
      force: full.force,
    }));
    if (!ok) return;

    await doCompile();
    await doSend();
  }

  async function deleteHistoryJob(id) {
    if (!confirm(t('history.delConfirm'))) return;
    try {
      await api('/api/history?id=' + encodeURIComponent(id), { method: 'DELETE' });
      toast(t('history.deleted'), 'ok');
      await refreshHistoryList();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function clearAllHistory() {
    if (!confirm(t('history.clearConfirm'))) return;
    try {
      await api('/api/history?id=all', { method: 'DELETE' });
      toast(t('history.cleared'), 'ok');
      await refreshHistoryList();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function saveCurrentAsTemplate() {
    if (!renderer.layers.length) {
      toast(t('toast.emptyLayout'), 'err');
      return;
    }
    const en = lang() === 'en';
    const defaultName = `${t('history.defaultTpl')} ${new Date().toLocaleTimeString(en ? 'en-GB' : 'zh-CN', { hour12: false })}`;
    const name = prompt(t('history.promptName'), defaultName);
    if (!name) return;

    showLoading(t('history.saving'));
    try {
      const thumb = generateLayersThumbnailSvg(renderer.layers);
      const entry = {
        name,
        layers: structuredClone(renderer.layers),
        userOrigin: { ...state.userOrigin },
        machineId: state.config?.machineId,
        materialId: $('matSel')?.value || state.config?.lastMaterial,
        speed: +$('speedRange').value,
        force: +$('forceRange').value,
        direction: $('dirSel').value,
        optimize: state.config?.optimize !== false,
        stats: {
          layerCount: renderer.layers.length,
          subpathCount: renderer.layers.reduce((a, l) => a + (l.subpaths?.length || 0), 0),
          cutLengthMm: totalLength(),
          rapidLengthMm: 0,
          totalSeconds: 0,
          bytes: 0,
        },
        thumbnailSvg: thumb,
      };
      await api('/api/history', { method: 'POST', body: entry });
      toast(t('history.saved'), 'ok');
      await refreshHistoryList();
    } catch (e) {
      console.error('save history error:', e);
      toast(t('history.saveFail', { msg: e.message || '' }), 'err');
    } finally {
      hideLoading();
    }
  }

  async function doSend() {
    if (!state.gcode) {
      toast(t('toast.compileFirst'), 'err');
      return;
    }
    if (!state.connected) {
      toast(t('toast.noDevice'), 'err');
      return;
    }
    const items = buildItems();
    if (items.length > 1 && !confirm(t('confirm.multi', { n: items.length }))) return;
    if (!confirm(t('confirm.go'))) return;

    const jobName = t('job.name', { n: items.length });
    const thumbnailSvg = generateLayersThumbnailSvg(renderer.layers);

    const archive = {
      name: jobName,
      layers: structuredClone(renderer.layers),
      userOrigin: { ...state.userOrigin },
      machineId: state.config?.machineId,
      materialId: $('matSel')?.value || state.config?.lastMaterial,
      speed: +$('speedRange').value,
      force: +$('forceRange').value,
      direction: $('dirSel').value,
      optimize: state.config?.optimize !== false,
      stats: {
        layerCount: renderer.layers.length,
        subpathCount: renderer.layers.reduce((a, l) => a + (l.subpaths?.length || 0), 0),
        cutLengthMm: state.compiled?.estimate?.cutLengthMm || totalLength(),
        rapidLengthMm: state.compiled?.estimate?.rapidLengthMm || 0,
        totalSeconds: state.compiled?.estimate?.totalSeconds || 0,
        bytes: state.gcode.length,
      },
      thumbnailSvg,
    };

    try {
      await api('/api/send', {
        method: 'POST',
        body: {
          gcode: state.gcode,
          name: jobName,
          estimate: state.compiled?.estimate,
          speed: +$('speedRange').value,
          archive,
        },
      });
      $('jobPanel').style.display = 'block';
      toast(t('toast.outputStarted'), 'ok');
      logLine(t('log.outputStart'));
    } catch (e) {
      toast(t('toast.outputFail', { msg: e.message }), 'err');
    }
  }

  // ---------------------------------------------------------------- 启动
  boot().catch((e) => {
    logLine(t('log.initFail', { msg: e.message }), 'err');
    toast(t('toast.bootFail'), 'err');
  });
