/**
 * DXF 解析器。
 *
 * DXF 是分组码（group code）格式：每两行是一对，第一行是码，第二行是值。
 * 只需关心实体段（ENTITIES）里的这几类：
 *   LINE        直线
 *   LWPOLYLINE  轻量多段线（最常见，含凸度信息表示圆弧）
 *   POLYLINE    老式多段线（顶点是独立子实体）
 *   ARC         圆弧
 *   CIRCLE      整圆
 *   ELLIPSE     椭圆
 *   SPLINE      样条曲线
 *   POINT       单点（刻字机一般忽略）
 *
 * 只读，不做完整 BINARY DXF 支持——设计软件导出的 ASCII DXF 已覆盖绝大多数场景。
 */

import {
  makePath, makeSubpath, addLine, addArc, TAU, DEG, normAngle,
} from '../geom/path.js';

function tokenize(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

/** 从 token 流里切出实体块的边界 */
function extractEntities(pairs) {
  const entities = [];
  let cur = null;
  let inEnt = false;
  for (const p of pairs) {
    if (p.code === 0) {
      if (cur) entities.push(cur);
      if (p.value === 'SECTION') { inEnt = false; continue; }
      cur = { type: p.value, data: [] };
      inEnt = true;
      continue;
    }
    if (!cur) continue;
    cur.data.push(p);
  }
  if (cur) entities.push(cur);
  return entities;
}

function groupBy(data) {
  const map = new Map();
  for (const d of data) {
    if (!map.has(d.code)) map.set(d.code, []);
    map.get(d.code).push(d.value);
  }
  return map;
}

/** LWPOLYLINE 的凸度 → 圆弧图元 */
function bulgesToArcs(sub, bulges) {
  // 凸度定义在每段的「前一个顶点 → 当前顶点」上
  const pts = [{ x: sub.start.x, y: sub.start.y }];
  for (const e of sub.elems) if (e.type === 'line') pts.push({ x: e.x2, y: e.y2 });
  let seg = 0;
  for (let i = 1; i < pts.length; i++) {
    const b = bulges[seg - 1] !== undefined ? bulges[seg - 1] : 0;
    seg++;
    if (Math.abs(b) < 1e-9) continue;
    const p0 = pts[i - 1], p1 = pts[i];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-9) continue;
    // 凸度 = tan(θ/4)，θ 为包含角
    const theta = 4 * Math.atan(b);
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    // 圆心：弦中点沿法线偏移 r*cos(θ/2)
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    const h = r * Math.cos(theta / 2) * Math.sign(b);
    const nx = -dy / chord, ny = dx / chord;
    const cx = mx + nx * h, cy = my + ny * h;
    const a0 = Math.atan2(p0.y - cy, p0.x - cx);
    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    sub.elems.push({ type: 'arc', cx, cy, r, a0, a1 });
  }
}

