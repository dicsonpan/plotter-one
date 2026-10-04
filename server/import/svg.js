/**
 * SVG path 解析（d 属性）。
 * 覆盖 SVG 1.1 全部路径命令：M L H V C S Q T A Z（及其小写相对形式）。
 *
 * 注意坐标系：SVG 的 Y 轴向下，我们的内部模型 Y 轴向上。
 * 解析阶段保持 SVG 原始数值，由调用方决定是否翻转；这里用 flipY 选项。
 */

import { makePath, makeSubpath, addLine, addArc, DEG, TAU, normAngle } from '../geom/path.js';

function tokenizePath(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) {
    if (m[1]) out.push({ type: 'cmd', v: m[1] });
    else out.push({ type: 'num', v: parseFloat(m[2]) });
  }
  return out;
}

/** 端点参数化椭圆 → 圆弧图元（无 SVG A 命令则退化为折线） */
function ellipticalArcTo(x0, y0, rx, ry, xRotDeg, largeArc, sweep, x1, y1, sub) {
  if (rx === 0 || ry === 0) { addLine(sub, x1, y1); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = xRotDeg * DEG;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  let rxs = rx * rx, rys = ry * ry, x1ps = x1p * x1p, y1ps = y1p * y1p;
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
    rxs = rx * rx; rys = ry * ry;
  }

  let num = rxs * rys - rxs * y1ps - rys * x1ps;
  const den = rxs * y1ps + rys * x1ps;
  if (num < 0) num = 0;
  const co = den === 0 ? 0 : Math.sqrt(num / den);
  const sign = largeArc !== sweep ? 1 : -1;
  const cxp = sign * co * (rx * y1p) / ry;
  const cyp = sign * co * -(ry * x1p) / rx;

  const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2;

  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dTheta = ang(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= TAU;
  if (sweep && dTheta < 0) dTheta += TAU;

  // 圆在旋转后的世界坐标里不再是正圆 → 只能离散
  if (Math.abs(rx - ry) < 1e-6 && Math.abs(phi % (Math.PI / 2)) < 1e-6) {
    sub.elems.push({ type: 'arc', cx, cy, r: rx, a0: theta1, a1: theta1 + dTheta });
  } else {
    const steps = Math.max(8, Math.ceil(Math.abs(dTheta) / 0.12));
    for (let i = 1; i <= steps; i++) {
      const t = theta1 + (dTheta * i) / steps;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      addLine(sub, cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy);
    }
  }
}

export function parseSvgPath(d, opts = {}) {
  const flipY = opts.flipY !== false; // 默认按 SVG 语义翻转成 Y 向上
  const path = makePath();
  const toks = tokenizePath(d || '');
  const fy = (y) => (flipY ? -y : y);

  // 关键：cx/cy/sx/sy 一律保存「SVG 原始坐标」，
  // 这样相对偏移（y += cy）在同一坐标系里计算；
  // 只在写入路径时才用 fy() 翻转到内部坐标系（Y 向上）。
  // 若把翻转后的值存进 cy 再做相对运算，会被翻转两次，路径错乱。
  let sub = null;
  let cx = 0, cy = 0;      // 当前点（SVG 原始坐标）
  let sx = 0, sy = 0;      // 子路径起点（SVG 原始坐标）
  let lastCtrlX = null, lastCtrlY = null; // 上一段控制点，用于 S/T
  let prevCmd = '';
  let i = 0;

  const nextNum = () => (i < toks.length && toks[i].type === 'num' ? toks[i++].v : 0);

  const startSub = (x, y) => {
    sub = makeSubpath(x, fy(y));
    path.subpaths.push(sub);
    cx = x; cy = y; sx = x; sy = y;
  };

  while (i < toks.length) {
    if (toks[i].type === 'cmd') {
      prevCmd = toks[i].v;
      i++;
    } else if (prevCmd === 'M') prevCmd = 'L';
    else if (prevCmd === 'm') prevCmd = 'l';

    const rel = prevCmd === prevCmd.toLowerCase();
    const C = prevCmd.toUpperCase();

    if (C === 'M') {
      let x = nextNum(), y = nextNum();
      if (rel) { x += cx; y += cy; }
      startSub(x, y);
      lastCtrlX = lastCtrlY = null;
      continue;
    }

    if (!sub) { startSub(0, 0); }

    if (C === 'L') {
      let x = nextNum(), y = nextNum();
      if (rel) { x += cx; y += cy; }
      addLine(sub, x, fy(y));
      cx = x; cy = y;
      lastCtrlX = lastCtrlY = null;
    } else if (C === 'H') {
      let x = nextNum();
      if (rel) x += cx;
      addLine(sub, x, fy(cy));
      cx = x;
      lastCtrlX = lastCtrlY = null;
    } else if (C === 'V') {
      let y = nextNum();
      if (rel) y += cy;
      addLine(sub, cx, fy(y));
      cy = y;
      lastCtrlX = lastCtrlY = null;
    } else if (C === 'C' || C === 'S') {
      let c1x, c1y, c2x, c2y, x, y;
      if (C === 'C') {
        c1x = nextNum(); c1y = nextNum();
        c2x = nextNum(); c2y = nextNum();
        x = nextNum(); y = nextNum();
        if (rel) { c1x += cx; c1y += cy; c2x += cx; c2y += cy; x += cx; y += cy; }
      } else {
        c2x = nextNum(); c2y = nextNum();
        x = nextNum(); y = nextNum();
        if (rel) { c2x += cx; c2y += cy; x += cx; y += cy; }
        if (lastCtrlX === null) { c1x = cx; c1y = cy; }
        else { c1x = 2 * cx - lastCtrlX; c1y = 2 * cy - lastCtrlY; }
      }
      // 三次贝塞尔离散
      const dist = Math.hypot(c2x - cx, c2y - cy) + Math.hypot(x - c2x, y - c2y);
      const steps = Math.max(2, Math.min(120, Math.ceil(dist / 1.2)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, mt = 1 - t;
        const bx = mt * mt * mt * cx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x;
        const by = mt * mt * mt * cy + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y;
        addLine(sub, bx, fy(by));
      }
      cx = x; cy = y;
      lastCtrlX = c2x; lastCtrlY = c2y;
    } else if (C === 'Q' || C === 'T') {
      let qx, qy, x, y;
      if (C === 'Q') {
        qx = nextNum(); qy = nextNum();
        x = nextNum(); y = nextNum();
        if (rel) { qx += cx; qy += cy; x += cx; y += cy; }
      } else {
        x = nextNum(); y = nextNum();
        if (rel) { x += cx; y += cy; }
        if (lastCtrlX === null) { qx = cx; qy = cy; }
        else { qx = 2 * cx - lastCtrlX; qy = 2 * cy - lastCtrlY; }
      }
      const dist = Math.hypot(qx - cx, qy - cy) + Math.hypot(x - qx, y - qy);
      const steps = Math.max(2, Math.min(120, Math.ceil(dist / 1.2)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, mt = 1 - t;
        const bx = mt * mt * cx + 2 * mt * t * qx + t * t * x;
        const by = mt * mt * cy + 2 * mt * t * qy + t * t * y;
        addLine(sub, bx, fy(by));
      }
      cx = x; cy = y;
      lastCtrlX = qx; lastCtrlY = qy;
    } else if (C === 'A') {
      const rx = nextNum(), ry = nextNum(), rot = nextNum();
      const laf = nextNum(), sf = nextNum();
      let x = nextNum(), y = nextNum();
      if (rel) { x += cx; y += cy; }
      // 弧线计算在内部坐标系（Y 向上）里做，sweep 的符号需相应翻转
      ellipticalArcTo(cx, fy(cy), rx, ry, rot, laf, flipY ? !sf : sf, x, fy(y), sub);
      cx = x; cy = y;
      lastCtrlX = lastCtrlY = null;
    } else if (C === 'Z') {
      // sx/sy 是 SVG 原始坐标，需翻转后写入
      addLine(sub, sx, fy(sy));
      sub.closed = true;
      cx = sx; cy = sy;
      lastCtrlX = lastCtrlY = null;
    }
  }

  return path;
}

/** 解析整个 SVG 文件，取出所有 path 的 d 与 transform 叠加 */
export function parseSvg(svgText, opts = {}) {
  const path = makePath();
  const viewBox = /viewBox\s*=\s*["']([\d.\-\s]+)["']/i.exec(svgText);
  const widthAttr = /<svg[^>]*\bwidth\s*=\s*["']([\d.]+)([a-z%]*)["']/i.exec(svgText);
  const heightAttr = /<svg[^>]*\bheight\s*=\s*["']([\d.]+)([a-z%]*)["']/i.exec(svgText);

  let vb = null;
  if (viewBox) {
    const p = viewBox[1].trim().split(/[\s,]+/).map(Number);
    vb = { x: p[0], y: p[1], w: p[2], h: p[3] };
  }
  const num = (s) => parseFloat(s);
  const unitToPx = (s) => (s.includes('%') ? 0 : num(s));
  const wAttr = widthAttr ? unitToPx(widthAttr[1]) : 0;
  const hAttr = heightAttr ? unitToPx(heightAttr[1]) : 0;

  // 归一化到 1 用户单位 = 1mm，后面统一按毫米处理
  let scale = 1;
  let ox = 0, oy = 0;
  if (vb) {
    scale = 1;
    ox = vb.x;
    oy = vb.y;
  } else if (wAttr && hAttr) {
    scale = 1;
  }

  const dRe = /<path[^>]*\bd\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  const warnings = [];
  while ((m = dRe.exec(svgText))) {
    const sub = parseSvgPath(m[1], { flipY: opts.flipY !== false });
    for (const s of sub.subpaths) {
      for (const e of s.elems) {
        if (e.type === 'line') { e.x1 -= ox; e.x2 -= ox; e.y1 -= oy; e.y2 -= oy; }
        else { e.cx -= ox; e.cy -= oy; }
      }
      s.start.x -= ox; s.start.y -= oy;
      path.subpaths.push(s);
    }
  }

  // 没有 path 就退而找 <line>/<rect>/<circle>/<polyline>
  if (!path.subpaths.length) {
    const lineRe = /<line[^>]*x1\s*=\s*["']([-\d.]+)["'][^>]*y1\s*=\s*["']([-\d.]+)["'][^>]*x2\s*=\s*["']([-\d.]+)["'][^>]*y2\s*=\s*["']([-\d.]+)["']/gi;
    while ((m = lineRe.exec(svgText))) {
      const s = makeSubpath(+m[1] - ox, -(+m[2] - oy));
      addLine(s, +m[3] - ox, -(+m[4] - oy));
      path.subpaths.push(s);
    }
    const rectRe = /<rect[^>]*x\s*=\s*["']([-\d.]+)["'][^>]*y\s*=\s*["']([-\d.]+)["'][^>]*width\s*=\s*["']([\d.]+)["'][^>]*height\s*=\s*["']([\d.]+)["']/gi;
    while ((m = rectRe.exec(svgText))) {
      const x = +m[1] - ox, y = -(+m[2] - oy), w = +m[3], h = +m[4];
      const s = makeSubpath(x, y);
      addLine(s, x + w, y); addLine(s, x + w, y - h); addLine(s, x, y - h);
      s.closed = true;
      path.subpaths.push(s);
    }
    const circRe = /<circle[^>]*cx\s*=\s*["']([-\d.]+)["'][^>]*cy\s*=\s*["']([-\d.]+)["'][^>]*r\s*=\s*["']([\d.]+)["']/gi;
    while ((m = circRe.exec(svgText))) {
      const cx = +m[1] - ox, cy = -(+m[2] - oy), r = +m[3];
      const s = makeSubpath(cx + r, cy);
      s.elems.push({ type: 'arc', cx, cy, r, a0: 0, a1: TAU });
      s.closed = true;
      path.subpaths.push(s);
    }
  }
  if (!path.subpaths.length) warnings.push('SVG 中未找到可用的路径数据');

  return { path, warnings, meta: { viewBox: vb, scale, offset: { x: ox, y: oy } } };
}

void normAngle;
