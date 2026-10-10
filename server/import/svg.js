/**
 * SVG 解析（d 属性与完整 SVG 文件解析）。
 * 覆盖 SVG 1.1 全部路径命令：M L H V C S Q T A Z（及其小写相对形式），
 * 以及 <circle>, <ellipse>, <rect>, <line>, <polyline>, <polygon>，
 * 支持 <g> 分组与 transform 矩阵级联。
 *
 * 注意坐标系：SVG 的 Y 轴向下，内部模型 Y 轴向上。
 * 解析阶段保持 SVG 原始数值，由调用方决定是否翻转；这里默认按 flipY 选项翻转。
 */

import {
  makePath, makeSubpath, addLine, DEG, TAU,
  circleToPath, ellipseToPath, polylineToPath,
  matrixTranslate, matrixScale, matrixRotate, matrixMultiply,
  matrixTranslateXY, applyMatrixToPath, IDENTITY, normAngle,
} from '../geom/path.js';

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

  let sub = null;
  let cx = 0, cy = 0;      // 当前点（SVG 原始坐标）
  let sx = 0, sy = 0;      // 子路径起点（SVG 原始坐标）
  let lastCtrlX = null, lastCtrlY = null;
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
      ellipticalArcTo(cx, fy(cy), rx, ry, rot, laf, flipY ? !sf : sf, x, fy(y), sub);
      cx = x; cy = y;
      lastCtrlX = lastCtrlY = null;
    } else if (C === 'Z') {
      addLine(sub, sx, fy(sy));
      sub.closed = true;
      cx = sx; cy = sy;
      lastCtrlX = lastCtrlY = null;
    }
  }

  return path;
}

/** 属性提取：支持任意顺序、双引号或单引号 */
function parseAttributes(tagStr) {
  const attrs = {};
  const attrRe = /([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = attrRe.exec(tagStr))) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

/** 解析 transform 属性：matrix, translate, scale, rotate */
function parseTransform(str) {
  if (!str) return IDENTITY;
  let current = IDENTITY;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]+)\)/gi;
  let m;
  while ((m = re.exec(str))) {
    const type = m[1].toLowerCase();
    const args = m[2].trim().split(/[\s,]+/).map(Number);
    let mat = IDENTITY;
    if (type === 'matrix' && args.length >= 6) {
      mat = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
    } else if (type === 'translate') {
      mat = matrixTranslate(args[0] || 0, args[1] !== undefined ? args[1] : 0);
    } else if (type === 'scale') {
      mat = matrixScale(args[0] || 1, args[1] !== undefined ? args[1] : args[0]);
    } else if (type === 'rotate') {
      mat = matrixRotate(args[0] || 0, args[1] || 0, args[2] || 0);
    }
    current = matrixMultiply(current, mat);
  }
  return current;
}

/** 把 SVG 空间变换矩阵转为内部 Y-up 空间的等价矩阵 */
function toInternalMatrix(mSvg, flipY) {
  if (!flipY) return mSvg;
  return {
    a: mSvg.a,
    b: -mSvg.b,
    c: -mSvg.c,
    d: mSvg.d,
    e: mSvg.e,
    f: -mSvg.f,
  };
}

/** 解析 points 属性："x1,y1 x2,y2 ..." 或 "x1 y1 x2 y2" */
function parsePoints(str) {
  if (!str) return [];
  const nums = str.trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));
  const pts = [];
  for (let i = 0; i < nums.length - 1; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] });
  }
  return pts;
}

