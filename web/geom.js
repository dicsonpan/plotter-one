/**
 * 几何内核：路径模型、仿射变换、圆弧处理、路径优化。
 *
 * 设计要点：内部统一用「毫米」为单位的浮点数。Y 轴向上为正（数学惯例），
 * 与 SVG 的 Y 轴向下不同，在导入层统一翻转，避免每个模块各自纠错。
 *
 * 路径用混合图元表示：直线段 + 圆弧段。刻字机走 9600 波特，
 * 一个 G00 快移三点五线就要 18 字节，若把圆弧全离散成折线，
 * 一条 10mm 半径的整圆会从 20 字节膨胀到 300+ 字节。
 * 所以保弧是硬需求，不是优化。
 */

const EPS = 1e-9;
const TAU = Math.PI * 2;

export { EPS, TAU };
export const DEG = Math.PI / 180;

export function nearlyEqual(a, b, eps = 1e-7) {
  return Math.abs(a - b) <= eps;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 规范化角度到 [0, 2π) */
export function normAngle(a) {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** 两个角度之间的有向差 (b - a)，落在 (-π, π] */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

// ---------------------------------------------------------------------------
// 路径模型
// ---------------------------------------------------------------------------
// 图元：{ type:'line', x1,y1,x2,y2 } | { type:'arc', cx,cy,r,a0,a1 }
// a0/a1 为弧的起止角（弧度，逆时针为正）。arc 为逆时针，cw 为顺时针。
// 路径：{ subpaths:[ {start:{x,y}, elems:[], closed:bool, id } ], meta:{} }

export function makePath() {
  return { subpaths: [], meta: {} };
}

export function makeSubpath(x, y, id) {
  return { id: id || null, start: { x, y }, elems: [], closed: false };
}

export function currentPoint(sub) {
  if (!sub.elems.length) return { x: sub.start.x, y: sub.start.y };
  const last = sub.elems[sub.elems.length - 1];
  if (last.type === 'line') return { x: last.x2, y: last.y2 };
  if (last.type === 'ellipse') return ellipseEnd(last);
  return arcEnd(last);
}

export function arcEnd(a) {
  return { x: a.cx + a.r * Math.cos(a.a1), y: a.cy + a.r * Math.sin(a.a1) };
}

export function ellipseEnd(e) {
  return { x: e.cx + e.rx * Math.cos(e.a1), y: e.cy + e.ry * Math.sin(e.a1) };
}

export function arcStart(a) {
  return { x: a.cx + a.r * Math.cos(a.a0), y: a.cy + a.r * Math.sin(a.a0) };
}

export function addLine(sub, x2, y2) {
  const p = currentPoint(sub);
  if (nearlyEqual(p.x, x2, 1e-9) && nearlyEqual(p.y, y2, 1e-9)) return;
  sub.elems.push({ type: 'line', x1: p.x, y1: p.y, x2, y2 });
}

export function addArc(sub, cx, cy, r, a0, a1) {
  sub.elems.push({ type: 'arc', cx, cy, r, a0, a1 });
}

/** 折线转路径（离散点集） */
export function polylineToPath(points, closed = false) {
  const p = makePath();
  if (!points || points.length < 2) return p;
  const sub = makeSubpath(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) addLine(sub, points[i].x, points[i].y);
  sub.closed = closed;
  p.subpaths.push(sub);
  return p;
}

/** 整圆 */
export function circleToPath(cx, cy, r, ccw = false) {
  const p = makePath();
  const a0 = 0;
  const a1 = ccw ? -TAU : TAU;
  const sub = makeSubpath(cx + r, cy);
  sub.elems.push({ type: 'arc', cx, cy, r, a0, a1 });
  sub.closed = true;
  p.subpaths.push(sub);
  return p;
}

/** 椭圆：HPGL 有 EA 指令可原生支持，这里优先输出真椭圆 */
export function ellipseToPath(cx, cy, rx, ry, ccw = false) {
  if (nearlyEqual(rx, ry, 1e-6)) return circleToPath(cx, cy, rx, ccw);
  const p = makePath();
  const sub = makeSubpath(cx + rx, cy);
  sub.elems.push({
    type: 'ellipse',
    cx, cy, rx, ry,
    a0: 0,
    a1: ccw ? -TAU : TAU,
  });
  sub.closed = true;
  p.subpaths.push(sub);
  return p;
}

// ---------------------------------------------------------------------------
// 圆弧离散
// ---------------------------------------------------------------------------

/** 椭圆段离散为折线点（不含起点，含终点）；Ramanujan 周长近似 */
export function flattenEllipse(e, maxSagitta = 0.005) {
  const a = e.rx, b = e.ry;
  const sweep = e.a1 - e.a0;
  const abs = Math.abs(sweep);
  if (abs < 1e-9) return [];
  const h = [a * a, b * b];
  const ram = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const rMax = Math.max(a, b);
  let step = rMax <= maxSagitta ? Math.PI : 2 * Math.acos(clamp(1 - maxSagitta / rMax, -1, 1));
  const n = Math.max(4, Math.ceil((abs / TAU) * (ram / step)));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = e.a0 + (sweep * i) / n;
    pts.push({ x: e.cx + a * Math.cos(t), y: e.cy + b * Math.sin(t) });
  }
  void h;
  return pts;
}

/** 圆弧段离散为折线点（不含起点，含终点） */
export function flattenArc(arc, maxSagitta = 0.005) {
  const r = arc.r;
  if (r <= 0) return [];
  const sweep = arc.a1 - arc.a0;
  const abs = Math.abs(sweep);
  if (abs < 1e-9) return [];
  // 弦高 h = r(1-cos(θ/2)) → θ = 2*acos(1 - h/r)
  let step;
  if (r <= maxSagitta) step = Math.PI;
  else step = 2 * Math.acos(clamp(1 - maxSagitta / r, -1, 1));
  const n = Math.max(2, Math.ceil(abs / step));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = arc.a0 + (sweep * i) / n;
    pts.push({ x: arc.cx + r * Math.cos(t), y: arc.cy + r * Math.sin(t) });
  }
  return pts;
}

