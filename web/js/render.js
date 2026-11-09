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

      this.preset = { width: 630, height: 710, originPosition: 'bottom-right' };
      this.originPosition = 'bottom-right';
      this.showGrid = true;
      this.tool = 'select';

      // 内容
      this.layers = [];
      this.selectedId = null;
      this.selectedIds = new Set();
      this.userOrigin = { x: 630, y: 0 };
      this.knifePos = { x: 630, y: 0 };

      // 动画与走框高亮
      this.anim = null;        // { path, t, speed }
      this.frameBox = null;    // { bbox, originBBox, until }
      this.travel = null;      // 快移预览线

      this.dirty = true;
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    resize() {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) {
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

    setPreset(p, originPos) {
      if (!p) return;
      const pos = originPos || p.originPosition || this.originPosition || 'bottom-right';
      this.preset = { width: p.width, height: p.height, originPosition: pos };
      this.originPosition = pos;
      this.dirty = true;
    }

    /** 当前机器的机械物理原点在画布坐标系下的位置 */
    getMechOrigin() {
      const pos = this.originPosition || 'bottom-right';
      const W = this.preset.width || 600;
      const H = this.preset.height || 710;
      switch (pos) {
        case 'bottom-right': return { x: W, y: 0 };
        case 'top-right':    return { x: W, y: H };
        case 'top-left':     return { x: 0, y: H };
        case 'bottom-left':
        default:             return { x: 0, y: 0 };
      }
    }

    // ---- 绘制 ----
    _loop() {
      if (this.anim) this._stepAnim();
      if (this.frameBox && performance.now() > this.frameBox.until && !this.anim) {
        this.frameBox = null;
        this.dirty = true;
      }
      if (this.dirty) {
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
      this._drawFrameBox();
      this._drawSelection();
      this._drawAnim();

      ctx.restore();
    }

    /** 机器幅面（材料区）与原点指示 */
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
      if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, 3);
      } else {
        ctx.rect(x, y, w, h);
      }
      ctx.fill();
      ctx.stroke();

      const pos = this.originPosition || 'bottom-right';
      const isRight = pos === 'bottom-right' || pos === 'top-right';
      const isTop   = pos === 'top-right' || pos === 'top-left';
      const mech = this.getMechOrigin();
      const sm = this.toScreen(mech.x, mech.y);

      // 机械物理原点角点标注（根据机器原点位置动态落在右下/左下/右上/左上）
      ctx.save();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = isRight ? 'right' : 'left';
      const mechLabelX = isRight ? (sm.x - 6) : (sm.x + 6);
      const mechLabelY = isTop ? (sm.y + 13) : (sm.y - 6);
      ctx.fillText(t('canvas.mechOrigin'), mechLabelX, mechLabelY);
      ctx.beginPath();
      ctx.arc(sm.x, sm.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#94a3b8';
      ctx.fill();
      ctx.restore();

      // 用户工作原点（默认在机械原点角点；轴箭头朝向材料内部）
      const uo = this.userOrigin || mech;
      const so = this.toScreen(uo.x, uo.y);
      const axisDirX = isRight ? -18 : 18;
      const axisDirY = isTop ? 18 : -18;

      ctx.save();
      ctx.beginPath();
      ctx.arc(so.x, so.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#e11d48';
      ctx.fill();

      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(so.x, so.y); ctx.lineTo(so.x + axisDirX, so.y);
      ctx.moveTo(so.x, so.y); ctx.lineTo(so.x, so.y + axisDirY);
      ctx.stroke();

      // 原点文字标签（显示相对于机械原点的偏移距离，在角点处即为 0.0, 0.0）
      const relOx = Math.abs(uo.x - mech.x);
      const relOy = Math.abs(uo.y - mech.y);
      ctx.fillStyle = '#e11d48';
      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.textAlign = isRight ? 'right' : 'left';
      const label = `${t('canvas.origin')} (${relOx.toFixed(1)}, ${relOy.toFixed(1)})`;
      const origLabelX = isRight ? (so.x - 8) : (so.x + 8);
      const origLabelY = isTop ? (so.y + 24) : (so.y - 18);
      ctx.fillText(label, origLabelX, origLabelY);
      ctx.restore();

      // 绘制刀头实时位置标记
      if (this.knifePos) {
        const kp = this.toScreen(this.knifePos.x, this.knifePos.y);
        const relKx = isRight ? (mech.x - this.knifePos.x) : (this.knifePos.x - mech.x);
        const relKy = isTop   ? (mech.y - this.knifePos.y) : (this.knifePos.y - mech.y);
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
        ctx.textAlign = isRight ? 'right' : 'left';
        const kxText = isRight ? (kp.x - 10) : (kp.x + 10);
        const kyText = kp.y + 14;
        ctx.fillText(`${t('canvas.knife')} (${relKx.toFixed(1)}, ${relKy.toFixed(1)})`, kxText, kyText);
        ctx.restore();
      }
    }

    /** 绘制「走框预览」范围矩形高亮框 */
    _drawFrameBox() {
      if (!this.frameBox || !this.frameBox.bbox) return;
      const bb = this.frameBox.bbox;
      const ob = this.frameBox.originBBox;
      const ctx = this.ctx;
      const a = this.toScreen(bb.minX, bb.maxY);
      const b = this.toScreen(bb.maxX, bb.minY);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);

      ctx.save();
      ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // 顶部尺寸标签
      const tag = ob
        ? `${t('canvas.frameBox')} ${bb.w.toFixed(1)}×${bb.h.toFixed(1)}mm (X:${ob.offsetX.toFixed(0)}~${ob.reachX.toFixed(0)}, Y:${ob.offsetY.toFixed(0)}~${ob.reachY.toFixed(0)})`
        : `${t('canvas.frameBox')} ${bb.w.toFixed(1)}×${bb.h.toFixed(1)}mm`;
      ctx.font = 'bold 11px ui-monospace, monospace';
      const tw = ctx.measureText(tag).width + 12;
      const tx = Math.max(8, Math.min(this.vwSafe - tw - 8, x + w / 2 - tw / 2));
      const ty = Math.max(22, y - 8);
      ctx.fillStyle = '#059669';
      ctx.fillRect(tx, ty - 15, tw, 19);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(tag, tx + 6, ty - 2);
      ctx.restore();
    }

    _drawGrid() {
      const ctx = this.ctx;
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

    _drawSelection() {
      const selected = this.layers.filter((l) => !l.hidden && (l.id === this.selectedId || (this.selectedIds && this.selectedIds.has(l.id))));
      if (!selected.length) return;
      const bb = this.selectionBox || this.computeSelectionBBox();
      if (!bb) return;

      const ctx = this.ctx;
      const a = this.toScreen(bb.minX, bb.maxY);
      const b = this.toScreen(bb.maxX, bb.minY);
      const x = a.x, y = a.y, w = b.x - a.x, h = b.y - a.y;

      ctx.save();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      if (!this.handles) this.handles = [];
      this.handles = [];
      const HS = 4.5;

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

      const rx = x + w / 2, ry = y - 22;
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.arc(rx, ry, HS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(37,99,235,0.5)';
      ctx.lineWidth = 1;
      ctx.moveTo(rx, y);
      ctx.lineTo(rx, ry);
      ctx.stroke();
      this.handles.push({ id: 'rot', kind: 'rotate', x: rx, y: ry, cursor: 'grab' });

      ctx.restore();
    }

    computeSelectionBBox() {
      const selected = this.layers.filter((l) => !l.hidden && (l.id === this.selectedId || (this.selectedIds && this.selectedIds.has(l.id))));
      if (!selected.length) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const l of selected) {
        const bb = this.computeBBox(l);
        if (bb && (bb.w || bb.h)) {
          if (bb.minX < minX) minX = bb.minX;
          if (bb.minY < minY) minY = bb.minY;
          if (bb.maxX > maxX) maxX = bb.maxX;
          if (bb.maxY > maxY) maxY = bb.maxY;
        }
      }
      if (!Number.isFinite(minX)) return null;
      return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    }

    computeBBox(layer) {
      if (!layer) return null;
      let subs = layer.subpaths;
      if ((!subs || !subs.length) && layer.children && layer.children.length) {
        subs = layer.children.flatMap((c) => c.subpaths || []);
      }
      if (!subs || !subs.length) return null;
      const path = { subpaths: subs };
      const bb = G.pathBBox(path);
      if (!isFinite(bb.minX)) return null;
      return bb;
    }

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

    // ---- 刀路与走框动画 ----
    startAnim(path, speedMmPerSec = 40, isFrame = false) {
      const segs = [];
      let total = 0;
      let prevPt = null;
      for (const sub of path.subpaths) {
        const pts = G.flattenSubpathOpen(sub, 0.08);
        if (pts.length < 2) { continue; }
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (d < 1e-6) continue;
          segs.push({ a, b, len: d, cum: total + d, cut: true });
          total += d;
        }
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
      this.anim = { segs, total, pos: 0, last: performance.now(), speed: speedMmPerSec, path, isFrame };
      this.dirty = true;
    }

    startFrameAnim(path, bbox, originBBox, speedMmPerSec = 25) {
      this.frameBox = {
        bbox,
        originBBox,
        until: performance.now() + 8000,
      };
      this.startAnim(path, speedMmPerSec, true);
    }

    _stepAnim() {
      const a = this.anim;
      const now = performance.now();
      const dt = (now - a.last) / 1000;
      a.last = now;
      const mult = a.isFrame ? 12 : 40;
      a.pos = Math.min(a.total, a.pos + dt * a.speed * mult);
      if (a.pos >= a.total) { this.anim = null; if (this.onAnimEnd) this.onAnimEnd(); }
      this.dirty = true;
    }

    stopAnim() { this.anim = null; this.dirty = true; }

    _drawAnim() {
      const a = this.anim;
      if (!a) return;
      const ctx = this.ctx;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      let started = false;
      ctx.beginPath();
      for (const s of a.segs) {
        if (s.cum > a.pos) break;
        const pa = this.toScreen(s.a.x, s.a.y);
        const pb = this.toScreen(s.b.x, s.b.y);
        if (!started) { ctx.moveTo(pa.x, pa.y); started = true; }
        if (s.cut) {
          ctx.strokeStyle = a.isFrame ? '#059669' : '#e11d48';
          ctx.lineWidth = a.isFrame ? 2.2 : 1.4;
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(pb.x, pb.y);
        }
      }
      const partial = this._pointAt(a, a.pos);
      if (partial) {
        const ps = this.toScreen(partial.x, partial.y);
        ctx.fillStyle = a.isFrame ? '#059669' : '#2563eb';
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = a.isFrame ? 'rgba(5,150,105,0.28)' : 'rgba(37,99,235,0.25)';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 7.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
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
