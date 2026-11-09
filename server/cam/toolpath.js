/**
 * CAM 引擎：路径 → 刀路。
 *
 * 刻字机是「轮廓切割」设备——刀尖沿路径走一遍，把材料沿线切开。
 * 所以 CAM 阶段要做的是：
 *   1. 校核：是否超出幅面（超了会撞机，必须在输出前拦住）
 *   2. 排序：减少空行程（抬刀移动浪费时间，必须从当前机器原点方位就近起刀）
 *   3. 方向：统一顺/逆时针，或交替（顺铣逆铣）
 *   4. 刀路顺序：多层（不同刀）时按层分组
 */

import {
  pathBBox, pathLength, optimizeOrder, setDirection, pruneDegenerate,
  closeNearOpen, countElements, subpathLength, simplifyPath,
  flattenSubpathOpen, addLine, currentPoint,
} from '../geom/path.js';
import { getOriginCorner } from '../machine/hpgl.js';

export const Direction = { CW: 'cw', CCW: 'ccw', ALTERNATE: 'alternate' };

/**
 * 构造一条双语警告。
 *
 * @param {string} zh 中文
 * @param {string} en 英文
 * @returns {{zh:string, en:string}}
 */
function warn(zh, en) {
  return { zh, en };
}

/**
 * 将闭合纯直线子路径的起点旋转到离 refPt 最近的顶点（循环移位，不改变绕向、周长与几何形状）。
 * 解决 SVG/DXF 矩形或闭合轮廓默认以左下角 (minX, minY) 为起点，以及顺逆时针翻转后起点移位，
 * 导致右下角原点机型先横跨整幅图形空走的问题。
 */
export function rotateClosedSubpathsToNearest(path, origin = { x: 0, y: 0 }) {
  let cur = { x: origin.x ?? 0, y: origin.y ?? 0 };
  for (const sub of path.subpaths) {
    if (sub && sub.closed && sub.elems && sub.elems.length >= 2 && sub.elems.every((e) => e.type === 'line')) {
      const pts = flattenSubpathOpen(sub, 0.005);
      if (pts.length >= 3) {
        let bestIdx = 0;
        let bestD = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const d = Math.hypot(pts[i].x - cur.x, pts[i].y - cur.y);
          if (d < bestD) {
            bestD = d;
            bestIdx = i;
          }
        }
        sub.start = { x: pts[bestIdx].x, y: pts[bestIdx].y };
        sub.elems = [];
        for (let k = 1; k <= pts.length; k++) {
          const p = pts[(bestIdx + k) % pts.length];
          addLine(sub, p.x, p.y);
        }
        sub.closed = true;
      }
    }
    cur = currentPoint(sub);
  }
  return path;
}

export function analyze(path, preset, origin = null, originPosition = null) {
  const bbox = pathBBox(path);
  const length = pathLength(path);
  const elems = countElements(path);
  const pos = originPosition || preset?.originPosition || 'bottom-right';
  const mech = getOriginCorner(preset, pos);
  const effOrigin = (origin && (origin.x !== 0 || origin.y !== 0)) ? origin : mech;
  const isRight = pos === 'bottom-right' || pos === 'top-right';
  const isTop   = pos === 'top-right' || pos === 'top-left';

  // 检查是否越过当前工作原点的背侧（会产生负向机器坐标）或超出画布 [0, W]×[0, H]
  const behindX = isRight ? (bbox.maxX > effOrigin.x + 1e-6) : (bbox.minX < effOrigin.x - 1e-6);
  const behindY = isTop   ? (bbox.maxY > effOrigin.y + 1e-6) : (bbox.minY < effOrigin.y - 1e-6);

  const oversize = {
    x: bbox.maxX > preset.width + 1e-6,
    y: bbox.maxY > preset.height + 1e-6,
    left: bbox.minX < -1e-6 || behindX,
    bottom: bbox.minY < -1e-6 || behindY,
  };
  return {
    bbox, length, elems,
    subpathCount: path.subpaths.length,
    oversize,
    fitRatio: {
      w: bbox.w / preset.width,
      h: bbox.h / preset.height,
    },
  };
}