/** 整个子路径离散成点串（用于渲染与长度计算）。闭合子路径补上回到起点的点 */
export function flattenSubpath(sub, maxSagitta = 0.005) {
  const pts = [{ x: sub.start.x, y: sub.start.y }];
  for (const e of sub.elems) {
    if (e.type === 'line') pts.push({ x: e.x2, y: e.y2 });
    else if (e.type === 'ellipse') pts.push(...flattenEllipse(e, maxSagitta));
    else pts.push(...flattenArc(e, maxSagitta));
  }
  if (needsClosingEdge(sub)) pts.push({ x: sub.start.x, y: sub.start.y });
  return pts;
}

/** 闭合子路径的离散点串，末尾不重复起点（渲染用，配合 close() 闭合） */
export function flattenSubpathOpen(sub, maxSagitta = 0.005) {
  const pts = flattenSubpath(sub, maxSagitta);
  if (needsClosingEdge(sub) && pts.length > 1) pts.pop();
  return pts;
}

/** 整个路径离散 */
export function flattenPath(path, maxSagitta = 0.005) {
  return path.subpaths.map((s) => ({
    points: flattenSubpath(s, maxSagitta),
    closed: s.closed,
    id: s.id,
  }));
}

// ---------------------------------------------------------------------------
// 长度与包围盒
// ---------------------------------------------------------------------------

/**
 * 闭合子路径隐含一条回到起点的边。
 * 几何上 closed=true 就意味着这条边存在，各处（长度/面积/离散）必须一致处理，
 * 否则矩形会少算一边。这里给出「是否需要补这条边」的判定。
 */
function needsClosingEdge(sub) {
  if (!sub.closed) return false;
  if (!sub.elems.length) return false;
  const end = currentPoint(sub);
  return Math.hypot(end.x - sub.start.x, end.y - sub.start.y) > 1e-9;
}

export function subpathLength(sub) {
  let L = 0;
  for (const e of sub.elems) {
    if (e.type === 'line') {
      L += Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    } else if (e.type === 'ellipse') {
      const a = e.rx, b = e.ry;
      const ram = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
      L += ram * Math.abs(e.a1 - e.a0) / TAU;
    } else {
      L += Math.abs(e.a1 - e.a0) * e.r;
    }
  }
  if (needsClosingEdge(sub)) {
    const end = currentPoint(sub);
    L += Math.hypot(end.x - sub.start.x, end.y - sub.start.y);
  }
  return L;
}

export function pathLength(path) {
  return path.subpaths.reduce((a, s) => a + subpathLength(s), 0);
}