export function parseDxf(text) {
  const pairs = tokenize(text);
  const rawEntities = extractEntities(pairs);
  const path = makePath();
  const warnings = [];

  // POLYLINE 的顶点是紧跟其后的 VERTEX 实体，需要按顺序配对
  const vertexBuffer = [];
  let polylineHeader = null;

  for (const ent of rawEntities) {
    const g = groupBy(ent.data);
    const layer = g.get(8)?.[0] || '0';

    switch (ent.type) {
      case 'LINE': {
        const x1 = +g.get(10)?.[0], y1 = +g.get(20)?.[0];
        const x2 = +g.get(11)?.[0], y2 = +g.get(21)?.[0];
        if ([x1, y1, x2, y2].some(Number.isNaN)) break;
        const sub = makeSubpath(x1, y1);
        addLine(sub, x2, y2);
        path.subpaths.push(sub);
        break;
      }

      case 'LWPOLYLINE': {
        const xs = g.get(10) || [], ys = g.get(20) || [];
        if (!xs.length) break;
        const sub = makeSubpath(+xs[0], +ys[0]);
        for (let i = 1; i < xs.length; i++) addLine(sub, +xs[i], +ys[i]);
        const bulges = (g.get(42) || []).map(Number);
        if (bulges.some((b) => Math.abs(b) > 1e-9)) bulgesToArcs(sub, bulges);
        sub.closed = (g.get(70)?.[0] ? +g.get(70)[0] : 0) & 1;
        path.subpaths.push(sub);
        break;
      }

      case 'POLYLINE': {
        polylineHeader = { layer, closed: (g.get(70)?.[0] ? +g.get(70)[0] : 0) & 1 };
        vertexBuffer.length = 0;
        break;
      }

      case 'VERTEX': {
        if (!polylineHeader) break;
        vertexBuffer.push({ x: +g.get(10)?.[0], y: +g.get(20)?.[0], b: +(g.get(42)?.[0] || 0) });
        break;
      }

      case 'SEQEND': {
        if (polylineHeader && vertexBuffer.length > 1) {
          const sub = makeSubpath(vertexBuffer[0].x, vertexBuffer[0].y);
          for (let i = 1; i < vertexBuffer.length; i++) addLine(sub, vertexBuffer[i].x, vertexBuffer[i].y);
          const bulges = vertexBuffer.map((v) => v.b);
          if (bulges.some((b) => Math.abs(b) > 1e-9)) bulgesToArcs(sub, bulges);
          sub.closed = polylineHeader.closed;
          path.subpaths.push(sub);
        }
        polylineHeader = null;
        vertexBuffer.length = 0;
        break;
      }

      case 'ARC': {
        const cx = +g.get(10)?.[0], cy = +g.get(20)?.[0];
        const r = +g.get(40)?.[0];
        const a0 = (+g.get(50)?.[0]) * DEG, a1 = (+g.get(51)?.[0]) * DEG;
        if ([cx, cy, r, a0, a1].some(Number.isNaN)) break;
        const sub = makeSubpath(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
        sub.elems.push({ type: 'arc', cx, cy, r, a0, a1 });
        path.subpaths.push(sub);
        break;
      }

      case 'CIRCLE': {
        const cx = +g.get(10)?.[0], cy = +g.get(20)?.[0], r = +g.get(40)?.[0];
        if ([cx, cy, r].some(Number.isNaN) || r <= 0) break;
        const sub = makeSubpath(cx + r, cy);
        sub.elems.push({ type: 'arc', cx, cy, r, a0: 0, a1: TAU });
        sub.closed = true;
        path.subpaths.push(sub);
        break;
      }

      case 'ELLIPSE': {
        const cx = +g.get(10)?.[0], cy = +g.get(20)?.[0];
        const mx = +g.get(11)?.[0] || 1, my = +g.get(21)?.[0] || 0;
        const majorLen = +(g.get(40)?.[0] || 1);
        const ratio = +(g.get(41)?.[0] || 1);
        const startP = +(g.get(41)?.[1] ?? 0) * DEG;
        const endP = +(g.get(42)?.[1] ?? TAU) * DEG;
        const major = majorLen;
        const minor = majorLen * ratio;
        const rot = Math.atan2(my, mx);
        const toWorld = (a, along) => {
          const ex = along * major * Math.cos(a);
          const ey = along * major * Math.sin(a);
          return {
            x: cx + ex * Math.cos(rot) - ey * Math.sin(rot),
            y: cy + ex * Math.sin(rot) + ey * Math.cos(rot),
          };
        };
        const s = toWorld(startP, 1);
        const sub = makeSubpath(s.x, s.y);
        if (Math.abs(major - minor) < 1e-9) {
          sub.elems.push({ type: 'arc', cx, cy, r: major, a0: rot + startP, a1: rot + endP });
        } else {
          const steps = Math.max(8, Math.ceil(Math.abs(endP - startP) / 0.15));
          for (let i = 1; i <= steps; i++) {
            const p = toWorld(startP + ((endP - startP) * i) / steps, 1);
            addLine(sub, p.x, p.y);
          }
        }
        path.subpaths.push(sub);
        break;
      }

      case 'SPLINE': {
        // 样条：DXF 用控制点+节点表示，精确求值复杂。刻字机场景按折线处理，
        // 设计端通常已经转成多段线了。若真遇到控制点，直接连成折线并给出提示。
        const xs = g.get(10) || [], ys = g.get(20) || [];
        if (xs.length > 1) {
          const sub = makeSubpath(+xs[0], +ys[0]);
          for (let i = 1; i < xs.length; i++) addLine(sub, +xs[i], +ys[i]);
          path.subpaths.push(sub);
          warnings.push({
            zh: '检测到 SPLINE 样条曲线，已按控制点折线处理。若曲线不圆滑，请在设计软件中先转为多段线。',
            en: 'SPLINE curves found, approximated by control polygon. If curves look faceted, convert to polylines in your design app first.',
          });
        }
        break;
      }

      default:
        break;
    }
  }

  // DXF 的 Y 轴向上，本模块统一保持向上；负的 Y 需整体翻转的情况由调用方处理
  return { path, warnings, layerHint: 'DXF' };
}

void normAngle;
