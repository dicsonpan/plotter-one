/**
 * 主应用逻辑。
 * 免构建、无框架——RK3399 上不需要跑 npm build，部署就是拷贝文件。
 */

import * as G from '../geom.js';
import { Renderer } from './render.js';
import * as T from './transform.js';
import { t, lang, initLang, setLang, onLangChange } from './i18n.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const renderer = new Renderer(canvas);
// 调试钩子：浏览器控制台里可用 __plotter.renderer / __probe.T 查状态
if (typeof window !== 'undefined') {
  window.__plotter = { renderer, get state() { return state; } };
  window.__probe = { T, G };
}

  const state = {
    config: null,
    preset: null,
    presets: {},
    materials: [],
    connected: false,
    gcode: '',
    ws: null,
    jobState: 'idle',
    compiled: null,
    selectedId: null,
    selectedIds: new Set(),
    knifePos: { x: 0, y: 0 },
    userOrigin: { x: 0, y: 0 },
  };

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
    // 变量名别叫 t —— 模块顶层的 t() 是取词函数，被局部变量遮蔽后
    // 这个函数里就再也调不到它了（而且不报错，只是 logLine 里全部取不到词）。
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
      // 服务端把中文放在 error（既有契约）、英文挂在 errorEn。
      // 这里按语言挑；都没有才退回状态码文案。
      const msg = (lang() === 'en' ? (data.errorEn || data.error) : data.error);
      throw new Error(msg || t('srv.httpFail', { code: res.status }));
    }
    return data;
  }

  // ---------------------------------------------------------------- 初始化
  async function boot() {
    // 关键：模块脚本在 DOM 解析完成前就会执行，此时父容器可能还没布局，
    // getBoundingClientRect 会返回 0。必须等布局就绪再量画布。
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    // 再等一帧，确保 grid 布局已生效
    await new Promise((r) => requestAnimationFrame(r));

    // 语言必须在任何渲染之前定下来：静态文案靠 applyI18n 刷，
    // 动态文案（统计、状态、下拉）则由下面的 onLangChange 回调重刷。
    initLang();

    renderer.resize();
    if (!renderer.vw) renderer.resize();
    renderer.fit();
    wireCanvas();
    wireUI();
    // 切语言后要重画一切动态文案。只刷 HTML 会出现
    // 「按钮已是英文、统计数字还是中文」的半截状态，比不切还让人困惑。
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

  async function refreshState() {
    try {
      const s = await api('/api/state');
      state.config = s.config;
      state.preset = s.preset;
      state.presets = s.presets;
      state.materials = s.materials;
      state.connected = s.device.connected;

      // 机器下拉。nameEn 由服务端一并下发，避免在前端再维护一份机型名对照表——
      // 两份表必然会漂移，改了一处忘了另一处，界面就会显示错型号（且不报错）。
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
      // 下拉框同理：聚焦时不回写，否则用户正打开着选项就被刷掉
      if (document.activeElement !== sel) sel.value = s.config.machineId;
      renderer.setPreset(s.preset);
      renderer.dirty = true;

      // 材料下拉（nameEn 同样由服务端下发，理由同机器下拉）
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
        // 恢复上次选择的材料。若配置里的速度/刀压与该预设一致（说明用户没手动改过），
        // 就把滑块也归位到预设值；否则保留用户的手动设置——
        // 否则会出现「下拉写着 3mm 亚克力、滑块却是薄纸参数」这种自相矛盾。
        const lastId = s.config.lastMaterial || s.materials[0].id;
        ms.value = lastId;
        const sel = ms.selectedOptions[0];
        if (sel && +sel.dataset.speed === +s.config.defaultSpeed
                   && +sel.dataset.force === +s.config.defaultForce) {
          $('speedRange').value = sel.dataset.speed;
          $('speedVal').textContent = sel.dataset.speed;
          $('forceRange').value = sel.dataset.force;
          $('forceVal').textContent = sel.dataset.force;
        }
      }

      // 滑块与走刀方向：只在用户没有正在操作时同步。
      // refreshState 每 5 秒跑一次，无条件回写会把「正在拖动」的滑块拽回去，
      // 手感很差（拖到一半跳回去）。聚焦中或正在拖动时一律不动。
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

      // 更新折叠卡片连接状态
      const dot = $('connCardDot');
      const title = $('connCardTitle');
      const sub = $('connCardSub');
      if (dot && title && sub) {
        if (s.device.connected) {
          dot.className = 'conn-dot on';
          title.textContent = `${s.preset.name} · ${t('dev.connectedSub')}`;
          sub.textContent = s.device.info?.path || t('btn.connected');
        } else {
          dot.className = 'conn-dot';
          title.textContent = t('dev.autoConn');
          sub.textContent = t('dev.autoConnSub');
        }
      }

      // 手动控制只有连上机器才有意义，未连接时置灰。
      // .pad-key 是 button，disabled 有效；用 class 让样式一起变灰。
      const padOff = !s.device.connected;
      document.querySelectorAll('[data-manual]').forEach((b) => { b.disabled = padOff; });
      document.querySelectorAll('.pad-key').forEach((b) => { b.disabled = padOff; b.classList.toggle('off', padOff); });

      // 地址由 t() 内部替换 {{host}}，不写死 IP——换网络时提示才准确
      $('qrHint').innerHTML = t('srv.qrHint') + `<br>${t('srv.qrHint2')}`;

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
      // 服务端日志同时带两种语言，按当前语言取。
      // 回退到 line 是为了兼容旧服务端（只发单语）时不至于显示空白。
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

  /**
   * 从服务端消息里取当前语言的那一份。
   *
   * 服务端对每条面向用户的文案都同时下发中英两份，字段名有两套约定：
   *   - 日志 / 警告：`{ zh, en }`（还有 `line` 兼容旧前端）
   *   - meta.note：`{ note, noteEn }`（note 是既有字段，保留中文语义）
   * 两种都支持，取不到就返回空串由调用方决定兜底——
   * 宁可少显示，也不要给用户一串 undefined。
   */
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
    renderer.setPreset(s.preset);
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
    // 按钮文案不能靠 data-i18n 自动刷：它是按状态动态切换的，
    // 必须每次进这里都重设一遍，否则切语言后会与当前状态不符
    // （比如暂停中却显示英文「Pause」）。
    if (s.state === 'idle') { $('btnPause').textContent = t('btn.pause'); }
    if (s.state === 'paused') { $('btnPause').textContent = t('btn.resume'); }
    if (s.state === 'running') { $('btnPause').textContent = t('btn.pause'); }
    if (s.state === 'done') { fill.style.width = '100%'; }
    refreshState();
  }

  /** 毫秒 → 「1分 20秒」/「1m 20s」这类可读时长 */
  function fmtTime(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return t('time.sec', { n: s });
    const m = Math.floor(s / 60);
    if (m < 60) return t('time.minSec', { m, s: s % 60 });
    return t('time.hourMin', { h: Math.floor(m / 60), m: m % 60 });
  }

  // ---------------------------------------------------------------- 画布交互
  // 交互手感常量。全部「慢」是刻字场景的合理默认：
  // 刻字机一旦启动不好停，预览时看不清、抓不住比操作慢更麻烦。
  const TUNING = {
    zoomStep: 1.06,        // 滚轮每格缩放 6%（原来 12%，太快看不清过程）
    panKeyStep: 40,       // 方向键平移像素（原来 100）
    dragThreshold: 4,     // 超过这个位移才算拖拽，否则算点击选择
    pinchMin: 1.01,       // 触屏双指缩放的最小步进
  };

  function wireCanvas() {
    // mode: null | 'pan' | 'move' | 'scale' | 'rotate'
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

      // 平移：中键 / 平移工具 / 空格 / 右键 —— 不碰图形
      if (renderer.tool === 'pan' || e.button === 1 || e.button === 2 || e.shiftKey) {
        mode = 'pan';
        canvas.style.cursor = 'grabbing';
        return;
      }

      // 优先看是否抓到控制点（在图形之上）
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

      // 否则尝试选中并拖动图形
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
        mode = 'pan';   // 空白处拖动 = 平移画布
      }
      renderer.dirty = true;
      renderLayerList();
      updateTransformPanel();
    });

    let dragStartRecorded = false;

    canvas.addEventListener('pointermove', (e) => {
      const p = localPos(e);
      const dx = e.clientX - lastX, dy = e.clientY - lastY;

      // 悬停提示：让用户知道哪里能抓
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
        // 抓住哪个角，就让那一侧跟着鼠标走：
        //   nw（左上）→ 往右下拖 = 变小；往左上拖 = 变大
        //   se（右下）→ 往右下拖 = 变大
        // 屏幕 Y 向下、模型 Y 向上，纵向符号与横向相反。
        const sx0 = (c === 'nw' || c === 'sw') ? -dxPx : dxPx;
        const sy0 = (c === 'sw' || c === 'se') ? dyPx : -dyPx;
        let fx = 1 + sx0 / (renderer.scale * w0);
        let fy = 1 + sy0 / (renderer.scale * h0);
        if (e.shiftKey) { const s = Math.max(fx, fy); fx = fy = s; }   // 锁定比例
        if (fx < 0.05) fx = 0.05;
        if (fy < 0.05) fy = 0.05;
        // 每次从起始快照重算，否则增量累积会漂
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
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;   // Shift 吸 15°
        dragLayer.subpaths = structuredClone(rotateStart.subpaths);
        T.rotateLayer(dragLayer, deg, rotateStart.cx, rotateStart.cy);
        renderer.dirty = true;
        updateTransformPanel();
      }

      lastX = e.clientX; lastY = e.clientY;
    });

    const endDrag = () => {
      if (mode === 'move' && dragLayer) {
        // 拖完把图形收回材料框内，避免移到外面刻不到
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

    // 触屏双指缩放
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
      // 视口尺寸变了，缩放比例要跟着重算，否则内容会跑出画面
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

  /** 让视图框住所有内容。首次加内容时调用，否则用户会看到空白画布。 */
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
    // 内容与材料框取并集：既要看清图形，也要看到机器边界。
    // 但材料框常常远大于内容（630mm 幅面上放一块 300mm 的牌子），
    // 若直接按并集算缩放，内容会缩成一小团。所以：
    // 缩放按「并集」算（保证都能看见），偏移按「内容中心」算（保证主体居中）。
    const boxMinX = Math.min(0, minX), boxMinY = Math.min(0, minY);
    const boxMaxX = Math.max(preset.width, maxX), boxMaxY = Math.max(preset.height, maxY);

    // 视口尺寸必须有效。Renderer.resize() 在父容器未布局时会保留旧值，
    // 这里若拿到 0 就会算出 Infinity/NaN，坐标全部落到画布外——画布一片空白。
    let { vw, vh } = renderer;
    if (!vw || !vh) {
      renderer.resize();
      vw = renderer.vw || 1;
      vh = renderer.vh || 1;
    }

    // 缩放：取「内容」与「材料框」中较小的那套，让内容尽量放大看得清
    const pad = 28;
    const scaleContent = Math.min(
      (vw - pad * 2) / Math.max(1, maxX - minX),
      (vh - pad * 2) / Math.max(1, maxY - minY)
    );
    const scaleBed = Math.min(
      (vw - pad * 2) / Math.max(1, boxMaxX - boxMinX),
      (vh - pad * 2) / Math.max(1, boxMaxY - boxMinY)
    );
    // 内容很小就按内容放大（并留一点余量让材料框可见），很大就按内容缩
    renderer.scale = Math.max(0.2, scaleContent > scaleBed * 2.2 ? scaleContent * 0.9 : scaleBed);

    // 偏移按材料框中心，保证机器边界和内容一起居中
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

  function ungroupLayer(layer) {
    if (!layer) return;
    const idx = renderer.layers.indexOf(layer);
    if (idx === -1) return;
    let newLayers = [];
    if (layer.children && layer.children.length > 0) {
      newLayers = layer.children.map((child, i) => ({
        id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6) + '_' + i,
        name: child.name || `${layer.name} #${i + 1}`,
        subpaths: structuredClone(child.subpaths),
        hidden: false,
        isGroup: !!child.isGroup,
        children: child.children ? structuredClone(child.children) : null,
      }));
    } else if (layer.subpaths.length > 1) {
      newLayers = layer.subpaths.map((sub, i) => ({
        id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6) + '_' + i,
        name: `${layer.name} #${i + 1}`,
        subpaths: [structuredClone(sub)],
        hidden: false,
        isGroup: false,
        children: null,
      }));
    }
    if (newLayers.length <= 1) return;
    pushHistory();
    renderer.layers.splice(idx, 1, ...newLayers);
    state.selectedIds = new Set([newLayers[0].id]);
    state.selectedId = newLayers[0].id;
    renderer.selectedId = state.selectedId;
    renderer.selectedIds = state.selectedIds;
    renderer.dirty = true;
    renderLayerList();
    updateTransformPanel();
    updateStats();
    toast(t('toast.ungrouped', { n: newLayers.length }), 'ok');
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
  const selectedLayer = () => renderer.layers.find((l) => l.id === state.selectedId) || null;
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
    const copies = toDup.map((l) => {
      const copy = T.duplicateLayer(l);
      copy.name = t('prop.copySuffix', { name: l.name });
      T.translateLayer(copy, 10, -10);
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

    // 用户正在输入时不要回写，否则打字打到一半被冲掉
    if (document.activeElement !== $('propX')) $('propX').value = round1(bb.minX);
    if (document.activeElement !== $('propY')) $('propY').value = round1(bb.minY);
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

  function afterTransform(layer) {
    renderer.dirty = true;
    updateTransformPanel();
    updateStats();
    renderLayerList();
  }

  function wireTransformPanel() {
    // 坐标：把包围盒左上角挪到指定位置
    const applyXY = () => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      if (!selected.length) return;
      pushHistory();
      let bb;
      if (selected.length > 1) {
        let minX = Infinity, minY = Infinity;
        for (const l of selected) {
          const b = T.layerBBox(l);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
        }
        bb = { minX, minY };
      } else {
        bb = T.layerBBox(selected[0]);
      }
      const targetX = +$('propX').value || 0;
      const targetY = +$('propY').value || 0;
      const dx = targetX - bb.minX;
      const dy = targetY - bb.minY;
      for (const l of selected) {
        T.translateLayer(l, dx, dy);
      }
      afterTransform(selected[0]);
    };
    $('propX').addEventListener('change', applyXY);
    $('propY').addEventListener('change', applyXY);

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
      afterTransform(selected[0]);
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
        afterTransform(selected[0]);
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
      afterTransform(selected[0]);
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
        if (a === 'left') dx = 2 - allBb.minX;
        else if (a === 'right') dx = (bed.width - 2) - allBb.maxX;
        else if (a === 'hcenter') dx = bed.width / 2 - allBb.cx;
        else if (a === 'bottom') dy = 2 - allBb.minY;
        else if (a === 'top') dy = (bed.height - 2) - allBb.maxY;
        else if (a === 'vcenter') dy = bed.height / 2 - allBb.cy;
        for (const l of selected) {
          T.translateLayer(l, round1(dx), round1(dy));
        }
        afterTransform(selected[0]);
      });
    });

    // 翻转（镜像）：水平镜像与垂直镜像
    $('btnFlipX').addEventListener('click', () => flipSelected(true));
    $('btnFlipY').addEventListener('click', () => flipSelected(false));

    $('btnDupLayer').addEventListener('click', duplicateSelected);
    $('btnFrontLayer').addEventListener('click', () => {
      const selected = renderer.layers.filter((l) => state.selectedIds.has(l.id) || l.id === state.selectedId);
      if (!selected.length) return;
      pushHistory();
      renderer.layers = renderer.layers.filter((x) => !selected.includes(x)).concat(selected);
      afterTransform(selected[0]);
    });

    $('btnDelLayer').addEventListener('click', deleteSelected);

    $('btnGroup')?.addEventListener('click', groupSelectedLayers);
    $('btnUngroup')?.addEventListener('click', ungroupSelectedLayers);
  }
  // ---------------------------------------------------------------- UI 绑定
  function wireUI() {
    // 移动端标签
    document.querySelectorAll('.mtab').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.mtab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        const p = b.dataset.panel;
        $('panelLeft').classList.toggle('show', p === 'left');
        $('panelRight').classList.toggle('show', p === 'right');
        if (p === 'none') {
          // 侧栏收起后画布变宽，必须重算缩放，否则内容会偏在一侧
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
      const el = $('connDetails');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    };
    $('btnToggleConn')?.addEventListener('click', toggleConn);
    $('connCard')?.addEventListener('click', toggleConn);

    // 导入
    $('btnImportFile').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', onFile);
    $('btnImportDemo').addEventListener('click', loadDemo);
    $('btnOpenHistory')?.addEventListener('click', openHistoryModal);
    $('btnHistory')?.addEventListener('click', openHistoryModal);
    $('btnCloseHistory')?.addEventListener('click', closeHistoryModal);
    $('btnCloseHistoryFoot')?.addEventListener('click', closeHistoryModal);
    $('btnClearHistory')?.addEventListener('click', clearAllHistory);
    $('btnSaveCurrentTpl')?.addEventListener('click', saveCurrentAsTemplate);
    $('historySearchInput')?.addEventListener('input', () => renderHistoryItems(cachedHistoryList));

    // 文字
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
            x: +$('txtX').value,
            y: +$('txtY').value,
          },
        });
        addLayer(t('layer.text', { text: text.slice(0, 8) }), r.path);
        // 服务端 note 也是双语的（meta.noteZh / meta.noteEn）
        const note = pickLang(r.path.meta?.note);
        toast(note || t('toast.added'), r.path.meta?.unsupported?.length ? 'err' : 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // 图形
    $('btnAddShape').addEventListener('click', async () => {
      const type = $('shpType').value;
      const size = +$('shpSize').value;
      const p = state.preset || { width: 630, height: 710 };
      const cx = p.width / 2, cy = p.height / 2;
      const body = { type, x: cx - size / 2, y: cy - size / 2, w: size, h: size, r: size / 2, rx: size / 2, ry: size / 3, x1: cx - size / 2, y1: cy, x2: cx + size / 2, y2: cy };
      try {
        const r = await api('/api/geometry', { method: 'POST', body: { items: [body] } });
        // 形状名直接用下拉项自己的文案，所见即所得
        addLayer($('shpType').selectedOptions[0].textContent, r.path);
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

    // 语言切换。setLang 内部会：刷 HTML 静态文案 → 触发 onLangChange 回调
    // → 回调里重刷动态文案与画布。所以这里不用自己做任何刷新动作。
    $('btnLang').addEventListener('click', () => {
      setLang(lang() === 'zh' ? 'en' : 'zh');
    });

    $('machineSel').addEventListener('change', async () => {
      await api('/api/config', { method: 'POST', body: { machineId: $('machineSel').value } });
      toast(t('toast.machineChanged'));
      refreshState();
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

    // 输出
    $('btnPreview').addEventListener('click', previewAnim);
    $('btnCompile').addEventListener('click', doCompile);
    $('btnSend').addEventListener('click', doSend);

    $('btnPause').addEventListener('click', async () => {
      // ⚠️ 判据必须用 state.jobState，**不能**比按钮文案。
      // 按钮文案会随语言变化（中文「暂停」/ 英文「Pause」），
      // 拿文案判状态在英文下必然失效——症状是「点了没反应」或「暂停/继续反了」。
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
  /**
   * 发送一条手动控制指令。
   * 所有手动动作都走后端队列而非前端直写串口：
   * 这样能限速、能看日志、并且急停依然有效——不能有绕过急停的路径。
   */
  async function sendManual(cmd, label) {
    if (!state.connected) { toast(t('toast.noDevice'), 'err'); return; }
    try {
      const r = await api('/api/manual', { method: 'POST', body: cmd });
      if (r.notes && r.notes.length) {
        logLine(r.notes.map((x) => pickLang(x)).join(lang() === 'en' ? '; ' : '；'), 'ok');
      }
    } catch (e) {
      logLine(t('log.manualFail', { msg: e.message }), 'err');
      toast(e.message, 'err');
    }
  }

  function updateKnifeCoordsDisplay() {
    if ($('knifePosVal')) {
      $('knifePosVal').textContent = `X: ${state.knifePos.x.toFixed(1)}, Y: ${state.knifePos.y.toFixed(1)} mm`;
    }
    if ($('userOriginVal')) {
      $('userOriginVal').textContent = `X: ${state.userOrigin.x.toFixed(1)}, Y: ${state.userOrigin.y.toFixed(1)} mm`;
    }
    renderer.knifePos = state.knifePos;
    renderer.userOrigin = state.userOrigin;
  }

  function wirePad() {
    const step = () => +$('stepMm').value || 5;

    // 方向键：支持按住连续移动（pointerdown 后定时重复）
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
        // 先等 400ms 再开始连发，避免轻点也触发一串
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

    // 中心键：落刀
    const center = document.querySelector('.pad-key.center');
    if (center) {
      center.addEventListener('click', () => {
        if (!state.connected) { toast(t('toast.noDevice'), 'err'); return; }
        if (!confirm(t('confirm.pendown'))) return;
        sendManual({ action: 'pendown' }, 'pendown');
      });
    }

    // 动作按钮
    document.querySelectorAll('[data-manual]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.manual;
        if (action === 'setorigin') {
          if (!confirm(t('confirm.setorigin'))) return;
          state.userOrigin = { x: state.knifePos.x, y: state.knifePos.y };
          updateKnifeCoordsDisplay();
          renderer.dirty = true;
          toast(t('toast.originSet', { x: state.userOrigin.x.toFixed(1), y: state.userOrigin.y.toFixed(1) }), 'ok');
          sendManual({ action: 'setorigin', x: state.userOrigin.x, y: state.userOrigin.y }, action);
          return;
        }
        if (action === 'home') {
          state.knifePos = { x: state.userOrigin.x, y: state.userOrigin.y };
          updateKnifeCoordsDisplay();
          renderer.dirty = true;
        }
        const cmd = { action };
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

    // 重置原点
    $('btnResetOrigin')?.addEventListener('click', () => {
      state.userOrigin = { x: 0, y: 0 };
      updateKnifeCoordsDisplay();
      renderer.dirty = true;
      toast(t('toast.originReset'), 'ok');
    });

    // 键盘快捷键监听
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

      // 全选快捷键 (Cmd+A / Ctrl+A)
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

      // 删除快捷键：全方位支持 Mac (Backspace/Delete, Cmd+Backspace, Cmd+Delete) 与 Windows (Delete, Backspace)
      // 包含中文输入法 (keyCode 229 / key Process 时靠 e.code 匹配)
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
  /**
   * 串口下拉里那一行「未检测到串口设备」是**占位项**，不是真实串口。
   *
   * 它在 scanPorts 时写进去，但切语言时不会被 data-i18n 刷到
   * （那是 JS 生成的 option，不带 data-i18n 属性）——
   * 症状就是「界面都切成中文了，串口下拉里还挂着英文 No serial port found」。
   *
   * 解决办法：给这个 option 打上 data-i18n，让 applyI18n 也能扫到它。
   * 真实串口（/dev/ttyACM0 之类）没有文案，不需要也不能翻译。
   */
  function emptyPortOption() {
    return `<option value="" data-i18n="port.none">${t('port.none')}</option>`;
  }

  async function scanPorts() {
    try {
      const r = await api('/api/serial-ports');
      const sel = $('portSel');
      const prev = sel.value;
      sel.innerHTML = '';
      if (!r.ports.length) {
        sel.innerHTML = emptyPortOption();
        logLine(t('log.portNone'), 'err');
        return;
      }
      for (const p of r.ports) {
        const o = document.createElement('option');
        o.value = p.path;
        const vid = p.vendorId ? ` [${p.vendorId}:${p.productId}]` : '';
        o.textContent = p.path + (p.product ? ` — ${p.product}` : '') + vid;
        sel.appendChild(o);
      }
      if (prev) sel.value = prev;
      else if (state.config?.serial?.path) sel.value = state.config.serial.path;
      else {
        const acm = r.ports.find((p) => p.path.includes('ttyACM'));
        if (acm) sel.value = acm.path;
      }
      logLine(t('log.portFound', { n: r.ports.length }));
    } catch (e) { logLine(t('log.scanFail', { msg: e.message }), 'err'); }
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
      // pathEn 存在时说明这是内置虚拟机的标签（唯一一处非真实路径的中文文案）
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
  async function onFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    showLoading(t('loading.importing'));
    logLine(t('toast.parsing', { name: f.name }));
    try {
      const text = await f.text();
      const r = await api('/api/import', {
        method: 'POST',
        body: { content: text, filename: f.name },
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
          name: `${f.name} #${i + 1}`,
          subpaths: [structuredClone(sub)],
        }));
      }
      const isGroup = !!(children && children.length > 1);
      const layer = addLayer(f.name, r.path, { isGroup, children });

      // 自动校准到工作区：纠正负坐标并将大尺寸图形等比缩放到材料幅面内
      const bed = state.preset || { width: 600, height: 710 };
      const bb = T.layerBBox(layer);
      let dx = 0, dy = 0;
      if (bb.minX < 10) dx = 10 - bb.minX;
      if (bb.minY < 10) dy = 10 - bb.minY;
      if (dx !== 0 || dy !== 0) T.translateLayer(layer, dx, dy);

      const curBb = T.layerBBox(layer);
      const maxW = bed.width - 20;
      const maxH = bed.height - 20;
      if (curBb.w > maxW || curBb.h > maxH) {
        const sf = Math.min(maxW / Math.max(curBb.w, 1), maxH / Math.max(curBb.h, 1));
        T.scaleLayer(layer, sf, sf, curBb.minX, curBb.minY);
      }

      state.selectedId = layer.id;
      state.selectedIds = new Set([layer.id]);
      renderer.selectedId = layer.id;
      renderer.selectedIds = state.selectedIds;
      toast(t('toast.imported', { name: f.name }), 'ok');
      logLine(t('log.importOk', { n: r.path.subpaths.length, len: r.info.length.toFixed(0) }));
      for (const w of r.warnings || []) { logLine(t('log.notice', { msg: pickLang(w) || w })); }
      fitToContent();
      updateStats();
    } catch (err) {
      toast(t('toast.parseFail', { msg: err.message }), 'err');
      logLine(t('log.parseFail', { msg: err.message }), 'err');
    } finally {
      hideLoading();
      e.target.value = '';
    }
  }

  function loadDemo() {
    // 一块招牌，占材料区大部分，比例接近真实作业。
    // 布局按 mm 算：外框 60..570 × 60..380，中心 (315, 220)
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

    // 分隔线在文字下方
    const div = G.makeSubpath(150, 165);
    G.addLine(div, 480, 165);
    p.subpaths.push(div);

    // 底部装饰点
    for (let i = 0; i < 11; i++) {
      for (const sub of G.circleToPath(235 + i * 16, 300, 5).subpaths) p.subpaths.push(sub);
    }

    addLayer(t('demo.sign'), p);

    // 文字：42mm 高时宽约 356mm，起点 137 正好居中（中心 315）
    fetch('/api/text-to-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'SPARKMINDS', sizeMm: 42, x: 137, y: 205 }),
    })
      .then((r) => r.json())
      .then((r) => {
        if (r.path) {
          addLayer(t('layer.text', { text: 'SPARKMINDS' }), r.path);
          logLine(t('toast.demoLoaded'));
        }
        fitToContent();
        updateStats();
      });
  }

  // ---------------------------------------------------------------- 编译输出
  function buildItems() {
    return renderer.layers.filter((l) => !l.hidden).map((l) => ({
      id: l.id,
      subpaths: l.subpaths,
    }));
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
          origin: state.userOrigin || { x: 0, y: 0 },
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
      const r = await api('/api/compile', {
        method: 'POST',
        body: {
          items: items.map((i) => ({ path: { subpaths: i.subpaths } })),
          speed: +$('speedRange').value,
          force: +$('forceRange').value,
          direction: $('dirSel').value,
        },
      });
      // 用 POST 路由回显解析，避免大 G-code 导致 URL 超过 8KB 返回 HTTP 431
      const back = await api('/api/preview', {
        method: 'POST',
        body: { gcode: r.gcode },
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

    // 第一遍：计算整体包围盒与收集有效子路径
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
    const minStep = maxSpan / 250; // 缩略图分辨率阈值（低于此距离的点可合并）
    const minStepSq = minStep * minStep;

    // 若子路径过多，按步长均匀抽稀子路径，保证超复杂大工程缩略图在 20KB 以内且轮廓完整
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
            continue; // 跳过过密微小线段
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
      state.userOrigin = full.userOrigin ? { ...full.userOrigin } : { x: 0, y: 0 };

      if (full.machineId && state.presets[full.machineId]) {
        $('machineSel').value = full.machineId;
        state.config.machineId = full.machineId;
        renderer.setPreset(state.presets[full.machineId]);
      }
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