export function pathBBox(path) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sub of path.subpaths) {
    const pts = flattenSubpath(sub, 0.01);
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// 仿射变换
// ---------------------------------------------------------------------------
// 变换矩阵 [a c e; b d f]，与 SVG 的 matrix(a,b,c,d,e,f) 一致：
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f

export const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function matrixMultiply(m1, m2) {
  // apply m1 then m2
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function matrixTranslate(tx, ty) {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function matrixScale(sx, sy) {
  return { a: sx, b: 0, c: 0, d: sy || sx, e: 0, f: 0 };
}

export function matrixRotate(deg, cx = 0, cy = 0) {
  const t = deg * DEG;
  const cos = Math.cos(t), sin = Math.sin(t);
  return matrixMultiply(
    matrixTranslate(cx, cy),
    matrixMultiply({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }, matrixTranslate(-cx, -cy))
  );
}

export function matrixTranslateXY(m, x, y) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** 判断矩阵是否为「相似变换」（等比缩放+旋转+平移），保弧的前提 */
export function isSimilarity(m, tol = 1e-6) {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return false;
  // 正交性检查：列向量长度相等且正交
  const l1 = Math.hypot(m.a, m.b);
  const l2 = Math.hypot(m.c, m.d);
  if (Math.abs(l1 - l2) > tol * l1) return false;
  const dot = m.a * m.c + m.b * m.d;
  return Math.abs(dot) < tol * l1 * l2;
}

/**
 * 用「逐点函数」变换整条路径，原地修改。
 *
 * 与 `applyMatrixToPath` 的区别：那个只接受 2×3 矩阵（线性 + 平移），
 * 而版面旋转这类变换的平移量**依赖输入坐标之外的画布尺寸**
 * （顺时针 90° 是 `(x,y) → (y, W-x)`，那个 `W` 是画布宽，不在点自己身上）。
 * 矩阵表达不了这种「绕画布中心/角旋转」，所以走这个函数式入口。
 *
 * @param {object} path
 * @param {(x:number,y:number)=>{x:number,y:number}} fn
 * @param {boolean} [flipWinding=false] 变换是否含反射（镜像）。
 *        反射会把圆弧的绕向翻过来，必须交换 a0/a1，否则弧刻反。
 *        纯旋转不翻——这是本函数最容易漏的参数。
 */
export function mapPathPoints(path, fn, flipWinding = false) {
  for (const sub of path.subpaths) {
    const ns = fn(sub.start.x, sub.start.y);
    let px = ns.x, py = ns.y;          // 当前点，用于给 line 补齐起点
    sub.start = { x: px, y: py };
    const out = [];
    for (const e of sub.elems) {
      if (e.type === 'line') {
        const p2 = fn(e.x2, e.y2);
        // 起点用「上一段终点」而不是变换 e.x1：
        // HPGL 解析回来的 line 未必带 x1/y1，且逐段独立变换会累积误差。
        out.push({ type: 'line', x1: px, y1: py, x2: p2.x, y2: p2.y });
        px = p2.x; py = p2.y;
      } else if (e.type === 'arc') {
        const c = fn(e.cx, e.cy);
        const a0 = flipWinding ? e.a1 : e.a0;
        const a1 = flipWinding ? e.a0 : e.a1;
        out.push({ type: 'arc', cx: c.x, cy: c.y, r: e.r, a0, a1 });
        px = c.x + e.r * Math.cos(a1);
        py = c.y + e.r * Math.sin(a1);
      } else if (e.type === 'ellipse') {
        const c = fn(e.cx, e.cy);
        const a0 = flipWinding ? e.a1 : e.a0;
        const a1 = flipWinding ? e.a0 : e.a1;
        out.push({ type: 'ellipse', cx: c.x, cy: c.y, rx: e.rx, ry: e.ry, a0, a1 });
        px = c.x + e.rx * Math.cos(a1);
        py = c.y + e.ry * Math.sin(a1);
      }
    }
    sub.elems = out;
  }
  return path;
}

export function applyMatrixToPath(path, m) {
  const similar = isSimilarity(m);
  const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const rot = Math.atan2(m.b, m.a);
  for (const sub of path.subpaths) {
    const ns = { id: sub.id, start: matrixTranslateXY(m, sub.start.x, sub.start.y), elems: [], closed: sub.closed };
    for (const e of sub.elems) {
      if (e.type === 'line') {
        const p1 = matrixTranslateXY(m, e.x1, e.y1);
        const p2 = matrixTranslateXY(m, e.x2, e.y2);
        ns.elems.push({ type: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      } else if (e.type === 'ellipse') {
        if (similar) {
          const c = matrixTranslateXY(m, e.cx, e.cy);
          ns.elems.push({ type: 'ellipse', cx: c.x, cy: c.y, rx: e.rx * s, ry: e.ry * s, a0: e.a0 + rot, a1: e.a1 + rot });
        } else {
          const pts0 = [{ x: e.cx + e.rx * Math.cos(e.a0), y: e.cy + e.ry * Math.sin(e.a0) }];
          for (const p of flattenEllipse(e, 0.01)) pts0.push(p);
          for (let i = 1; i < pts0.length; i++) {
            const a = matrixTranslateXY(m, pts0[i - 1].x, pts0[i - 1].y);
            const b = matrixTranslateXY(m, pts0[i].x, pts0[i].y);
            ns.elems.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          }
        }
      } else if (similar) {
        const c = matrixTranslateXY(m, e.cx, e.cy);
        ns.elems.push({ type: 'arc', cx: c.x, cy: c.y, r: e.r * s, a0: e.a0 + rot, a1: e.a1 + rot });
      } else {
        // 非等比：圆变椭圆，离散处理
        const pts0 = [{ x: e.cx + e.r * Math.cos(e.a0), y: e.cy + e.r * Math.sin(e.a0) }];
        for (const p of flattenArc(e, 0.01)) pts0.push(p);
        for (let i = 1; i < pts0.length; i++) {
          const a = matrixTranslateXY(m, pts0[i - 1].x, pts0[i - 1].y);
          const b = matrixTranslateXY(m, pts0[i].x, pts0[i].y);
          ns.elems.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
      }
    }
    sub.start = ns.start;
    sub.elems = ns.elems;
  }
  return path;
}

// ---------------------------------------------------------------------------
// 路径整理
// ---------------------------------------------------------------------------

/** 去掉重复点与零长线段 */
export function cleanSubpath(sub) {
  const out = [];
  for (const e of sub.elems) {
    if (e.type === 'line') {
      if (Math.hypot(e.x2 - e.x1, e.y2 - e.y1) < 1e-7) continue;
    }
    out.push(e);
  }
  sub.elems = out;
  return sub;
}

/** 移除整条零长度子路径 */
export function pruneDegenerate(path, minLen = 0.001) {
  path.subpaths = path.subpaths.filter((s) => {
    cleanSubpath(s);
    return subpathLength(s) >= minLen;
  });
  return path;
}

/** 单条子路径的有符号面积（正为逆时针） */
export function subpathSignedArea(sub, maxSagitta = 0.01) {
  const pts = flattenSubpath(sub, maxSagitta);
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
  }
  return a / 2;
}

/** 有符号面积（离散计算，正为逆时针） */
export function signedArea(path) {
  return path.subpaths.reduce((acc, s) => acc + subpathSignedArea(s), 0);
}

/** 统一子路径方向：ccw=true 强制逆时针 */
export function setDirection(path, ccw) {
  for (const sub of path.subpaths) {
    if (subpathSignedArea(sub) === 0) continue; // 开放折线没有面积概念，跳过
    const isCcw = subpathSignedArea(sub) > 0;
    if (isCcw !== ccw) reverseSubpath(sub);
  }
  return path;
}

export function reverseSubpath(sub) {
  // 纯圆弧子路径不能走「离散再连回去」的路子：
  // 那样会把一条 20 字节的 AA 指令膨胀成上百个 PA，9600 波特下要多花好几秒。
  // 做法：先展开成「端点 + 弧」的序列，反转顺序，再把相邻段重新串起来。
  const allArcs = sub.elems.length > 0 && sub.elems.every((e) => e.type === 'arc' || e.type === 'ellipse');
  if (allArcs) {
    // 记录每段的起止端点
    const pieces = [];
    let cur = { x: sub.start.x, y: sub.start.y };
    for (const e of sub.elems) {
      const end = e.type === 'arc' ? arcEnd(e) : ellipseEnd(e);
      pieces.push({ elem: e, from: cur, to: end });
      cur = end;
    }
    // 整条链反转：新起点 = 原终点，段序倒走，每段起止角互换
    const last = pieces[pieces.length - 1];
    sub.start = { x: last.to.x, y: last.to.y };
    sub.elems = [];
    for (let i = pieces.length - 1; i >= 0; i--) {
      const e = pieces[i].elem;
      const a0 = e.a0;
      e.a0 = e.a1;
      e.a1 = a0;
      sub.elems.push(e);
    }
    return sub;
  }

  // 混合线/弧：先把每段的精确端点抽出来，再按新顺序重建。
  // 不能直接离散——离散有弦高容差，反转后长度会偏（实测圆角矩形偏 8%），
  // 走一遍机器就是「刻短了」，这种误差必须在算法层面消掉。
  const hasArc = sub.elems.some((e) => e.type === 'arc' || e.type === 'ellipse');
  if (hasArc) {
    const pieces = [];
    let cur = { x: sub.start.x, y: sub.start.y };
    for (const e of sub.elems) {
      let to;
      if (e.type === 'line') to = { x: e.x2, y: e.y2 };
      else if (e.type === 'arc') to = arcEnd(e);
      else to = ellipseEnd(e);
      pieces.push({ elem: e, from: cur, to });
      cur = to;
    }
    const last = pieces[pieces.length - 1];
    sub.start = { x: last.to.x, y: last.to.y };
    sub.elems = [];
    for (let i = pieces.length - 1; i >= 0; i--) {
      const e = pieces[i].elem;
      if (e.type === 'arc' || e.type === 'ellipse') {
        const a0 = e.a0;
        e.a0 = e.a1;
        e.a1 = a0;
      } else {
        // 直线的起止对调
        const { x1, y1, x2, y2 } = e;
        e.x1 = x2; e.y1 = y2; e.x2 = x1; e.y2 = y1;
      }
      sub.elems.push(e);
    }
    return sub;
  }

  // 纯直线：必须用 open 版本，闭合子路径若补上回到起点的点，
  // 反向后首尾重合，图形会被压扁成一条线
  const pts = flattenSubpathOpen(sub, 0.005);
  if (pts.length < 2) return sub;
  sub.start = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  sub.elems = [];
  for (let i = pts.length - 2; i >= 0; i--) addLine(sub, pts[i].x, pts[i].y);
  return sub;
}

/** 把开放子路径首尾接近的补成闭合 */
export function closeNearOpen(path, tol = 0.02) {
  for (const sub of path.subpaths) {
    if (sub.closed) continue;
    const end = currentPoint(sub);
    const d = Math.hypot(end.x - sub.start.x, end.y - sub.start.y);
    if (d < tol) {
      addLine(sub, sub.start.x, sub.start.y);
      sub.closed = true;
    }
  }
  return path;
}

// ---------------------------------------------------------------------------
// 刀路优化
// ---------------------------------------------------------------------------

/** 子路径包围盒（含曲线） */
export function subpathBBox(sub) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pts = flattenSubpath(sub, 0.05);
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** 端点（用于最近邻排序的接续点判断） */
export function subpathEndpoints(sub) {
  return [sub.start, currentPoint(sub)];
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 最近邻排序子路径，并按需反转以减少空行程。
 * @param {object} path
 * @param {{x:number,y:number}} from 起始刀位
 * @param {number} maxTravel 可选：超过此距离的空行程按包围盒矩形过滤顺序换向
 */
export function optimizeOrder(path, from = { x: 0, y: 0 }) {
  const subs = path.subpaths.slice();
  const remaining = new Set(subs.map((_, i) => i));
  const ordered = [];
  let cur = { x: from.x, y: from.y };
  let prevCCW = true;

  while (remaining.size) {
    let best = null;
    let bestD = Infinity;
    let bestFlip = false;
    for (const i of remaining) {
      const s = subs[i];
      const dStart = dist(cur, s.start);
      const end = currentPoint(s);
      const dEnd = dist(cur, end);
      if (dStart <= dEnd) {
        if (dStart < bestD) { bestD = dStart; best = i; bestFlip = false; }
      } else {
        if (dEnd < bestD) { bestD = dEnd; best = i; bestFlip = true; }
      }
    }
    const s = subs[best];
    // 交替方向（正铣/逆铣）能让刻刀受力一致，是刻字机的常用做法
    if (bestFlip !== prevCCW) {
      reverseSubpath(s);
      prevCCW = !prevCCW;
    } else {
      prevCCW = bestFlip;
    }
    ordered.push(s);
    cur = currentPoint(s);
    remaining.delete(best);
  }
  path.subpaths = ordered;
  return path;
}

/** 统计直/弧图元数，用于估算指令字节数 */
export function countElements(path) {
  let lines = 0, arcs = 0;
  for (const s of path.subpaths) for (const e of s.elems) e.type === 'line' ? lines++ : arcs++;
  return { lines, arcs, total: lines + arcs };
}
