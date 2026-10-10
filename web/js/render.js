/**
 * 画布渲染器。
 *
 * 坐标系：内部用「毫米、Y 向上」（与服务端一致），Canvas 是「像素、Y 向下」，
 * 所以这里做一次翻转。不能反，否则画出来的位置和实际刻出来的位置是镜像的——
 * 这种事肉眼在预览阶段未必发现，上机就晚了。
 */

import * as G from '../geom.js';
import { t } from './i18n.js';

class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = window.devicePixelRatio || 1;

      // 视图变换
      this.scale = 3;          // 像素/mm
      this.offsetX = 0;        // 画布左上角对应的模型坐标
      this.offsetY = 0;

      this.preset = { width: 630, height: 710 };
      this.showGrid = true;
      this.tool = 'select';

      // 内容
      this.layers = [];
      this.selectedId = null;
      this.selectedIds = new Set();
      this.userOrigin = { x: 0, y: 0 };
      this.knifePos = { x: 0, y: 0 };

      // 动画
      this.anim = null;        // { path, t, speed }
      this.travel = null;      // 快移预览线

      this.dirty = true;
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    resize() {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      // 父容器可能还没布局完成（display:none 或宽高为 0）。
      // 此时若把画布尺寸设成 0，getImageData 会读到全空，看起来像「什么都没画」。
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) {
        // 尺寸无效时保持上一帧的状态，等下次 resize 再算
        return;
      }
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.vw = w;
      this.vh = h;
      this.dirty = true;
    }

    /** 视口尺寸，无效时退化为 1，避免算式产出 NaN 把画布搞成一片空白 */
    get vwSafe() { return this.vw > 0 ? this.vw : 1; }
    get vhSafe() { return this.vh > 0 ? this.vh : 1; }

    // ---- 坐标转换 ----
    // 模型 (mm, Y向上) → 屏幕 (px, Y向下)
    //
    // offsetX/offsetY 是「视口中心对应的模型坐标」，所以：
    //   screen = 视口中心 + (模型点 - 视口中心) * scale
    // X 轴：+（x 增大往右，与屏幕一致）
    // Y 轴：模型向上、屏幕向下，所以取负——这一处符号反了就是左右镜像，
    //      表现为文字变成 "SPAPXIWS"，而对称图形（方框、圆）看不出来。
    toScreen(x, y) {
      return {
        x: this.vwSafe / 2 + (x - this.offsetX) * this.scale,
        y: this.vhSafe / 2 - (y - this.offsetY) * this.scale,
      };
    }

    toModel(sx, sy) {
      return {
        x: (sx - this.vwSafe / 2) / this.scale + this.offsetX,
        y: (this.vhSafe / 2 - sy) / this.scale + this.offsetY,
      };
    }

    fit() {
      this.resize();
      const pad = 34;
      const sw = (this.vwSafe - pad * 2) / this.preset.width;
      const sh = (this.vhSafe - pad * 2) / this.preset.height;
      this.scale = Math.max(0.2, Math.min(sw, sh));
      this.offsetX = this.preset.width / 2;
      this.offsetY = this.preset.height / 2;
      this.dirty = true;
    }

    zoomAt(factor, sx, sy) {
      const before = this.toModel(sx, sy);
      this.scale = G.clamp(this.scale * factor, 0.3, 40);
      const after = this.toModel(sx, sy);
      this.offsetX += before.x - after.x;
      this.offsetY += before.y - after.y;
      this.dirty = true;
    }

    panBy(dxPx, dyPx) {
      this.offsetX -= dxPx / this.scale;
      this.offsetY += dyPx / this.scale;
      this.dirty = true;
    }

    setPreset(p) {
      if (!p) return;
      this.preset = { width: p.width, height: p.height };
      this.dirty = true;
    }

    // ---- 绘制 ----
    _loop() {
      if (this.anim) this._stepAnim();
      if (this.dirty) {
        // requestAnimationFrame 回调里的异常不会冒泡到 window.onerror，
        // 会被浏览器静默吞掉——表现为「画布一片空白且没有任何报错」，
        // 极难排查。所以这里必须自己兜住并打日志。
        try {
          this._draw();
          this.dirty = false;
        } catch (err) {
          console.error('[Renderer] 绘制失败：', err);
          this.dirty = false;
          this._errorCount = (this._errorCount || 0) + 1;
        }
      }
      requestAnimationFrame(this._loop);
    }

    _draw() {
      const ctx = this.ctx;
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.clearRect(0, 0, this.vwSafe, this.vhSafe);

      this._drawBed();
      if (this.showGrid) this._drawGrid();
      this._drawContent();
      this._drawSelection();
      this._drawAnim();

      ctx.restore();
    }

    /** 机器幅面（材料区） */
    _drawBed() {
      const ctx = this.ctx;
      const a = this.toScreen(0, 0);
      const b = this.toScreen(this.preset.width, this.preset.height);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);

      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#c4cad3';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // roundRect 是 Chrome 99+ 才有的，老浏览器会直接抛异常。
      // 整个 _draw 都在 try 里，一旦抛错这一帧就白画——所以必须做能力检测。
      if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, 3);
      } else {
        ctx.rect(x, y, w, h);
      }
      ctx.fill();
      ctx.stroke();

      // 机械物理原点（左下角）
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(t('canvas.mechOrigin'), x + 3, y + h - 5);
      ctx.beginPath();
      ctx.arc(x, y + h, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#94a3b8';
      ctx.fill();

      // 用户工作原点（若设置了原点，在材料区动态定位）
      const uo = this.userOrigin || { x: 0, y: 0 };
      const so = this.toScreen(uo.x, uo.y);

      // 绘制原点标记（红点 + 坐标轴线）
      ctx.beginPath();
      ctx.arc(so.x, so.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#e11d48';
      ctx.fill();

      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(so.x, so.y); ctx.lineTo(so.x + 16, so.y);
      ctx.moveTo(so.x, so.y); ctx.lineTo(so.x, so.y - 16);
      ctx.stroke();

      // 原点文字标签
      ctx.fillStyle = '#e11d48';
      ctx.font = 'bold 11px ui-monospace, monospace';
      const label = `${t('canvas.origin')} (${uo.x.toFixed(1)}, ${uo.y.toFixed(1)})`;
      ctx.fillText(label, so.x + 6, so.y - 6);

      // 绘制刀头实时位置标记
      if (this.knifePos) {
        const kp = this.toScreen(this.knifePos.x, this.knifePos.y);
        ctx.save();
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, 7, 0, Math.PI * 2);
        ctx.moveTo(kp.x - 11, kp.y); ctx.lineTo(kp.x + 11, kp.y);
        ctx.moveTo(kp.x, kp.y - 11); ctx.lineTo(kp.x, kp.y + 11);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(kp.x, kp.y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#0284c7';
        ctx.fill();

        ctx.fillStyle = '#0284c7';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(`${t('canvas.knife')} (${this.knifePos.x.toFixed(1)}, ${this.knifePos.y.toFixed(1)})`, kp.x + 9, kp.y + 12);
        ctx.restore();
      }
    }

    _drawGrid() {
      const ctx = this.ctx;
      // 网格间距随缩放自适应，避免密到看不清
      const candidates = [1, 2, 5, 10, 20, 50, 100, 200];
      let step = candidates[candidates.length - 1];
      for (const c of candidates) {
        if (c * this.scale >= 22) { step = c; break; }
      }
      const a = this.toScreen(0, 0);
      const b = this.toScreen(this.preset.width, this.preset.height);
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);

      ctx.strokeStyle = 'rgba(0,0,0,0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= this.preset.width; x += step) {
        const sx = this.toScreen(x, 0).x;
        if (sx < left - 1 || sx > right + 1) continue;
        ctx.moveTo(sx, top); ctx.lineTo(sx, bottom);
      }
      for (let y = 0; y <= this.preset.height; y += step) {
        const sy = this.toScreen(0, y).y;
        if (sy < top - 1 || sy > bottom + 1) continue;
        ctx.moveTo(left, sy); ctx.lineTo(right, sy);
      }
      ctx.stroke();
    }

    _drawContent() {
      const ctx = this.ctx;
      let drawn = 0;
      let skipped = 0;
      for (const layer of this.layers) {
        if (layer.hidden) continue;
        const isSel = layer.id === this.selectedId || (this.selectedIds && this.selectedIds.has(layer.id));
        for (const sub of layer.subpaths) {
          const pts = G.flattenSubpathOpen(sub, 0.06);
          if (pts.length < 2) { skipped++; continue; }
          ctx.beginPath();
          const p0 = this.toScreen(pts[0].x, pts[0].y);
          ctx.moveTo(p0.x, p0.y);
          for (let i = 1; i < pts.length; i++) {
            const p = this.toScreen(pts[i].x, pts[i].y);
            ctx.lineTo(p.x, p.y);
          }
          if (sub.closed) ctx.closePath();

          if (isSel) {
            ctx.strokeStyle = 'rgba(37,99,235,0.16)';
            ctx.lineWidth = 7;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.strokeStyle = '#2563eb';
          } else {
            ctx.strokeStyle = '#e11d48';
          }
          ctx.lineWidth = isSel ? 2 : 1.5;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.stroke();
          drawn++;
        }
      }
      this._lastDrawStats = { drawn, skipped, layers: this.layers.length, vw: this.vw, vh: this.vh, scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY };
    }

    /**
     * 选中框与控制点。
     *
     * 用 Inkscape / Illustrator 的习惯：实线选框 + 四角实心方块（缩放）
     * + 顶部一个圆形（旋转）。手柄要足够大才好抓——画布缩放时手柄大小保持
     * 屏幕像素恒定，不随图形缩放变小，否则放到很小时就没法操作了。
     */
    _drawSelection() {
      const layer = this.layers.find((l) => l.id === this.selectedId);
      if (!layer || layer.hidden) return;
      const bb = this.selectionBox || this.computeBBox(layer);
      if (!bb) return;

      const ctx = this.ctx;
      const a = this.toScreen(bb.minX, bb.maxY);   // 左下（屏幕）
      const b = this.toScreen(bb.maxX, bb.minY);   // 右上
      const x = a.x, y = a.y, w = b.x - a.x, h = b.y - a.y;

      // 选框：虚线，视觉上不与刀路混淆
      ctx.save();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      if (!this.handles) this.handles = [];
      this.handles = [];
      const HS = 4.5;  // 手柄半边长（屏幕像素，恒定）

      // 四角缩放手柄
      const corners = [
        ['nw', x, y], ['ne', x + w, y], ['se', x + w, y + h], ['sw', x, y + h],
      ];
      for (const [id, cx, cy] of corners) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.fillRect(cx - HS, cy - HS, HS * 2, HS * 2);
        ctx.strokeRect(cx - HS, cy - HS, HS * 2, HS * 2);
        this.handles.push({ id, kind: 'scale', x: cx, y: cy, cursor: id === 'nw' || id === 'se' ? 'nwse-resize' : 'nesw-resize' });
      }

      // 顶部旋转手柄
      const rx = x + w / 2, ry = y - 22;
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.arc(rx, ry, HS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 连线，说明旋转手柄归属
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(37,99,235,0.5)';
      ctx.lineWidth = 1;
      ctx.moveTo(rx, y);
      ctx.lineTo(rx, ry);
      ctx.stroke();
      this.handles.push({ id: 'rot', kind: 'rotate', x: rx, y: ry, cursor: 'grab' });

      ctx.restore();
    }

    /** 计算图层包围盒（屏幕无关，模型坐标） */
    computeBBox(layer) {
      if (!layer.subpaths.length) return null;
      const path = { subpaths: layer.subpaths };
      const bb = G.pathBBox(path);
      if (!isFinite(bb.minX)) return null;
      return bb;
    }

    /** 命中控制点。返回 handle 或 null */
    hitHandle(sx, sy, tol = 7) {
      if (!this.handles) return null;
      for (const hd of this.handles) {
        if (Math.abs(sx - hd.x) <= tol && Math.abs(sy - hd.y) <= tol) return hd;
      }
      return null;
    }

    _strokePath(sub, selected) {
      const ctx = this.ctx;
      const pts = G.flattenSubpathOpen(sub, 0.06);
      if (pts.length < 2) return;

      ctx.beginPath();
      const p0 = this.toScreen(pts[0].x, pts[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = this.toScreen(pts[i].x, pts[i].y);
        ctx.lineTo(p.x, p.y);
      }
      if (sub.closed) ctx.closePath();

      // 刀具实际走的是路径中心，用实线；选中时加外发光
      if (selected) {
        ctx.strokeStyle = 'rgba(37,99,235,0.18)';
        ctx.lineWidth = 7;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.strokeStyle = '#2563eb';
      } else {
        ctx.strokeStyle = '#e11d48';
      }
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // ---- 刀路动画 ----
    startAnim(path, speedMmPerSec = 40) {
      // 预先离散成点串，按长度匀速推进，看起来就是真实刻绘速度
      const segs = [];
      let total = 0;
      let prevPt = null;
      for (const sub of path.subpaths) {
        const pts = G.flattenSubpathOpen(sub, 0.08);
        // 空子路径直接跳过：pts 不足 2 点时 pts[pts.length-1] 是 undefined，
        // 后面算距离会得到 NaN，污染 total 与动画进度。
        if (pts.length < 2) { continue; }
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (d < 1e-6) continue;
          segs.push({ a, b, len: d, cum: total + d, cut: true });
          total += d;
        }
        // 快移：抬刀到下一段起点（cut:false，动画里画成虚线）
        const last = pts[pts.length - 1];
        if (prevPt) {
          const d = Math.hypot(last.x - prevPt.x, last.y - prevPt.y);
          if (d > 0.5) {
            segs.push({ a: prevPt, b: last, len: d, cum: total + d, cut: false });
            total += d;
          }
        }
        prevPt = last;
      }
      this.anim = { segs, total, pos: 0, last: performance.now(), speed: speedMmPerSec, path };
      this.dirty = true;
    }

    _stepAnim() {
      const a = this.anim;
      const now = performance.now();
      const dt = (now - a.last) / 1000;
      a.last = now;
      // 加速 40 倍：否则 3 米长的活要盯 3 分钟，看不出走线对不对
      a.pos = Math.min(a.total, a.pos + dt * a.speed * 40);
      if (a.pos >= a.total) { this.anim = null; if (this.onAnimEnd) this.onAnimEnd(); }
      this.dirty = true;
    }

    stopAnim() { this.anim = null; this.dirty = true; }

    _drawAnim() {
      const a = this.anim;
      if (!a) return;
      const ctx = this.ctx;

      // 已走过的部分
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      let cur = null;
      let started = false;
      ctx.beginPath();
      for (const s of a.segs) {
        if (s.cum > a.pos) break;
        const pa = this.toScreen(s.a.x, s.a.y);
        const pb = this.toScreen(s.b.x, s.b.y);
        if (!started) { ctx.moveTo(pa.x, pa.y); started = true; }
        if (s.cut) {
          ctx.strokeStyle = s.cut ? '#e11d48' : '#94a3b8';
          ctx.lineWidth = 1.4;
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(pb.x, pb.y);
        }
        cur = pb;
      }
      // 正在走的这一段
      const partial = this._pointAt(a, a.pos);
      if (partial) {
        const ps = this.toScreen(partial.x, partial.y);
        ctx.fillStyle = '#2563eb';
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(37,99,235,0.25)';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      void cur;
    }

    _pointAt(a, dist) {
      for (const s of a.segs) {
        if (s.cum >= dist) {
          const t = (dist - (s.cum - s.len)) / s.len;
          return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t, cut: s.cut };
        }
      }
      return null;
    }

    // ---- 命中测试 ----
    hitTest(mx, my) {
      const tol = 8 / this.scale;
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const layer = this.layers[i];
        if (layer.hidden) continue;
        for (const sub of layer.subpaths) {
          const pts = G.flattenSubpathOpen(sub, 0.1);
          for (let k = 0; k + 1 < pts.length; k++) {
            if (distToSeg(mx, my, pts[k], pts[k + 1]) < tol) return layer;
          }
        }
      }
      return null;
    }
  }

  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

export { Renderer };
