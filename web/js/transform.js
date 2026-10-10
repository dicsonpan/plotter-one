/**
 * 图形变换：移动、缩放、旋转。
 *
 * 设计要点：**变换改的是数据，不是显示。**
 * 早期想法是在渲染层做偏移与缩放，看起来能拖能动，但刻出来的东西还在原地——
 * 这是最坏的一类 bug：屏幕上一切正常，上机才发现。
 * 所以这里统一把变换烘焙进路径几何，改完立刻是最终坐标。
 *
 * 坐标系与全局一致：毫米、Y 向上、原点在材料左下角。
 * 缩放围绕图形自身包围盒中心，与 Inkscape 的对象缩放手感一致。
 */

import {
  pathBBox, applyMatrixToPath, matrixTranslate, matrixScale,
  matrixRotate, matrixMultiply, IDENTITY,
} from '../geom.js';

/** 数值吸附：把浮点误差收敛掉，避免缩放多次后坐标出现 12.999999 */
const snap = (v) => Math.round(v * 1000) / 1000;

/**
 * 读取一个图层的包围盒。
 * @returns {{minX,minY,maxX,maxY,w,h,cx,cy}} 空图层返回全 0
 */
export function layerBBox(layer) {
  const path = { subpaths: layer.subpaths };
  if (!layer.subpaths.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, cx: 0, cy: 0 };
  }
  const bb = pathBBox(path);
  return {
    minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY,
    w: bb.w, h: bb.h,
    // pathBBox 不给中心，这里补上——缩放/旋转默认都以自身中心为基准
    cx: (bb.minX + bb.maxX) / 2,
    cy: (bb.minY + bb.maxY) / 2,
  };
}

/**
 * 平移整个图层。
 * @param {number} dx,dy 位移（mm）
 */
export function translateLayer(layer, dx, dy) {
  if (!dx && !dy) return layer;
  const m = matrixTranslate(snap(dx), snap(dy));
  layer.subpaths = applyMatrixToPath({ subpaths: layer.subpaths }, m).subpaths;
  if (layer.children) {
    for (const c of layer.children) {
      c.subpaths = applyMatrixToPath({ subpaths: c.subpaths }, m).subpaths;
    }
  }
  return layer;
}

/**
 * 缩放图层。
 *
 * 围绕图形自身包围盒中心缩放（不是原点），符合「拿着这个对象放大」的操作直觉。
 * 非等比缩放时圆弧会退化为折线——几何内核的行为，避免在这里重复实现。
 *
 * @param {number} sx,sy 缩放倍数
 * @param {number} [cx,cy] 缩放中心，默认取包围盒中心
 * @param {number} [minSize] 缩放后的最小边长（mm），防止缩成一团导致刻不出来
 */
export function scaleLayer(layer, sx, sy, cx, cy, minSize = 0.05) {
  const bb = layerBBox(layer);
  if (!bb.w && !bb.h) return layer;
  const px = cx === undefined ? bb.cx : cx;
  const py = cy === undefined ? bb.cy : cy;

  // 限幅：避免一次缩放 100 倍把坐标撑到天文数字，或 0.01 倍缩成一个点
  let fx = Math.max(0.01, Math.min(100, sx));
  let fy = Math.max(0.01, Math.min(100, sy));

  // 保证结果不小于最小尺寸
  if (bb.w * fx < minSize) fx = minSize / Math.max(bb.w, 1e-6);
  if (bb.h * fy < minSize) fy = minSize / Math.max(bb.h, 1e-6);

  // 围绕 (px,py) 缩放：先移到中心 → 缩放 → 移回
  const m = matrixMultiply(
    matrixTranslate(px, py),
    matrixMultiply(matrixScale(fx, fy), matrixTranslate(-px, -py))
  );
  layer.subpaths = applyMatrixToPath({ subpaths: layer.subpaths }, m).subpaths;
  if (layer.children) {
    for (const c of layer.children) {
      c.subpaths = applyMatrixToPath({ subpaths: c.subpaths }, m).subpaths;
    }
  }
  return layer;
}

/**
 * 旋转图层。
 * @param {number} deg 角度（度，逆时针为正）
 * @param {number} [cx,cy] 旋转中心，默认取包围盒中心
 */
export function rotateLayer(layer, deg, cx, cy) {
  if (!deg) return layer;
  const bb = layerBBox(layer);
  if (!bb.w && !bb.h) return layer;
  const px = cx === undefined ? bb.cx : cx;
  const py = cy === undefined ? bb.cy : cy;
  const m = matrixMultiply(
    matrixTranslate(px, py),
    matrixMultiply(matrixRotate(deg), matrixTranslate(-px, -py))
  );
  layer.subpaths = applyMatrixToPath({ subpaths: layer.subpaths }, m).subpaths;
  if (layer.children) {
    for (const c of layer.children) {
      c.subpaths = applyMatrixToPath({ subpaths: c.subpaths }, m).subpaths;
    }
  }
  return layer;
}

/**
 * 直接设置图层的位置：把包围盒左上角挪到指定坐标。
 * 用于「坐标 / 大小」这类数值输入框——比让用户算偏移量直观得多。
 *
 * @param {number} x,y 目标包围盒左上角（mm）
 */
export function setLayerPosition(layer, x, y) {
  const bb = layerBBox(layer);
  return translateLayer(layer, snap(x - bb.minX), snap(y - bb.minY));
}

/**
 * 直接设置图层尺寸：按倍数缩放到指定宽高（保持目标宽高比）。
 * @param {number} w,h 目标宽高（mm）
 * @param {boolean} [keepRatio=true] 是否锁定比例
 */
export function setLayerSize(layer, w, h, keepRatio = true) {
  const bb = layerBBox(layer);
  if (!bb.w || !bb.h) return layer;
  let sx = w / bb.w;
  let sy = h / bb.h;
  if (keepRatio) {
    // 以较小的倍数为准，保证图形完整落在目标框内
    const s = Math.min(sx, sy);
    sx = s; sy = s;
  }
  return scaleLayer(layer, sx, sy, bb.cx, bb.cy);
}

/**
 * 把图层平移到材料框内（不改变形状）。
 * @param {number} width,height 材料幅面尺寸
 * @param {number} [margin=2] 留边（mm）
 */
export function clampLayerIntoBed(layer, width, height, margin = 2) {
  const bb = layerBBox(layer);
  let dx = 0, dy = 0;
  if (bb.minX < margin) dx = margin - bb.minX;
  else if (bb.maxX > width - margin) dx = (width - margin) - bb.maxX;
  if (bb.minY < margin) dy = margin - bb.minY;
  else if (bb.maxY > height - margin) dy = (height - margin) - bb.maxY;
  return translateLayer(layer, snap(dx), snap(dy));
}

/**
 * 整层复制。复制出来的新图层紧邻原图层，便于做小幅调整再对比。
 *
 * ⚠️ 这里**不**给副本加「副本」后缀——图层名是要显示给用户看的，
 * 而「副本」这个词属于语言问题。调用方（app.js）用当前语言自己起名，
 * 否则这里写死中文，英文界面就会露出一个中文图层名。
 * 所以只复制，命名权交给调用方。
 */
export function duplicateLayer(layer) {
  return {
    id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6),
    name: layer.name,
    subpaths: JSON.parse(JSON.stringify(layer.subpaths)),
    hidden: false,
    isGroup: !!layer.isGroup,
    children: layer.children ? JSON.parse(JSON.stringify(layer.children)) : null,
  };
}

export { IDENTITY };
