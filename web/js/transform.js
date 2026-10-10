/**
 * 图形变换：移动、缩放、旋转、镜像（翻转）。
 *
 * 设计要点：变换改的是数据几何本身，不是显示偏移。
 * 坐标系与全局一致：毫米、Y 向上、原点在材料左下角。
 */

import {
  pathBBox, applyMatrixToPath, matrixTranslate, matrixScale,
  matrixRotate, matrixMultiply, IDENTITY,
} from '../geom.js';

/** 数值吸附：把浮点误差收敛掉 */
const snap = (v) => Math.round(v * 1000) / 1000;

function applyMatrixDeep(obj, m) {
  if (!obj) return;
  if (obj.subpaths && obj.subpaths.length) {
    obj.subpaths = applyMatrixToPath({ subpaths: obj.subpaths }, m).subpaths;
  }
  if (Array.isArray(obj.children)) {
    for (const c of obj.children) {
      applyMatrixDeep(c, m);
    }
  }
}

/**
 * 读取一个图层的包围盒。
 * @returns {{minX,minY,maxX,maxY,w,h,cx,cy}} 空图层返回全 0
 */
export function layerBBox(layer) {
  if (!layer) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, cx: 0, cy: 0 };
  let subs = layer.subpaths;
  if ((!subs || !subs.length) && layer.children && layer.children.length) {
    subs = layer.children.flatMap((c) => c.subpaths || []);
  }
  if (!subs || !subs.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, cx: 0, cy: 0 };
  }
  const bb = pathBBox({ subpaths: subs });
  return {
    minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY,
    w: bb.w, h: bb.h,
    cx: (bb.minX + bb.maxX) / 2,
    cy: (bb.minY + bb.maxY) / 2,
  };
}

/**
 * 平移整个图层（支持编组与嵌套子元素递归同步）。
 * @param {object} layer
 * @param {number} dx,dy 位移（mm）
 */
export function translateLayer(layer, dx, dy) {
  if (!dx && !dy) return layer;
  const m = matrixTranslate(snap(dx), snap(dy));
  applyMatrixDeep(layer, m);
  return layer;
}

/**
 * 缩放图层（支持镜像翻转的负比例）。
 * @param {object} layer
 * @param {number} sx,sy 缩放倍数
 * @param {number} [cx,cy] 缩放中心，默认取包围盒中心
 * @param {number} [minSize] 缩放后的最小绝对尺寸（mm）
 */
export function scaleLayer(layer, sx, sy, cx, cy, minSize = 0.05) {
  const bb = layerBBox(layer);
  if (!bb.w && !bb.h) return layer;
  const px = cx === undefined ? bb.cx : cx;
  const py = cy === undefined ? bb.cy : cy;

  const signX = sx < 0 ? -1 : 1;
  const signY = sy < 0 ? -1 : 1;
  let fx = Math.max(0.01, Math.min(100, Math.abs(sx))) * signX;
  let fy = Math.max(0.01, Math.min(100, Math.abs(sy))) * signY;

  if (bb.w * Math.abs(fx) < minSize) fx = (minSize / Math.max(bb.w, 1e-6)) * signX;
  if (bb.h * Math.abs(fy) < minSize) fy = (minSize / Math.max(bb.h, 1e-6)) * signY;

  const m = matrixMultiply(
    matrixTranslate(px, py),
    matrixMultiply(matrixScale(fx, fy), matrixTranslate(-px, -py))
  );
  applyMatrixDeep(layer, m);
  return layer;
}

/**
 * 镜像（翻转）图层。
 * @param {object} layer
 * @param {boolean} flipX 水平镜像
 * @param {boolean} flipY 垂直镜像
 * @param {number} [cx,cy] 镜像中心，默认取自身包围盒中心
 */
export function flipLayer(layer, flipX = true, flipY = false, cx, cy) {
  const bb = layerBBox(layer);
  if (!bb.w && !bb.h) return layer;
  const px = cx === undefined ? bb.cx : cx;
  const py = cy === undefined ? bb.cy : cy;
  const sx = flipX ? -1 : 1;
  const sy = flipY ? -1 : 1;
  const m = matrixMultiply(
    matrixTranslate(px, py),
    matrixMultiply(matrixScale(sx, sy), matrixTranslate(-px, -py))
  );
  applyMatrixDeep(layer, m);
  return layer;
}

/**
 * 旋转图层。
 * @param {object} layer
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
  applyMatrixDeep(layer, m);
  return layer;
}

/** 把包围盒左上角挪到指定坐标 */
export function setLayerPosition(layer, x, y) {
  const bb = layerBBox(layer);
  return translateLayer(layer, snap(x - bb.minX), snap(y - bb.minY));
}

/** 按倍数缩放到指定宽高 */
export function setLayerSize(layer, w, h, keepRatio = true) {
  const bb = layerBBox(layer);
  if (!bb.w || !bb.h) return layer;
  let sx = w / bb.w;
  let sy = h / bb.h;
  if (keepRatio) {
    const s = Math.min(sx, sy);
    sx = s; sy = s;
  }
  return scaleLayer(layer, sx, sy, bb.cx, bb.cy);
}

/** 把图层平移到材料框内 */
export function clampLayerIntoBed(layer, width, height, margin = 2) {
  const bb = layerBBox(layer);
  let dx = 0, dy = 0;
  if (bb.minX < margin) dx = margin - bb.minX;
  else if (bb.maxX > width - margin) dx = (width - margin) - bb.maxX;
  if (bb.minY < margin) dy = margin - bb.minY;
  else if (bb.maxY > height - margin) dy = (height - margin) - bb.maxY;
  return translateLayer(layer, snap(dx), snap(dy));
}

/** 整层复制 */
export function duplicateLayer(layer) {
  return {
    id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6),
    name: layer.name,
    subpaths: structuredClone(layer.subpaths),
    hidden: false,
    isGroup: !!layer.isGroup,
    children: layer.children ? structuredClone(layer.children) : null,
    rotation: layer.rotation || 0,
  };
}

export { IDENTITY };
