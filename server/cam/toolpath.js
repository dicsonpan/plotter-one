/**
 * CAM 引擎：路径 → 刀路。
 *
 * 刻字机是「轮廓切割」设备——刀尖沿路径走一遍，把材料沿线切开。
 * 所以 CAM 阶段要做的是：
 *   1. 校核：是否超出幅面（超了会撞机，必须在输出前拦住）
 *   2. 排序：减少空行程（抬刀移动浪费时间）
 *   3. 方向：统一顺/逆时针，或交替（顺铣逆铣）
 *   4. 刀路顺序：多层（不同刀）时按层分组
 *
 * 关于刻字机的物理特性：切 PVC/亚克力时，顺铣（顺进给方向）刀口无毛边，
 * 逆铣有。所以整版统一一个方向，而不是交替——交替是铣削的做法。
 * 交替方向留给需要时（比如切多层材料防积屑）。
 */

import {
  pathBBox, pathLength, optimizeOrder, setDirection, pruneDegenerate,
  closeNearOpen, countElements, subpathLength, simplifyPath,
} from '../geom/path.js';

export const Direction = { CW: 'cw', CCW: 'ccw', ALTERNATE: 'alternate' };

/**
 * 构造一条双语警告。
 *
 * 返回 `{ zh, en }` 而不是纯字符串，是为了让它能原样序列化给前端，
 * 由前端按当前语言挑选（见 web/js/app.js 的 pickLang）。
 * 保留字符串形态的兼容性很重要：任何还在 `warnings.push('...')` 的地方
 * 都不会崩，只是英文界面下会显示中文——**降级而不是崩溃**。
 *
 * @param {string} zh 中文
 * @param {string} en 英文
 * @returns {{zh:string, en:string}}
 */
function warn(zh, en) {
  return { zh, en };
}


export function analyze(path, preset, origin = { x: 0, y: 0 }) {
  const bbox = pathBBox(path);
  const length = pathLength(path);
  const elems = countElements(path);
  const ox = origin?.x || 0, oy = origin?.y || 0;
  const oversize = {
    x: bbox.maxX > preset.width,
    y: bbox.maxY > preset.height,
    left: bbox.minX < ox,
    bottom: bbox.minY < oy,
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
  // CAM 几何层抽稀与共线合并优化：
  // 默认容差 0.02mm，小于力宇 1000 步/英寸（0.0254mm/step）物理脉冲，
  // 刀尖物理刃宽一般 0.2~0.5mm，0.02mm 抽稀既能保证绝对高精度，
  // 又能把密集折线/SVG过度采样的 20~30 万点暴降 80%~90%。
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

  const origin = options.origin || { x: 0, y: 0 };
  if (options.optimize !== false) {
    optimizeOrder(path, origin);
  }

  const info = analyze(path, preset, origin);
  if (info.oversize.x || info.oversize.y) {
    warnings.push(warn(
      `图形超出幅面：X 最大 ${info.bbox.maxX.toFixed(1)}mm / Y 最大 ${info.bbox.maxY.toFixed(1)}mm，机器上限 ${preset.width}×${preset.height}mm`,
      `Design exceeds bed: max X ${info.bbox.maxX.toFixed(1)}mm / max Y ${info.bbox.maxY.toFixed(1)}mm, machine limit ${preset.width}×${preset.height}mm`,
    ));
  }
  if (info.oversize.left || info.oversize.bottom) {
    warnings.push(warn(
      '图形有部分位于原点左下方（负坐标），请先移动到材料区域内',
      'Part of the design lies left/below the origin (negative coords) — move it into the material area',
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
 * 切割时间 = 切割长度 / 速度
 * 快移时间 = 空行程长度 / 快移速度（通常比切割快 3-5 倍）
 * 注意：这只是理论值，不含机器加减速与延迟抬刀
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