/** 解析整个 SVG 文件，提取全部图元，支持 Group/Ungroup 元数据 */
export function parseSvg(svgText, opts = {}) {
  const flipY = opts.flipY !== false;
  const path = makePath();
  const elements = [];
  const warnings = [];

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

  let scale = 1;
  let ox = 0, oy = 0;
  if (vb) {
    scale = 1;
    ox = vb.x;
    oy = vb.y;
  } else if (wAttr && hAttr) {
    scale = 1;
  }

  // 标签扫描器，按文档流顺序识别标签与 <g> 嵌套
  const tagRe = /<(\/?[a-zA-Z0-9:_-]+)([^>]*?)(\/?)>/g;
  let m;
  const groupStack = []; // 存 { tag, transform, id }
  let elemCounter = 0;

  // 偏移平移辅助：把路径从 SVG 原点平移 ox, oy（已考虑 flipY）
  const applyOffset = (p) => {
    for (const s of p.subpaths) {
      for (const e of s.elems) {
        if (e.type === 'line') {
          e.x1 -= ox; e.x2 -= ox;
          e.y1 += (flipY ? oy : -oy);
          e.y2 += (flipY ? oy : -oy);
        } else {
          e.cx -= ox;
          e.cy += (flipY ? oy : -oy);
        }
      }
      s.start.x -= ox;
      s.start.y += (flipY ? oy : -oy);
    }
  };

  while ((m = tagRe.exec(svgText))) {
    const rawTag = m[1].toLowerCase();
    const attrsStr = m[2];
    const isSelfClosing = m[3] === '/' || attrsStr.trim().endsWith('/');
    const isClosing = rawTag.startsWith('/');

    if (isClosing) {
      const realTag = rawTag.slice(1);
      if (groupStack.length && groupStack[groupStack.length - 1].tag === realTag) {
        groupStack.pop();
      }
      continue;
    }

    const attrs = parseAttributes(attrsStr);
    const elemTransform = parseTransform(attrs.transform);

    // 检查是否在非渲染容器内（defs, clipPath, mask, pattern, style）
    const inNonRenderable = groupStack.some((g) => ['defs', 'clippath', 'mask', 'pattern', 'style'].includes(g.tag));

    if (rawTag === 'g' || rawTag === 'defs' || rawTag === 'clippath' || rawTag === 'mask' || rawTag === 'pattern') {
      const parentMat = groupStack.length ? groupStack[groupStack.length - 1].accumTransform : IDENTITY;
      const accumTransform = matrixMultiply(parentMat, elemTransform);
      groupStack.push({ tag: rawTag, accumTransform, id: attrs.id || null });
      if (isSelfClosing) groupStack.pop();
      continue;
    }

    if (inNonRenderable) continue;
    if (attrs.display === 'none' || attrs.visibility === 'hidden') continue;

    // 计算当前元素在 SVG 空间的累计变换矩阵
    const parentMat = groupStack.length ? groupStack[groupStack.length - 1].accumTransform : IDENTITY;
    const totalSvgMat = matrixMultiply(parentMat, elemTransform);
    const hasTransform = !(totalSvgMat.a === 1 && totalSvgMat.b === 0 && totalSvgMat.c === 0 && totalSvgMat.d === 1 && totalSvgMat.e === 0 && totalSvgMat.f === 0);

    let elemPath = null;
    let elemType = rawTag;
    let elemDefaultName = '';

    if (rawTag === 'path') {
      const d = attrs.d;
      if (d) {
        elemPath = parseSvgPath(d, { flipY });
        elemType = 'path';
        elemDefaultName = '路径';
      }
    } else if (rawTag === 'circle') {
      const cx = parseFloat(attrs.cx || 0);
      const cy = parseFloat(attrs.cy || 0);
      const r = parseFloat(attrs.r || 0);
      if (r > 0) {
        elemPath = circleToPath(cx, flipY ? -cy : cy, r);
        elemType = 'circle';
        elemDefaultName = '圆形';
      }
    } else if (rawTag === 'ellipse') {
      const cx = parseFloat(attrs.cx || 0);
      const cy = parseFloat(attrs.cy || 0);
      const rx = parseFloat(attrs.rx || 0);
      const ry = parseFloat(attrs.ry || 0);
      if (rx > 0 && ry > 0) {
        elemPath = ellipseToPath(cx, flipY ? -cy : cy, rx, ry);
        elemType = 'ellipse';
        elemDefaultName = '椭圆';
      }
    } else if (rawTag === 'rect') {
      const x = parseFloat(attrs.x || 0);
      const y = parseFloat(attrs.y || 0);
      const w = parseFloat(attrs.width || 0);
      const h = parseFloat(attrs.height || 0);
      const rx = Math.max(0, parseFloat(attrs.rx || 0));
      const ry = Math.max(0, parseFloat(attrs.ry || attrs.rx || 0));
      if (w > 0 && h > 0) {
        elemPath = makePath();
        const topY = flipY ? -y : y;
        const botY = flipY ? -(y + h) : (y + h);
        if (rx > 0 || ry > 0) {
          // 圆角矩形
          const effRx = Math.min(rx, w / 2);
          const effRy = Math.min(ry || effRx, h / 2);
          const s = makeSubpath(x + effRx, topY);
          addLine(s, x + w - effRx, topY);
          s.elems.push({ type: 'arc', cx: x + w - effRx, cy: flipY ? topY + effRy : topY - effRy, r: effRx, a0: flipY ? -Math.PI / 2 : Math.PI / 2, a1: 0 });
          addLine(s, x + w, botY - (flipY ? effRy : -effRy));
          s.elems.push({ type: 'arc', cx: x + w - effRx, cy: flipY ? botY - effRy : botY + effRy, r: effRx, a0: 0, a1: flipY ? Math.PI / 2 : -Math.PI / 2 });
          addLine(s, x + effRx, botY);
          s.elems.push({ type: 'arc', cx: x + effRx, cy: flipY ? botY - effRy : botY + effRy, r: effRx, a0: flipY ? Math.PI / 2 : -Math.PI / 2, a1: Math.PI });
          addLine(s, x, topY + (flipY ? effRy : -effRy));
          s.elems.push({ type: 'arc', cx: x + effRx, cy: flipY ? topY + effRy : topY - effRy, r: effRx, a0: Math.PI, a1: flipY ? 3 * Math.PI / 2 : Math.PI / 2 });
          s.closed = true;
          elemPath.subpaths.push(s);
        } else {
          // 标准直角矩形
          const s = makeSubpath(x, topY);
          addLine(s, x + w, topY);
          addLine(s, x + w, botY);
          addLine(s, x, botY);
          s.closed = true;
          elemPath.subpaths.push(s);
        }
        elemType = 'rect';
        elemDefaultName = '矩形';
      }
    } else if (rawTag === 'line') {
      const x1 = parseFloat(attrs.x1 || 0);
      const y1 = parseFloat(attrs.y1 || 0);
      const x2 = parseFloat(attrs.x2 || 0);
      const y2 = parseFloat(attrs.y2 || 0);
      elemPath = makePath();
      const s = makeSubpath(x1, flipY ? -y1 : y1);
      addLine(s, x2, flipY ? -y2 : y2);
      elemPath.subpaths.push(s);
      elemType = 'line';
      elemDefaultName = '直线';
    } else if (rawTag === 'polyline' || rawTag === 'polygon') {
      const pts = parsePoints(attrs.points);
      if (pts.length >= 2) {
        elemPath = polylineToPath(
          pts.map((p) => ({ x: p.x, y: flipY ? -p.y : p.y })),
          rawTag === 'polygon'
        );
        elemType = rawTag;
        elemDefaultName = rawTag === 'polygon' ? '多边形' : '折线';
      }
    }

    if (elemPath && elemPath.subpaths.length) {
      elemCounter++;
      // 若有变换矩阵，将其转为内部 Y-up 矩阵并应用
      if (hasTransform) {
        const matInt = toInternalMatrix(totalSvgMat, flipY);
        applyMatrixToPath(elemPath, matInt);
      }
      // 减去 viewBox 原点偏移
      applyOffset(elemPath);

      const elemId = attrs.id || `elem_${elemCounter}`;
      const elemName = attrs.id || `${elemDefaultName} ${elemCounter}`;

      elements.push({
        id: elemId,
        name: elemName,
        type: elemType,
        subpaths: elemPath.subpaths,
      });

      for (const s of elemPath.subpaths) {
        path.subpaths.push(s);
      }
    }
  }

  if (!path.subpaths.length) {
    warnings.push({ zh: 'SVG 中未找到可用的路径数据', en: 'No usable path data found in the SVG' });
  }

  return { path, elements, warnings, meta: { viewBox: vb, scale, offset: { x: ox, y: oy } } };
}

void normAngle;