export function compileToolpath(inputPath, preset, options = {}) {
  const warnings = [];
  const path = JSON.parse(JSON.stringify(inputPath)); // 深拷贝，不污染源

  pruneDegenerate(path, 0.005);
  const tolerance = options.tolerance !== undefined ? options.tolerance : 0.02;
  if (tolerance > 0) {
    simplifyPath(path, tolerance);
    pruneDegenerate(path, 0.005);
  }
  if (options.closeOpen !== false) closeNearOpen(path, options.closeTolerance || 0.02);

  const dir = options.direction || Direction.CCW;
  if (dir === Direction.ALTERNATE) {
    let flip = false;
    for (const s of path.subpaths) {
      setDirection({ subpaths: [s] }, !flip);
      flip = !flip;
    }
  } else {
    setDirection(path, dir === Direction.CCW);
  }

  // 根据机器原点方位（如右下角 (width, 0)）确定起刀点，避免从左下角起算造成 Y 轴大幅空走
  const originPos = options.originPosition || preset?.originPosition || 'bottom-right';
  const mechOrigin = getOriginCorner(preset, originPos);
  const effectiveOrigin = (options.origin && (options.origin.x !== 0 || options.origin.y !== 0))
    ? options.origin
    : mechOrigin;

  if (options.optimize !== false) {
    // 先把每个闭合轮廓的起刀顶点旋到距离当前机器原点最近的角点，再做全局最近邻排序與串联旋点
    rotateClosedSubpathsToNearest(path, effectiveOrigin);
    optimizeOrder(path, effectiveOrigin);
    rotateClosedSubpathsToNearest(path, effectiveOrigin);
  }

  const info = analyze(path, preset, effectiveOrigin, originPos);
  if (info.oversize.x || info.oversize.y) {
    warnings.push(warn(
      `图形超出幅面：X 最大 ${info.bbox.maxX.toFixed(1)}mm / Y 最大 ${info.bbox.maxY.toFixed(1)}mm，机器上限 ${preset.width}×${preset.height}mm`,
      `Design exceeds bed: max X ${info.bbox.maxX.toFixed(1)}mm / max Y ${info.bbox.maxY.toFixed(1)}mm, machine limit ${preset.width}×${preset.height}mm`,
    ));
  }
  if (info.oversize.left || info.oversize.bottom) {
    warnings.push(warn(
      '图形有部分超出原点外侧或位于负坐标区域，请先移动到材料有效区域内',
      'Part of the design lies outside the origin bounds (negative coords) — move it into the material area',
    ));
  }
  if (info.length === 0) {
    warnings.push(warn(
      '刀路为空，请检查图形是否过小或已全部被清理',
      'Toolpath is empty — check the design is not too small or was fully pruned',
    ));
  }

  return { path, info, warnings };
}

/** 按刀具/材料分组，每组单独生成指令（不同材料参数不同，速度刀压都不一样） */
export function groupByTool(items) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.materialId || 'default'}`;
    if (!groups.has(key)) {
      groups.set(key, { materialId: key, materialName: it.materialName || '默认', items: [] });
    }
    groups.get(key).items.push(it);
  }
  return [...groups.values()];
}

/**
 * 预估刻绘时间。
 */
export function estimateTime(path, cutSpeed, rapidRatio = 4) {
  let cutLen = 0, rapidLen = 0;
  let prev = null;
  for (const sub of path.subpaths) {
    if (prev) rapidLen += Math.hypot(sub.start.x - prev.x, sub.start.y - prev.y);
    cutLen += subpathLength(sub);
    const elems = sub.elems;
    const last = elems[elems.length - 1];
    if (last) {
      prev = last.type === 'line' ? { x: last.x2, y: last.y2 } : null;
    }
  }
  const rapidSpeed = cutSpeed * rapidRatio;
  const cutSec = cutLen / Math.max(1, cutSpeed);
  const rapidSec = rapidLen / Math.max(1, rapidSpeed);
  return {
    cutLengthMm: cutLen,
    rapidLengthMm: rapidLen,
    cutSeconds: cutSec,
    rapidSeconds: rapidSec,
    totalSeconds: cutSec + rapidSec,
  };
}

export { pathBBox, pathLength };
