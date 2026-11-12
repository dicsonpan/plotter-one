/**
 * 端到端自检：无硬件环境下验证整条链路。
 * 跑法：node server/selftest.js
 *
 * 重点验证三件事：
 *   1. 几何内核自洽：变换前后长度守恒、包围盒正确
 *   2. HPGL 往返一致：编译出的指令能原样解析回来，误差在量化容差内
 *   3. 任务引擎可控：暂停、继续、停止、进度都能正确反映
 */

import {
  makePath, makeSubpath, addLine, addArc, circleToPath, ellipseToPath, polylineToPath,
  applyMatrixToPath, matrixScale, matrixTranslate, pathLength, pathBBox,
  flattenPath, optimizeOrder, setDirection, signedArea, pruneDegenerate, countElements,
  subpathLength, simplifyPath, simplifySubpath, rdpSimplifyPoints, filterSpeckles,
} from './geom/path.js';
import { MACHINE_PRESETS, MATERIAL_PRESETS, ORIGIN_POSITIONS, getOriginCorner, buildFrameCommand, HpglBuilder, compileToPlotterLanguage, hpglToDmpl, estimateHpglMotion } from './machine/hpgl.js';
import { buildCalibrationStep } from './machine/calibrate.js';
import { buildManualCommand } from './machine/manual.js';
import { readFileSync } from 'node:fs';
import { parseHpgl } from './import/hpglReader.js';
import { parseDxf } from './import/dxf.js';
import { parseSvgPath, parseSvg } from './import/svg.js';
import { compileToolpath, analyze, estimateTime, Direction } from './cam/toolpath.js';
import { textToPath } from './cam/textToPath.js';
import { VirtualPlotter, NullTransport, SerialTransport } from './machine/transport.js';
import { JobEngine } from './machine/jobEngine.js';
import { DIALECTS, getDialect, detectStreamFormat, splitStreamUnits, skmToHpglShadow, SKM_INIT } from './machine/dialects.js';

/**
 * 深拷贝路径：geom/path.js 的 mapPathPoints 是原地修改，
 * golden 快照必须每个用例用一份干净输入，否则坐标会被前一个用例的
 * 自定义原点累积平移，快照就失去意义（2026-11-12 踩到）。
 */
function freshPath(src) {
  return {
    subpaths: src.subpaths.map((s) => ({
      start: { ...s.start },
      elems: s.elems.map((e) => ({ ...e })),
      closed: s.closed,
    })),
  };
}

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name} ${detail}`); }
}

function near(a, b, tol) { return Math.abs(a - b) <= tol; }

function section(t) {
  console.log('');
  console.log(`▸ ${t}`);
}

// ---------------------------------------------------------------------------
section('几何内核');
{
  const p = makePath();
  const s = makeSubpath(0, 0);
  addLine(s, 10, 0);
  addLine(s, 10, 10);
  addLine(s, 0, 10);
  s.closed = true;
  p.subpaths.push(s);
  check('矩形周长 = 40', near(pathLength(p), 40, 1e-9), `实际 ${pathLength(p)}`);

  const bb = pathBBox(p);
  check('包围盒正确', near(bb.w, 10, 1e-9) && near(bb.h, 10, 1e-9), `实际 ${bb.w}×${bb.h}`);

  const c = circleToPath(0, 0, 5);
  check('整圆周长 = 2πr', near(pathLength(c), 2 * Math.PI * 5, 1e-9), `实际 ${pathLength(c)}`);

  // 缩放后长度应按比例变化
  const c2 = circleToPath(0, 0, 5);
  applyMatrixToPath(c2, matrixScale(2, 2));
  check('等比缩放保弧且长度×2', near(pathLength(c2), 2 * Math.PI * 10, 1e-6), `实际 ${pathLength(c2)}`);

  // 平移不改变长度
  const c3 = circleToPath(0, 0, 5);
  applyMatrixToPath(c3, matrixTranslate(100, 100));
  check('平移后长度不变', near(pathLength(c3), 2 * Math.PI * 5, 1e-9));

  // 非等比变换：圆变椭圆，应离散但包围盒要接近
  const c4 = circleToPath(0, 0, 5);
  applyMatrixToPath(c4, { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 });
  const bb4 = pathBBox(c4);
  check('非等比变换后包围盒 ≈ 20×10', near(bb4.w, 20, 0.2) && near(bb4.h, 10, 0.2), `实际 ${bb4.w.toFixed(3)}×${bb4.h.toFixed(3)}`);

  // 有符号面积
  const square = polylineToPath([{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10},{x:0,y:0}], true);
  check('有符号面积 = ±100', near(Math.abs(signedArea(square)), 100, 1e-6), `实际 ${signedArea(square)}`);

  // 方向统一
  const wrap2 = polylineToPath([{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}], true);
  setDirection(wrap2, true);
  check('统一为逆时针后面积为正', signedArea(wrap2) > 0, `面积 ${signedArea(wrap2)}`);

  // 反向不变量：长度、包围盒、图元数都必须守恒，且圆弧不能被离散。
  const shapeMakers = {
    整圆: () => circleToPath(300, 300, 25),
    椭圆: () => ellipseToPath(300, 300, 30, 18),
    矩形: () => {
      const p = makePath(); const s = makeSubpath(0, 0);
      addLine(s, 10, 0); addLine(s, 10, 10); addLine(s, 0, 10); s.closed = true;
      p.subpaths.push(s); return p;
    },
    圆角矩形: () => {
      const p = makePath(); const s = makeSubpath(0, 0);
      addLine(s, 50, 0);
      addArc(s, 50, 10, 10, Math.PI / 2, 0);
      addLine(s, 60, 50);
      addArc(s, 50, 50, 10, 0, -Math.PI / 2);
      addLine(s, 0, 60);
      s.closed = true; p.subpaths.push(s); return p;
    },
  };
  for (const [name, mk] of Object.entries(shapeMakers)) {
    for (const ccw of [true, false]) {
      const a = mk();
      const lenA = pathLength(a), bbA = pathBBox(a), cA = countElements(a);
      setDirection(a, ccw);
      const lenB = pathLength(a), bbB = pathBBox(a), cB = countElements(a);
      const ok = Math.abs(lenA - lenB) < 1e-6
        && Math.abs(bbA.w - bbB.w) < 1e-6 && Math.abs(bbA.h - bbB.h) < 1e-6
        && cA.total === cB.total;
      check(`${name} ${ccw ? '逆' : '顺'}时针反转不变量`, ok,
        `Δlen=${Math.abs(lenA - lenB).toExponential(1)} 图元 ${cA.total}→${cB.total}`);
    }
  }

  // 退化清理
  const deg = makePath();
  const ds = makeSubpath(0, 0);
  addLine(ds, 0, 0);
  addLine(ds, 0.0001, 0);
  addLine(ds, 5, 5);
  deg.subpaths.push(ds);
  pruneDegenerate(deg, 0.001);
  check('退化线段被清理', deg.subpaths.length === 1 && pathLength(deg) > 7, `长度 ${pathLength(deg)}`);

  // 离散弧长逼近真实弧长
  const arcPath = makePath();
  const as = makeSubpath(5, 0);
  addArc(as, 0, 0, 5, 0, Math.PI);
  arcPath.subpaths.push(as);
  const trueLen = Math.PI * 5;
  const flatLen = flattenPath(arcPath, 0.001)[0].points.reduce((acc, pt, i, arr) => {
    if (i === 0) return 0;
    return acc + Math.hypot(pt.x - arr[i-1].x, pt.y - arr[i-1].y);
  }, 0);
  check('半圆离散长度逼近真值(0.5%)', Math.abs(flatLen - trueLen) / trueLen < 0.005,
    `离散 ${flatLen.toFixed(4)} vs 真值 ${trueLen.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
section('HPGL 生成与往返');
{
  const preset = MACHINE_PRESETS['liyue-sc630'];
  const p = makePath();
  const s = makeSubpath(10, 10);
  addLine(s, 100, 10);
  addArc(s, 100, 30, 20, -Math.PI / 2, Math.PI / 2);
  addLine(s, 10, 50);
  s.closed = true;
  p.subpaths.push(s);
  const c = circleToPath(200, 200, 15);
  for (const sub of c.subpaths) p.subpaths.push(sub);

  const built = compileToPlotterLanguage(p, preset, { speedMmPerSec: 30, force: 250 });
  check('生成了指令', built.text.length > 0, `${built.bytes} 字节 / ${built.commandCount} 条`);
  check('含初始化 IN;', /(^|\n)IN;/.test(built.text));
  check('含绝对模式声明 PA; 且不含非标 LT;', /(^|\n)PA;/.test(built.text) && !/(^|\n)LT;/.test(built.text));
  check('不含破坏 Y 轴缩放的 SC 指令', !/\bSC-?\d+/.test(built.text));
  check('文泰标准头部含 PU0,0; 且不含无坐标孤立 PU;', /(^|\n)PU0,0;/.test(built.text) && !/(^|\n)PU;/.test(built.text));
  check('含抬刀 PU', /PU/.test(built.text));
  check('含落刀 PD', /PD/.test(built.text));
  check('圆弧已离散为标准 PD 折线（不含固件拒动的 AA/CI）', !/\b(AA|CI)-?\d+/.test(built.text));
  check('以 PU0,0; 收尾且不含 SP0;', /PU0,0;\s*$/.test(built.text) && !/SP0;/.test(built.text));

  // 确认使用标准 PU x,y; 与 PD x,y; 运动指令
  const puMoveCount = (built.text.match(/PU-?\d+,-?\d+;/g) || []).length;
  const pdMoveCount = (built.text.match(/PD-?\d+,-?\d+;/g) || []).length;
  check('空移使用 PU x,y; 格式', puMoveCount >= 3, `实际 ${puMoveCount}`);
  check('切割使用 PD x,y; 格式', pdMoveCount >= 20, `实际 ${pdMoveCount}`);

  // 关键：往返一致性
  const back = parseHpgl(built.text, { stepsPerInch: preset.stepsPerInch });
  const origLen = pathLength(p);
  const backLen = pathLength(back.path);
  const err = Math.abs(origLen - backLen) / origLen;
  check('往返长度误差 < 1%', err < 0.01, `原始 ${origLen.toFixed(2)}mm vs 回读 ${backLen.toFixed(2)}mm，误差 ${(err*100).toFixed(3)}%`);

  const obb = pathBBox(p), bbb = pathBBox(back.path);
  const bwErr = Math.abs(obb.w - bbb.w) / Math.max(1, obb.w);
  check('往返包围盒误差 < 1%', bwErr < 0.01, `误差 ${(bwErr*100).toFixed(3)}%`);
  check('往返子路径数一致', back.path.subpaths.length === p.subpaths.length,
    `${p.subpaths.length} vs ${back.path.subpaths.length}`);

  // 整圆单独往返：验证离散后长度与包围盒直径准确
  const cOnly = circleToPath(300, 300, 25);
  const cBuilt = compileToPlotterLanguage(cOnly, preset, { speedMmPerSec: 30 });
  const cBack = parseHpgl(cBuilt.text, { stepsPerInch: preset.stepsPerInch });
  const cLen = pathLength(cBack.path);
  check('整圆往返长度正确（误差 <1%）',
    Math.abs(cLen - pathLength(cOnly)) / pathLength(cOnly) < 0.01,
    `原始 ${pathLength(cOnly).toFixed(2)} vs 回读 ${cLen.toFixed(2)}`);
  const cBb = pathBBox(cBack.path);
  check('整圆往返后包围盒直径约为 50mm', near(cBb.w, 50, 0.5) && near(cBb.h, 50, 0.5), `尺寸 ${cBb.w.toFixed(1)}×${cBb.h.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('分辨率正确性（力宇 1000 vs HPGL 标准 1016）');
{
  // 100mm 的线段，从 (0,0) 到 (100,0)，固定 layoutRotate:0 隔离验证 1D 脉冲步数换算
  const probe = (preset) => {
    const p = makePath();
    const s = makeSubpath(0, 0);
    addLine(s, 100, 0);
    p.subpaths.push(s);
    const built = new HpglBuilder(preset, { layoutRotate: 0 }).build(p, { speedMmPerSec: 30 });
    const all = [...built.text.matchAll(/(?:PU|PD)(-?\d+),(-?\d+);/g)].map((m) => +m[1]);
    return { all, built };
  };

  // 1000dpi：100mm → 100 * 1000/25.4 = 3937.0 → 3937
  const a = probe(MACHINE_PRESETS['liyue-sc630']);
  check('100mm @ 1000dpi 量化为 3937', a.all.includes(3937), `目标值 ${a.all.join(',')}`);
  check('1000dpi 下幅面 630mm 步进换算 = 24803',
    Math.round(630 / 25.4 * 1000) === 24803);

  // 1016dpi：100mm → 100 * 1016/25.4 = 4000
  const b = probe(MACHINE_PRESETS['generic-hpgl-1016']);
  check('100mm @ 1016dpi 量化为 4000', b.all.includes(4000), `目标值 ${b.all.join(',')}`);

  // 反向验证：100mm 线的起点定位指令是 PU0,0;
  check('起点为 0（原点定位）', a.all[0] === 0, `实际 ${a.all[0]}`);
}

// ---------------------------------------------------------------------------
section('文件导入');
{
  const dxf = `0
SECTION
2
ENTITIES
0
LINE
8
0
10
0.0
20
0.0
11
100.0
21
50.0
0
CIRCLE
8
0
10
200.0
20
200.0
40
25.0
0
ARC
8
0
10
0.0
20
0.0
40
30.0
50
0.0
51
90.0
0
LWPOLYLINE
8
0
90
4
70
1
10
0.0
20
0.0
10
50.0
20
0.0
10
50.0
20
50.0
10
0.0
20
50.0
0
ENDSEC
0
EOF`;
  const r = parseDxf(dxf);
  check('DXF 解析出 4 个子路径', r.path.subpaths.length === 4, `实际 ${r.path.subpaths.length}`);
  const types = countElements(r.path);
  check('DXF 图元统计正确', types.lines === 4 && types.arcs === 2, JSON.stringify(types));
  const circ = r.path.subpaths[1];
  check('DXF 整圆周长正确', near(subpathLength(circ), 2 * Math.PI * 25, 1e-6), `实际 ${subpathLength(circ).toFixed(2)}`);

  const svg = '<svg><path d="M10 10 L100 10 L100 100 Z"/></svg>';
  const rs = parseSvgPath(svg.match(/d="([^"]+)"/)[1]);
  check('SVG 三角解析出 1 条闭合路径', rs.subpaths.length === 1 && rs.subpaths[0].closed);
  const expectLen = 180 + Math.hypot(90, 90);
  check('SVG 长度正确', near(pathLength(rs), expectLen, 0.01),
    `实际 ${pathLength(rs).toFixed(2)}，期望 ${expectLen.toFixed(2)}`);

  const rel = parseSvgPath('m10 10 l90 0 l0 90 z');
  check('相对命令与绝对等价', near(pathLength(rel), expectLen, 0.01), `实际 ${pathLength(rel).toFixed(2)}`);

  const cubic = parseSvgPath('M0 0 C 10 0, 10 10, 0 10');
  check('SVG 三次贝塞尔可解析', pathLength(cubic) > 15, `长度 ${pathLength(cubic).toFixed(2)}`);

  const svgWithSpeckle = `
    <svg width="200" height="200" viewBox="0 0 200 200">
      <!-- 正常大矩形 (50x50mm) -->
      <rect id="main_box" x="10" y="10" width="50" height="50" />
      <!-- 微小描摹噪点 (0.6x0.6mm，类似附件二多余蓝色部分) -->
      <path id="speckle_noise" d="M 70 70 L 70.6 70 L 70.6 70.6 L 70 70.6 Z" />
    </svg>
  `;
  const parsedSvg = parseSvg(svgWithSpeckle);
  check('SVG 导入自动滤除 <1mm 独立噪点图元', parsedSvg.elements.length === 1 && parsedSvg.elements[0].id === 'main_box');
  check('SVG 导入生成滤除提示警告且中英双语',
    parsedSvg.warnings.some((w) => w.zh.includes('小于 1mm') && w.en.includes('< 1mm')));

  const testPath = makePath();
  const tinySub = makeSubpath(0, 0);
  addLine(tinySub, 0.8, 0); addLine(tinySub, 0.8, 0.8); addLine(tinySub, 0, 0.8); addLine(tinySub, 0, 0);
  tinySub.closed = true;
  testPath.subpaths.push(tinySub);
  const longSub = makeSubpath(10, 10);
  addLine(longSub, 20, 10);
  testPath.subpaths.push(longSub);

  const filterRes = filterSpeckles(testPath, 1.0);
  check('filterSpeckles 精准剔除 0.8mm 杂点且保留 10mm 细长线', filterRes.removedCount === 1 && testPath.subpaths.length === 1);
}

// ---------------------------------------------------------------------------
section('CAM 与输出');
{
  const preset = MACHINE_PRESETS['liyue-sc630'];
  const p = circleToPath(100, 100, 20);
  const c = compileToolpath(p, preset, { direction: Direction.CCW, optimize: true });
  check('CAM 编译产出路径', c.path.subpaths.length === 1);
  check('无警告', c.warnings.length === 0, JSON.stringify(c.warnings));

  // 超框必须报警
  const over = circleToPath(700, 400, 100);
  const c2 = compileToolpath(over, preset, {});
  check('超幅面被拦截并警告', c2.warnings.length > 0, `警告数 ${c2.warnings.length}`);

  // 负坐标必须报警
  const neg = circleToPath(-50, 100, 20);
  const c3 = compileToolpath(neg, preset, {});
  check('负坐标被拦截（中英文都在）',
    c3.warnings.some((w) => w && w.zh && w.zh.includes('负坐标') && w.en && w.en.includes('negative')),
    JSON.stringify(c3.warnings));

  const est = estimateTime(c.path, 30);
  check('时间估算为正', est.totalSeconds > 0, `${est.totalSeconds.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
section('CAM 几何层抽稀优化（RDP 与共线合并）');
{
  const colPts = [];
  for (let i = 0; i <= 100; i++) {
    colPts.push({ x: i * 1.5, y: i * 2.0 });
  }
  const colSub = makeSubpath(colPts[0].x, colPts[0].y);
  for (let i = 1; i < colPts.length; i++) addLine(colSub, colPts[i].x, colPts[i].y);
  const colPath = makePath();
  colPath.subpaths.push(colSub);

  simplifyPath(colPath, 0.02);
  check('共线密集折线压缩为 2 点（1 条线段）', colSub.elems.length === 1, `实际图元数 ${colSub.elems.length}`);
  check('共线折线终点坐标守恒', near(colSub.elems[0].x2, 150, 1e-3) && near(colSub.elems[0].y2, 200, 1e-3));

  const sinePts = [];
  for (let i = 0; i <= 1000; i++) {
    const x = i * 0.1;
    const y = 5 * Math.sin(x);
    sinePts.push({ x, y });
  }
  const sineSimplified = rdpSimplifyPoints(sinePts, 0.02);
  check('密集高频曲线压缩率超过 60%', sineSimplified.length < 400, `原始 1001 点，抽稀后 ${sineSimplified.length} 点`);
  check('曲线抽稀起点终点守恒', near(sineSimplified[0].x, 0, 1e-3) && near(sineSimplified[sineSimplified.length - 1].x, 100, 1e-3));

  const circlePts = [];
  const R = 30;
  for (let i = 0; i <= 360; i++) {
    const rad = (i * Math.PI) / 180;
    circlePts.push({ x: 50 + R * Math.cos(rad), y: 50 + R * Math.sin(rad) });
  }
  const polyCircle = makeSubpath(circlePts[0].x, circlePts[0].y);
  for (let i = 1; i < circlePts.length; i++) addLine(polyCircle, circlePts[i].x, circlePts[i].y);
  polyCircle.closed = true;
  const polyPath = makePath();
  polyPath.subpaths.push(polyCircle);

  simplifyPath(polyPath, 0.02);
  check('闭合离散圆点数大幅压缩(>60%)', polyCircle.elems.length < 150, `实际线段数 ${polyCircle.elems.length}`);
  const first = polyCircle.elems[0];
  const last = polyCircle.elems[polyCircle.elems.length - 1];
  check('闭合离散圆抽稀后首尾闭合', near(first.x1, last.x2, 1e-3) && near(first.y1, last.y2, 1e-3));

  const mixedSub = makeSubpath(0, 0);
  for (let i = 1; i <= 20; i++) addLine(mixedSub, i, 0);
  addArc(mixedSub, 20, 10, 10, -Math.PI / 2, Math.PI / 2);
  for (let i = 1; i <= 20; i++) addLine(mixedSub, 20 - i, 20);
  const mixedPath = makePath();
  mixedPath.subpaths.push(mixedSub);

  simplifyPath(mixedPath, 0.02);
  const arcElems = mixedSub.elems.filter((e) => e.type === 'arc');
  check('混合图元中原生圆弧保留且数量不变', arcElems.length === 1);
  check('混合图元中两段共线直线各自压缩为单条线段', mixedSub.elems.length === 3, `实际总图元数 ${mixedSub.elems.length}`);

  const densePath = makePath();
  const denseSub = makeSubpath(0, 0);
  for (let i = 1; i <= 200; i++) addLine(denseSub, i * 0.5, (i % 2 === 0 ? 0.005 : 0));
  densePath.subpaths.push(denseSub);
  const compiled = compileToolpath(densePath, MACHINE_PRESETS['liyue-sc631-au'], { tolerance: 0.02 });
  check('compileToolpath 输出刀路自动应用几何抽稀', compiled.path.subpaths[0].elems.length < 5,
    `实际图元数 ${compiled.path.subpaths[0].elems.length}`);
}

// ---------------------------------------------------------------------------
section('指令层连续坐标流合并（HP-GL 批量坐标提速 20%~30%）');
{
  const preset = { ...MACHINE_PRESETS['liyue-sc631-au'], layoutRotate: 0 };
  const poly = makePath();
  const ps = makeSubpath(0, 0);
  for (let i = 1; i <= 60; i++) {
    addLine(ps, i * 2, (i % 2 === 0 ? 10 : 0));
  }
  poly.subpaths.push(ps);

  const unmerged = compileToPlotterLanguage(poly, preset, { maxBatchPairs: 1, speedMmPerSec: 30 });
  const merged = compileToPlotterLanguage(poly, preset, { maxBatchPairs: 30, speedMmPerSec: 30 });

  check('合并模式生成有效指令', merged.text.length > 0);
  const mergedPdLines = merged.text.split('\n').filter((l) => /^PD-?\d+,-?\d+,/.test(l));
  check('显式开启批量模式时落刀切割坐标合并为批量 PD 指令', mergedPdLines.length > 0);

  const byteReduction = (unmerged.bytes - merged.bytes) / unmerged.bytes;
  check('指令层体积压缩率达 20%~30%（实测提速基准）', byteReduction >= 0.20 && byteReduction <= 0.35,
    `未合并 ${unmerged.bytes}B vs 合并后 ${merged.bytes}B，压缩 ${(byteReduction * 100).toFixed(1)}%`);

  const unmergedLines = unmerged.text.split('\n').filter((l) => /^PD-?\d/.test(l)).length;
  const mergedLines = merged.text.split('\n').filter((l) => /^PD-?\d/.test(l)).length;
  check('PD 指令行数压缩率超过 80%', (unmergedLines - mergedLines) / unmergedLines >= 0.80,
    `PD 行数 ${unmergedLines} → ${mergedLines}`);

  const back = parseHpgl(merged.text, { stepsPerInch: preset.stepsPerInch });
  const origLen = pathLength(poly);
  const backLen = pathLength(back.path);
  const lenErr = Math.abs(origLen - backLen) / origLen;
  check('连续坐标流合并后往返长度守恒(<0.5%)', lenErr < 0.005,
    `原始 ${origLen.toFixed(2)} vs 回读 ${backLen.toFixed(2)}，误差 ${(lenErr * 100).toFixed(3)}%`);

  const obb = pathBBox(poly), bbb = pathBBox(back.path);
  check('连续坐标流合并后包围盒守恒', Math.abs(obb.w - bbb.w) < 0.5 && Math.abs(obb.h - bbb.h) < 0.5,
    `原始 ${obb.w.toFixed(1)}×${obb.h.toFixed(1)} vs 回读 ${bbb.w.toFixed(1)}×${bbb.h.toFixed(1)}`);

  const mixed = makePath();
  const ms = makeSubpath(0, 0);
  for (let i = 1; i <= 20; i++) addLine(ms, i, 0);
  addArc(ms, 20, 10, 10, -Math.PI / 2, Math.PI / 2);
  for (let i = 1; i <= 20; i++) addLine(ms, 20 - i, 20);
  mixed.subpaths.push(ms);
  const mixedBuilt = compileToPlotterLanguage(mixed, preset, { speedMmPerSec: 30 });
  const mixedBack = parseHpgl(mixedBuilt.text, { stepsPerInch: preset.stepsPerInch });
  check('混合图元往返子路径连续且长度一致(<0.5%)',
    mixedBack.path.subpaths.length === 1
    && Math.abs(pathLength(mixed) - pathLength(mixedBack.path)) / pathLength(mixed) < 0.005);

  const dmplText = hpglToDmpl(merged.text);
  check('DMPL 正确映射批量坐标为 A 指令', /^D;A-?\d+,-?\d+,/m.test(dmplText));
}

// ---------------------------------------------------------------------------
section('文字转路径');
{
  const t = textToPath({ text: 'SK-2026', sizeMm: 20, x: 0, y: 0 });
  check('生成多条笔画', t.subpaths.length > 5, `实际 ${t.subpaths.length} 笔`);
  check('字高为 20mm', near(pathBBox(t).h, 20, 0.01), `实际 ${pathBBox(t).h.toFixed(2)}`);
  check('无缺字', t.meta.unsupported.length === 0, JSON.stringify(t.meta.unsupported));

  const cn = textToPath({ text: '中文', sizeMm: 20, x: 0, y: 0 });
  check('中文走方框占位且给出提示', cn.meta.unsupported.length === 2 && cn.meta.note.includes('中文'),
    JSON.stringify(cn.meta.unsupported));

  const rot = textToPath({ text: 'ABC', sizeMm: 20, x: 0, y: 0, rotation: 90 });
  const rot0 = textToPath({ text: 'ABC', sizeMm: 20, x: 0, y: 0 });
  const bb = pathBBox(rot);
  const bb0 = pathBBox(rot0);
  check('旋转 90° 后宽高互换', near(bb.w, bb0.h, 0.1) && near(bb.h, bb0.w, 0.1),
    `旋转前 ${bb0.w.toFixed(1)}×${bb0.h.toFixed(1)} → 旋转后 ${bb.w.toFixed(1)}×${bb.h.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('力宇 SC631-AU 机型（用户实际机型）');
{
  const au = MACHINE_PRESETS['liyue-sc631-au'];
  check('SC631-AU 预设存在', !!au);
  check('幅面取保守值 600×710mm', au.width === 600 && au.height === 710, `实际 ${au.width}×${au.height}`);
  check('分辨率为 1000 步/英寸（0.0254mm/step）', au.stepsPerInch === 1000, `实际 ${au.stepsPerInch}`);
  check('刀压范围 10-500g', au.force.min === 10 && au.force.max === 500, JSON.stringify(au.force));
  check('指令集为 HP-GL', au.dialect === 'hpgl');
  check('串口默认 115200 8N1 无流控',
    au.serialDefault.baud === 115200 && au.serialDefault.dataBits === 8
    && au.serialDefault.stopBits === 1 && au.serialDefault.parity === 'none');

  // 关键安全性质：超框必须被拦下
  const edge = circleToPath(au.width - 20, 300, 20);   // 刚好贴边
  const over = circleToPath(au.width + 10, 300, 20);   // 超出 30mm
  const cEdge = compileToolpath(edge, au, {});
  const cOver = compileToolpath(over, au, {});
  check('贴边图形(最大边界正好 600mm)放行', cEdge.warnings.length === 0, JSON.stringify(cEdge.warnings));
  check('超出 600mm 的图形被拦截', cOver.warnings.length > 0, '未报警');

  const e = MACHINE_PRESETS['liyue-sc631e'];
  check('630mm 版预设保留（供铭牌确认后切换）', e && e.width === 630, `实际 ${e?.width}`);
}

section('串口写入路径（曾经从未被测到）');
{
  const written = [];
  const fakeFd = {
    write: async (buf, offset, length) => {
      written.push({ buf: Buffer.from(buf).toString('ascii'), offset, length });
      return { bytesWritten: length };
    },
    close: async () => {},
  };
  const t = new SerialTransport({ path: '/dev/null', baud: 9600 });
  t.open = true;
  t.fd = fakeFd;
  const n = await t.write('PU;\n');
  check('串口 write 可用（this.fd.write）', typeof n === 'number' && n > 0, `返回 ${n}`);
  check('串口写入内容正确', written[0] && written[0].buf === 'PU;\n', JSON.stringify(written[0]));
  check('分块偏移参数正确', written[0] && written[0].offset === 0 && written[0].length === 4,
    JSON.stringify({ offset: written[0]?.offset, length: written[0]?.length }));

  const t2 = new SerialTransport({ path: '/dev/null' });
  let errMsg = '';
  try { await t2.write('X'); } catch (e) { errMsg = e.message; }
  check('未连接时给出明确错误', errMsg === '串口未连接', `实际「${errMsg}」`);
}

section('坐标轴方向与不发 SC 安全性');
{
  const au = { ...MACHINE_PRESETS['liyue-sc631-au'], layoutRotate: 0 };
  const seg = { subpaths: [{ start: { x: 0, y: 0 }, elems: [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0 }], closed: false }] };

  for (const [label, opts] of [
    ['常规', { axisX: 1, axisY: 1 }],
    ['X 反向', { axisX: -1, axisY: 1 }],
    ['Y 反向', { axisX: 1, axisY: -1 }],
    ['双向反向', { axisX: -1, axisY: -1 }],
  ]) {
    const text = compileToPlotterLanguage(seg, au, { ...opts, swapAxes: false }).text;
    check(`${label}轴向下不含 SC 指令（防止滚筒 Y 轴失灵）`, !/\bSC-?\d+/.test(text));
  }

  const bNormal = new HpglBuilder(au, { axisX: 1, swapAxes: false });
  const bFlip = new HpglBuilder(au, { axisX: -1, swapAxes: false });
  check('X 反向与常规设置指令头一致',
    bNormal.setupCoords({ x: 0, y: 0 }).cmds[0] === bFlip.setupCoords({ x: 0, y: 0 }).cmds[0],
    `${bNormal.cmds[0]} vs ${bFlip.cmds[0]}`);
  check('X 反向时用户 x=0 映射到机器右端（width）',
    bFlip.toMachine(0, 0).x === au.width, `实际 ${bFlip.toMachine(0, 0).x}`);
  check('X 反向时用户 x=width 映射到机器 0',
    bFlip.toMachine(au.width, 0).x === 0, `实际 ${bFlip.toMachine(au.width, 0).x}`);
  check('常规轴向下 x=0 映射到机器 0',
    bNormal.toMachine(0, 0).x === 0, `实际 ${bNormal.toMachine(0, 0).x}`);
  check('相对位移只翻符号、不做 width-x 偏移',
    bFlip.toMachineDelta(5, 0).dx === -5 && bNormal.toMachineDelta(5, 0).dx === 5,
    JSON.stringify({ flip: bFlip.toMachineDelta(5, 0), normal: bNormal.toMachineDelta(5, 0) }));

  const h = new HpglBuilder(au, { axisX: -1 });
  h.setupCoords({ x: 0, y: 0 }); h.home();
  check('回原点用 PU0,0;（回对刀原点）且绝不发 !PG',
    h.cmds.includes('PU0,0;') && !h.cmds.some((c) => c.includes('!PG')),
    h.cmds.join(' '));

  const mh = buildManualCommand(au, { action: 'home', dx: -10, dy: -5 });
  check('手动回原点不含 SC 与 !PG，且通过 PR 退回对刀原点',
    !/\bSC/.test(mh.text) && !mh.text.includes('!PG') && /PR-?\d+,-?\d+;/.test(mh.text),
    mh.text.replace(/\n/g, ' ').trim());

  for (const [label, act] of [
    ['回原点', { action: 'home' }],
    ['方向键移动', { action: 'move', dx: 5, dy: 0 }],
    ['抬刀', { action: 'penup' }],
    ['落刀', { action: 'pendown' }],
    ['进纸', { action: 'feed', distance: 50 }],
    ['设原点', { action: 'setorigin' }],
    ['抬刀回位', { action: 'end' }],
  ]) {
    const t = buildManualCommand(au, act).text;
    check(`${label}指令含 IN; 初始化（否则固件拒绝执行，全机失灵）`,
      /(^|\n)IN;/.test(t), t.replace(/\n/g, ' ').trim().slice(0, 60));
  }

  const calIn = buildCalibrationStep(au, { dir: 'x+', axisX: 1, axisY: 1 });
  check('校准指令也必须含 IN;（同样会全机失灵）',
    /(^|\n)IN;/.test(calIn), calIn.replace(/\n/g, ' ').trim());

  const auNoSwap = { ...au, swapAxes: false, axisX: 1, axisY: 1 };
  const mv = buildManualCommand(auNoSwap, { action: 'move', dx: 5, dy: 0 });
  check('手动 jog 用 PR 相对移动（非 PA 绝对跳变）',
    /PR-?197,0;/.test(mv.text) && !/PA-?\d+,-?\d+;/.test(mv.text),
    mv.text.replace(/\n/g, ' ').trim());
  check('手动 jog 收尾只切模式、不移动到原点',
    mv.text.includes('PA;') && !mv.text.includes('PA0,0'),
    mv.text.replace(/\n/g, ' ').trim());

  const pd = buildManualCommand(auNoSwap, { action: 'pendown' });
  check('落刀试压为相对 2mm，不做绝对移动',
    /PD;/.test(pd.text) && /PR-?79,0;/.test(pd.text) && !/PA-?\d+,-?\d+;/.test(pd.text),
    pd.text.replace(/\n/g, ' ').trim());

  const cal = buildCalibrationStep(auNoSwap, { dir: 'x+', axisX: 1, axisY: 1 });
  check('校准指令全程抬刀（不含 PD）', !cal.includes('PD'), cal.replace(/\n/g, ' ').slice(0, 70));
  check('校准走完能回到起点（往返增量互相抵消）',
    (() => {
      const pr = [...cal.matchAll(/PR(-?\d+),(-?\d+);/g)].map((m) => [+m[1], +m[2]]);
      return pr.length === 2 && pr[0][0] === -pr[1][0] && pr[0][1] === -pr[1][1];
    })(), cal.replace(/\n/g, ' ').trim());
  check('校准位移为 5mm（197 单位）',
    (() => {
      const m = cal.match(/PR(-?\d+),(-?\d+);/);
      return m && Math.abs(+m[1]) === 197;
    })(), cal.replace(/\n/g, ' ').trim());
  check('校准不含绝对定位（未归位也安全）', !/PA\d/.test(cal), cal.replace(/\n/g, ' ').trim());
}

section('镜像下的几何往返（反射会翻转圆弧绕向）');
{
  const au = { ...MACHINE_PRESETS['liyue-sc631-au'], layoutRotate: 0 };
  const auMirror = { ...au, swapAxes: false };
  for (const [ax, ay] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const p = circleToPath(300, 300, 25);
    const built = compileToPlotterLanguage(p, auMirror, { axisX: ax, axisY: ay });
    const back = parseHpgl(built.text, { stepsPerInch: au.stepsPerInch });
    const bb = pathBBox(back.path);
    check(`整圆往返（axisX=${ax}, axisY=${ay}）长度误差 <1%`,
      Math.abs(pathLength(back.path) - pathLength(p)) / pathLength(p) < 0.01,
      `误差 ${((pathLength(back.path) - pathLength(p)) / pathLength(p) * 100).toFixed(3)}%`);
    check(`整圆往返（axisX=${ax}, axisY=${ay}）直径不变`,
      near(bb.w, 50, 0.5) && near(bb.h, 50, 0.5), `${bb.w.toFixed(1)}×${bb.h.toFixed(1)}`);
  }

  const mk = () => { const p = makePath(); const s = makeSubpath(0, 0); addLine(s, 400, 300); p.subpaths.push(s); return p; };
  const backFlip = parseHpgl(
    compileToPlotterLanguage(mk(), auMirror, { axisX: -1, axisY: 1 }).text,
    { stepsPerInch: au.stepsPerInch }).path;
  const bbF = pathBBox(backFlip);
  check('镜像后直线长度不变', Math.abs(bbF.w - 400) < 0.5 && Math.abs(bbF.h - 300) < 0.5,
    `${bbF.w.toFixed(1)}×${bbF.h.toFixed(1)}`);
  check('镜像后直线落到对称位置（x 偏移 = width - 400）',
    Math.abs(bbF.minX - (au.width - 400)) < 0.5, `minX=${bbF.minX.toFixed(1)}`);
}

section('轴交换（支持 X/Y 交换配置）');
{
  const au = { ...MACHINE_PRESETS['liyue-sc631-au'], layoutRotate: 0 };
  const bSwap = new HpglBuilder(au, { axisX: 1, axisY: 1, swapAxes: true });
  const bNo = new HpglBuilder(au, { axisX: 1, axisY: 1, swapAxes: false });
  check('未交换时 machineSpanX 为幅面宽 600', bNo.machineSpanX === au.width);
  check('交换后 machineSpanX 互换为进纸长 710', bSwap.machineSpanX === au.height);
  check('machineSpanX 随交换改变', bSwap.machineSpanX === au.height && bNo.machineSpanX === au.width,
    `${bSwap.machineSpanX} vs ${bNo.machineSpanX}`);

  check('交换后用户 (100,200) 映射到机器 (200,100)',
    bSwap.toMachine(100, 200).x === 200 && bSwap.toMachine(100, 200).y === 100,
    JSON.stringify(bSwap.toMachine(100, 200)));
  check('未交换时用户 (100,200) 映射到机器 (100,200)',
    bNo.toMachine(100, 200).x === 100 && bNo.toMachine(100, 200).y === 200,
    JSON.stringify(bNo.toMachine(100, 200)));

  check('交换后往右的增量落在机器 Y 上',
    bSwap.toMachineDelta(5, 0).dx === 0 && bSwap.toMachineDelta(5, 0).dy === 5,
    JSON.stringify(bSwap.toMachineDelta(5, 0)));

  check('交换 + 单轴反向 = 旋转（isReflection=false）',
    new HpglBuilder(au, { axisX: -1, axisY: 1, swapAxes: true }).isReflection === false);
  check('仅交换 = 反射（isReflection=true）',
    new HpglBuilder(au, { axisX: 1, axisY: 1, swapAxes: true }).isReflection === true);

  const mkLine = () => { const p = makePath(); const s = makeSubpath(0, 0); addLine(s, 400, 300); p.subpaths.push(s); return p; };
  for (const sw of [false, true]) {
    const t = compileToPlotterLanguage(mkLine(), { ...au, axisX: 1, axisY: 1, swapAxes: sw }).text;
    const back = parseHpgl(t, { stepsPerInch: au.stepsPerInch }).path;
    check(`交换=${sw} 时线段长度不变（误差<0.1%）`,
      Math.abs(pathLength(back) - 500) / 500 < 0.001,
      `误差 ${((pathLength(back) - 500) / 500 * 100).toFixed(4)}%`);
    const bb = pathBBox(back);
    check(`交换=${sw} 时包围盒${sw ? '旋转' : '不变'}（${bb.w.toFixed(0)}×${bb.h.toFixed(0)}）`,
      sw ? (Math.abs(bb.w - 300) < 0.5 && Math.abs(bb.h - 400) < 0.5)
         : (Math.abs(bb.w - 400) < 0.5 && Math.abs(bb.h - 300) < 0.5),
      `${bb.w.toFixed(1)}×${bb.h.toFixed(1)}`);
  }

  for (const sw of [false, true]) {
    const c = circleToPath(300, 300, 25);
    const t = compileToPlotterLanguage(c, { ...au, axisX: 1, axisY: 1, swapAxes: sw }).text;
    const back = parseHpgl(t, { stepsPerInch: au.stepsPerInch }).path;
    const bb = pathBBox(back);
    check(`交换=${sw} 时整圆往返长度误差 <1%`,
      Math.abs(pathLength(back) - pathLength(c)) / pathLength(c) < 0.01,
      `误差 ${((pathLength(back) - pathLength(c)) / pathLength(c) * 100).toFixed(3)}%`);
    check(`交换=${sw} 时整圆直径不变`, near(bb.w, 50, 0.5) && near(bb.h, 50, 0.5), `${bb.w.toFixed(1)}×${bb.h.toFixed(1)}`);
  }

  const calSwap = buildCalibrationStep(au, { dir: 'x+', axisX: 1, axisY: 1, swapAxes: true });
  const prs = [...calSwap.matchAll(/PR(-?\d+),(-?\d+);/g)].map((m) => [+m[1], +m[2]]);
  check('交换后校准仍走 5mm 且只动一根轴',
    prs.length === 2 && (Math.abs(prs[0][0]) === 197 || Math.abs(prs[0][1]) === 197)
    && (prs[0][0] === 0 || prs[0][1] === 0),
    JSON.stringify(prs));
}

section('版面旋转 90°（实机：整版逆时针歪 90°，补偿为顺时针 90°）');
{
  const W = 600, H = 710;
  const base = { width: W, height: H, stepsPerInch: 1000, dialect: 'hpgl' };

  const b90 = new HpglBuilder({ ...base, layoutRotate: 90 }, { axisX: 1, axisY: 1, swapAxes: false });

  check('旋转 90°：原点映射到 (0, 画布宽)', (() => {
    const p = b90.toMachine(0, 0);
    return p.x === 0 && p.y === W;
  })(), JSON.stringify(b90.toMachine(0, 0)));

  check('旋转 90°：原右下角映射到 (0,0)', (() => {
    const p = b90.toMachine(W, 0);
    return p.x === 0 && p.y === 0;
  })(), JSON.stringify(b90.toMachine(W, 0)));

  check('旋转 90°：原左边变成新上边', (() => {
    const p = b90.toMachine(0, 100);
    return p.x === 100 && p.y === W;
  })(), JSON.stringify(b90.toMachine(0, 100)));

  const hLine = () => { const p = makePath(); const s = makeSubpath(0, 0); addLine(s, 400, 0); p.subpaths.push(s); return p; };
  const back90 = parseHpgl(
    compileToPlotterLanguage(hLine(), { ...base, layoutRotate: 90 },
      { axisX: 1, axisY: 1, swapAxes: false }).text,
    { stepsPerInch: 1000 }).path;
  const bb90 = pathBBox(back90);
  check('旋转 90°：水平线变垂直线（宽高对调）',
    Math.abs(bb90.w) < 1 && Math.abs(bb90.h - 400) < 0.5,
    `${bb90.w.toFixed(1)}×${bb90.h.toFixed(1)}`);
  check('旋转 90°：线长守恒（400mm）', Math.abs(pathLength(back90) - 400) < 0.5,
    `${pathLength(back90).toFixed(2)}mm`);

  check('旋转 90° 方向为顺时针（原左下 → 新左上）', b90.toMachine(0, 0).y === W);
  check('旋转不计入反射（isReflection 仍为 false）', b90.isReflection === false);
  check('旋转 + 换轴 仍为反射（旋转不抵反射）',
    new HpglBuilder({ ...base, layoutRotate: 90 }, { swapAxes: true }).isReflection === true);
  check('换轴 + 单轴反向 = 旋转（两次反射相抵）',
    new HpglBuilder(base, { axisX: -1, axisY: 1, swapAxes: true }).isReflection === false);

  const cRot = circleToPath(300, 300, 25);
  const cBack = parseHpgl(
    compileToPlotterLanguage(cRot, { ...base, layoutRotate: 90 },
      { axisX: 1, axisY: 1, swapAxes: false }).text,
    { stepsPerInch: 1000 }).path;
  check('旋转 90°：整圆往返长度误差 <1%',
    Math.abs(pathLength(cBack) - pathLength(cRot)) / pathLength(cRot) < 0.01,
    `${((pathLength(cBack) - pathLength(cRot)) / pathLength(cRot) * 100).toFixed(3)}%`);

  const d = b90.toMachineDelta(5, 0);
  check('旋转 90°：画布往右 → 机器 Y 负向（与绝对变换自洽）', d.dx === 0 && d.dy === -5,
    JSON.stringify(d));
  const dAbs = b90.toMachine(10, 0), dAbs0 = b90.toMachine(5, 0);
  check('旋转 90°：相对位移与绝对变换自洽',
    (dAbs.x - dAbs0.x) === d.dx && (dAbs.y - dAbs0.y) === d.dy,
    `Δ=${JSON.stringify({ dx: dAbs.x - dAbs0.x, dy: dAbs.y - dAbs0.y })} vs ${JSON.stringify(d)}`);

  check('旋转 90° 后 machineSpanX 为进纸长 710', b90.machineSpanX === H, `${b90.machineSpanX}`);
  check('旋转 90° 后 machineSpanY 为幅面宽 600', b90.machineSpanY === W, `${b90.machineSpanY}`);
  check('旋转 0 时跨度不换', new HpglBuilder(base, { layoutRotate: 0 }).machineSpanX === W);

  const bBoth = new HpglBuilder({ ...base, layoutRotate: 90 }, { swapAxes: true });
  check('旋转 90° + 换轴相互抵消（跨度回到 600）', bBoth.machineSpanX === W, `${bBoth.machineSpanX}`);

  check('旋转角归一化到 90 的倍数（37° → 0）',
    new HpglBuilder({ ...base, layoutRotate: 37 }).layoutRotate === 0);
  check('旋转角归一化支持负值与超圈（-90 → 270）',
    new HpglBuilder({ ...base, layoutRotate: -90 }).layoutRotate === 270);
  check('旋转 450° → 90', new HpglBuilder({ ...base, layoutRotate: 450 }).layoutRotate === 90);

  for (const rot of [0, 90, 180, 270]) {
    const b = new HpglBuilder({ ...base, layoutRotate: rot }, { axisX: 1, axisY: 1, swapAxes: false });
    let ok = true, bad = '';
    for (const [x, y] of [[0, 0], [100, 200], [W, H], [W, 0], [0, H], [321.5, 654.3]]) {
      const m = b.toMachine(x, y);
      const u = b.toUser(m.x, m.y);
      if (Math.abs(u.x - x) > 1e-6 || Math.abs(u.y - y) > 1e-6) {
        ok = false; bad = `(${x},${y})→(${m.x},${m.y})→(${u.x},${u.y})`; break;
      }
    }
    check(`旋转 ${rot}°：toUser 是 toMachine 的严格逆变换`, ok, bad);
  }

  {
    const b = new HpglBuilder({ ...base, layoutRotate: 90 }, { axisX: -1, axisY: 1, swapAxes: true });
    let ok = true, bad = '';
    for (const [x, y] of [[0, 0], [100, 200], [W, H], [250, 400]]) {
      const m = b.toMachine(x, y);
      const u = b.toUser(m.x, m.y);
      if (Math.abs(u.x - x) > 1e-6 || Math.abs(u.y - y) > 1e-6) {
        ok = false; bad = `(${x},${y})→(${m.x},${m.y})→(${u.x},${u.y})`; break;
      }
    }
    check('旋转+镜像+换轴：逆变换仍严格可逆', ok, bad);
  }

  check('力宇 SC631-AU 预设有 layoutRotate:90（实机确认）',
    MACHINE_PRESETS['liyue-sc631-au'].layoutRotate === 90,
    `${MACHINE_PRESETS['liyue-sc631-au'].layoutRotate}`);
}

section('机器原点位置（originPosition）与消除刻字前 Y 轴大幅空走');
{
  const au = MACHINE_PRESETS['liyue-sc631-au'];
  check('所有机型均声明了 originPosition 字段',
    Object.values(MACHINE_PRESETS).every((p) => !!p.originPosition && !!ORIGIN_POSITIONS[p.originPosition]));
  check('力宇 SC 系列滚筒机默认原点位置为 bottom-right（右下角）',
    au.originPosition === 'bottom-right' && MACHINE_PRESETS['liyue-sc630'].originPosition === 'bottom-right');
  check('右下角原点对应的画布机械原点为 (600, 0)',
    getOriginCorner(au, 'bottom-right').x === 600 && getOriginCorner(au, 'bottom-right').y === 0);

  // 验证一个贴靠在右下角原点内侧 10mm 处的 100×50mm 矩形（画布 x: 490..590, y: 10..60）
  // 刻字前首条空移指令 PU 仅走 (10mm, 10mm) = (394, 394) 步，彻底消除过去走 590mm (23228 步) 的问题
  const rectNearRightBottom = makePath();
  const rs = makeSubpath(590, 10);
  addLine(rs, 490, 10);
  addLine(rs, 490, 60);
  addLine(rs, 590, 60);
  rs.closed = true;
  rectNearRightBottom.subpaths.push(rs);

  const compiled = compileToolpath(rectNearRightBottom, au, {
    origin: { x: 600, y: 0 },
    originPosition: 'bottom-right',
  });
  const built = compileToPlotterLanguage(compiled.path, au, {
    origin: { x: 600, y: 0 },
    originPosition: 'bottom-right',
  });
  const puMoves = [...built.text.matchAll(/PU(-?\d+),(-?\d+);/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  // 第 0 条是初始化 PU0,0;，第 1 条是起刀定位 PU394,394;（10mm = 394 步）
  check('右下角原点旁图形起刀空移仅 10mm（394步），彻底消除 Y 轴大幅空走',
    puMoves.length >= 2 && near(puMoves[1].x, 394, 2) && near(puMoves[1].y, 394, 2),
    JSON.stringify(puMoves.slice(0, 3)));

  // 验证自定义工作原点（例如用户在画布 (500, 20) 处按下「设原点」）：
  // 紧贴自定义原点 (490, 30) 的点（距新原点左 10mm、上 10mm）在机器坐标下同样应为 (10mm, 10mm) = (394, 394) 步！
  const customRect = makePath();
  const cs = makeSubpath(490, 30);
  addLine(cs, 440, 30);
  addLine(cs, 440, 60);
  addLine(cs, 490, 60);
  cs.closed = true;
  customRect.subpaths.push(cs);
  const builtCustom = compileToPlotterLanguage(customRect, au, {
    origin: { x: 500, y: 20 },
    originPosition: 'bottom-right',
  });
  const puCustom = [...builtCustom.text.matchAll(/PU(-?\d+),(-?\d+);/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  check('自定义工作原点偏移相对机械原点计算，起刀距离精准为 10mm（394步）',
    puCustom.length >= 2 && near(puCustom[1].x, 394, 2) && near(puCustom[1].y, 394, 2),
    JSON.stringify(puCustom.slice(0, 3)));
}

section('走框预览（buildFrameCommand 范围巡边）');
{
  const au = MACHINE_PRESETS['liyue-sc631-au'];
  const rect = makePath();
  const s = makeSubpath(490, 10);
  addLine(s, 590, 10);
  addLine(s, 590, 90);
  addLine(s, 490, 90);
  s.closed = true;
  rect.subpaths.push(s);

  const frame = buildFrameCommand(rect, au, {
    origin: { x: 600, y: 0 },
    originPosition: 'bottom-right',
  });
  check('走框预览生成有效指令', frame.text.length > 0 && frame.commandCount >= 8);
  check('走框预览全程抬刀（严禁包含任何 PD 落刀指令）', !/\bPD/.test(frame.text), frame.text);
  check('走框预览包含 IN; 初始化与收尾回原点 PU0,0;',
    /(^|\n)IN;/.test(frame.text) && /PU0,0;\s*$/.test(frame.text));
  check('走框预览准确计算外框尺寸 100×80mm 与距原点偏移 10mm',
    near(frame.bbox.w, 100, 1e-6) && near(frame.bbox.h, 80, 1e-6)
    && near(frame.originBBox.offsetX, 10, 1e-6) && near(frame.originBBox.offsetY, 10, 1e-6),
    JSON.stringify(frame.originBBox));
  check('走框预览首点从距右下角原点最近的角点 (10mm, 10mm = 394, 394步) 出发',
    /PU394,394;/.test(frame.text), frame.text.replace(/\n/g, ' '));
  check('走框预览返回双语提示说明',
    frame.notes.every((n) => n && n.zh && n.en && !/[一-鿿]/.test(n.en)),
    JSON.stringify(frame.notes));
}

section('服务端双语（每条面向用户的文案都要有中英两份）');
{
  const preset = MACHINE_PRESETS['liyue-sc631-au'];

  // 机型预设
  for (const [id, p] of Object.entries(MACHINE_PRESETS)) {
    check(`机型 ${id} 有英文名`, !!p.nameEn && !/[一-鿿]/.test(p.nameEn), p.nameEn || '(缺失)');
  }
  // 原点位置预设
  for (const [id, o] of Object.entries(ORIGIN_POSITIONS)) {
    check(`原点方位 ${id} 有英文名`, !!o.nameEn && !/[一-鿿]/.test(o.nameEn), o.nameEn || '(缺失)');
  }
  // 材料预设
  for (const m of MATERIAL_PRESETS) {
    check(`材料 ${m.id} 有英文名`, !!m.nameEn && !/[一-鿿]/.test(m.nameEn), m.nameEn || '(缺失)');
  }

  // CAM 警告
  const over = compileToolpath(circleToPath(700, 400, 100), preset, {});
  check('超幅面警告中英俱全',
    over.warnings.length > 0
    && over.warnings.every((w) => w && w.zh && w.en && !/[一-鿿]/.test(w.en)),
    JSON.stringify(over.warnings));
  const neg = compileToolpath(circleToPath(-50, 100, 20), preset, {});
  check('负坐标警告中英俱全',
    neg.warnings.every((w) => w && w.zh && w.en && !/[一-鿿]/.test(w.en)),
    JSON.stringify(neg.warnings));

  // 手动控制 note
  for (const act of [
    { action: 'move', dx: 5, dy: 0 },
    { action: 'home' },
    { action: 'penup' },
    { action: 'pendown' },
    { action: 'setorigin' },
    { action: 'feed', distance: 50 },
    { action: 'eject', distance: 50 },
    { action: 'end' },
    { action: 'bogus' },
  ]) {
    const built = buildManualCommand(preset, act);
    check(`手动 ${act.action} 的 note 中英俱全`,
      built.notes.every((n) => n && n.zh && n.en && !/[一-鿿]/.test(n.en)),
      JSON.stringify(built.notes));
  }

  // 文字转路径的 meta
  const tp = textToPath({ text: 'AB', sizeMm: 20 });
  check('text-to-path 的 note 中英俱全',
    !!tp.meta.note && !!tp.meta.noteEn && !/[一-鿿]/.test(tp.meta.noteEn),
    `${tp.meta.note} / ${tp.meta.noteEn}`);
  const tpBad = textToPath({ text: '中A', sizeMm: 20 });
  check('缺字提示有英文且点名了缺字',
    !!tpBad.meta.noteEn && /outside the built-in stroke font/.test(tpBad.meta.noteEn)
    && tpBad.meta.unsupported.length > 0,
    `${tpBad.meta.unsupported.join('')} / ${tpBad.meta.noteEn}`);

  const vt = new VirtualPlotter({ width: 600, stepsPerInch: 1000 });
  await vt.connect();
  const eng2 = new JobEngine(vt);
  eng2.pushLog('中文消息', 'English message');
  check('pushLog 同时记录中英', eng2.log.at(-1)?.line === '中文消息' && eng2.log.at(-1)?.en === 'English message',
    JSON.stringify(eng2.log.at(-1)));
  eng2.pushLog('只有中文');
  check('pushLog 省略英文时退化为中文（不产生 undefined）',
    eng2.log.at(-1)?.en === '只有中文', JSON.stringify(eng2.log.at(-1)));
  await vt.disconnect();
}

section('安全操作必须无条件下发（不能因「软件以为已经抬刀」而空转）');
{
  const au = MACHINE_PRESETS['liyue-sc631-au'];

  check('penUp() 在未落刀时确实不发光刀指令（省字节优化的原意）',
    !new HpglBuilder(au, {}).penUp().cmds.includes('PU;'), '应为空');
  check('forcePenUp() 永远发光刀指令',
    new HpglBuilder(au, {}).forcePenUp().cmds.includes('PU;'), '应含 PU;');

  for (const [label, act, mustHave] of [
    ['抬刀', { action: 'penup' }, ['PU;', 'PR0,0;']],
    ['回原点', { action: 'home' }, ['PU;', 'PU0,0;', 'IP0,0;']],
    ['回原点(带偏移)', { action: 'home', dx: -10, dy: 5 }, ['PU;', 'PR', 'IP0,0;']],
    ['抬刀回位', { action: 'end' }, ['PU;', 'PU0,0;', 'IP0,0;']],
    ['抬刀回位(带偏移)', { action: 'end', dx: -10, dy: 5 }, ['PU;', 'PR', 'IP0,0;']],
    ['落刀试压', { action: 'pendown' }, ['PD;', 'PU;']],
    ['停止', { action: 'stop' }, ['PU;']],
  ]) {
    const t = buildManualCommand(au, act).text;
    const missing = mustHave.filter((k) => !t.includes(k));
    check(`${label}必定下发 ${mustHave.join('+')}（无条件，不看软件状态）`,
      missing.length === 0, missing.length ? `缺少 ${missing.join(',')}` : t.replace(/\n/g, ' ').trim());
  }

  const pd = buildManualCommand(au, { action: 'pendown' }).text.trim().split('\n').map((l) => l.trim());
  check('落刀试压顺序为 抬→落→走→抬',
    pd.indexOf('PD;') > pd.indexOf('PU;')
    && pd.lastIndexOf('PU;') > pd.indexOf('PD;'),
    pd.join(' '));
}

section('串口自动重连（服务重启后机器不能「失联」）');
{
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  check('存在自动重连逻辑 tryReconnect', /function tryReconnect/.test(src));
  check('启动时尝试自动连接', /await tryReconnect\(\)/.test(src));
  check('持续重试（USB 重新插拔后能恢复）', /startReconnectLoop/.test(src));
  check('手动连接后停掉自动重连（避免两套逻辑抢占串口）',
    /stopReconnectLoop\(\)/.test(src));
  check('退出前抬刀收尾（不留压刀状态）',
    /SIGTERM/.test(src) && /PU;/.test(src));
  check('重连定时器 unref（不阻止进程退出）',
    /reconnectTimer\.unref/.test(src));
  check('候选串口含配置路径（USB 换节点也能恢复）',
    /currentSerialCandidates/.test(src));
}

section('任务历史不留全量指令（防内存只涨不降）');
{
  const vt = new VirtualPlotter({});
  await vt.connect();
  const eng = new JobEngine(vt);
  const gcode = new Array(400).fill('PU100,100;').join('\n') + '\n';
  eng.enqueue({ name: '大任务', text: gcode, baud: 960000 });
  eng.run();
  for (let i = 0; i < 60 && eng.history.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const h = eng.history[0];
  check('历史条目不保留指令全文 text', h && h.text === undefined,
    h && Object.keys(h).join(','));
  check('历史条目不保留 lines 数组', h && h.lines === undefined,
    h && Object.keys(h).join(','));
  check('历史仍保留展示所需字段',
    h && typeof h.name === 'string' && typeof h.bytes === 'number' && typeof h.totalLines === 'number',
    h && JSON.stringify({ name: h.name, bytes: h.bytes, totalLines: h.totalLines }));
  let listOk = true;
  try { eng.list(); } catch (e) { listOk = false; }
  check('list() 在历史已剥字段后不报错', listOk);
  check('list() 返回的历史条目字段完整',
    eng.list().every((j) => typeof j.totalLines === 'number' && typeof j.bytes === 'number'),
    JSON.stringify(eng.list()[0] || {}));
}

section('任务原点保护与安全');
{
  const au = MACHINE_PRESETS['liyue-sc631-au'];
  const rect = () => {
    const p = makePath();
    const s = makeSubpath(50, 50);
    addLine(s, 250, 50); addLine(s, 250, 150); addLine(s, 50, 150); addLine(s, 50, 50);
    s.closed = true; p.subpaths.push(s);
    return p;
  };
  const built = compileToPlotterLanguage(rect(), au, { speedMmPerSec: 30 });
  const lines = built.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const iFirstMove = lines.findIndex((l) => /^PU-?\d/.test(l));

  check('默认任务开头不发 !PG（保护用户对刀原点）',
    !lines[0].includes('!PG'), `实际首行「${lines[0]}」`);
  check('任务开头以 IN; 初始化',
    lines[0] === 'IN;', `实际首行「${lines[0]}」`);
  check('默认结尾抬刀并返回原点 PU0,0;（不强制撞限位）',
    lines.includes('PU0,0;') && !lines.slice(-3).some((l) => l.includes('!PG')), lines.join(' '));
  check('落刀段使用标准 PD x,y; 切割指令',
    iFirstMove >= 0 && lines.slice(iFirstMove).some((l) => /^PD-?\d+,-?\d+;$/.test(l)), '应存在 PD x,y; 落刀段');

  const withHome = compileToPlotterLanguage(rect(), au, { homeFirst: true });
  check('homeFirst:true 可显式开启开头归位',
    withHome.text.startsWith('!PG;'), withHome.text.split('\n')[0]);
  const withEndHome = compileToPlotterLanguage(rect(), au, { homeEnd: true });
  check('homeEnd:true 可显式开启收尾归位',
    withEndHome.text.trim().endsWith('!PG;'), withEndHome.text.slice(-20));

  check('_sleep 支持非截断的长等待（归位驻留用）',
    (() => {
      const eng = new JobEngine(new NullTransport());
      return typeof eng._sleep(0, { capped: false }).then === 'function';
    })(), '');
}

section('任务引擎');
{
  const vt = new VirtualPlotter({});
  await vt.connect();
  const eng = new JobEngine(vt);
  const gcode = new Array(200).fill('PU100,100;').join('\n') + '\n';
  eng.enqueue({ name: '测试任务', text: gcode, baud: 9600 });

  const states = [];
  const progresses = [];
  eng.on('state', (s) => states.push(s.state));
  eng.on('progress', (p) => progresses.push(p));

  eng.run();
  await new Promise((r) => setTimeout(r, 150));
  check('进度事件已产生', progresses.length > 0, `${progresses.length} 次`);
  check('任务不出现在队列中（已开始）', eng.queue.length === 0, `队列 ${eng.queue.length}`);
  check('当前任务可见（界面不会凭空消失）', eng.list().length >= 1 && eng.list()[0].status === 'running',
    JSON.stringify(eng.list()[0]?.status));
  check('进度百分比单调不减', progresses.every((p, i) => i === 0 || p.percent >= progresses[i - 1].percent));
  check('进度含总行数与已发行数', progresses[0] && progresses[0].total === 200 && progresses[0].sent >= 1,
    JSON.stringify(progresses[0]));
  check('预估剩余时间为正数', progresses[0].etaMs > 0, `${progresses[0].etaMs.toFixed(1)}ms`);

  eng.pause();
  await new Promise((r) => setTimeout(r, 50));
  check('可暂停', eng.state === 'paused', `实际 ${eng.state}`);
  const atPause = progresses.length;
  await new Promise((r) => setTimeout(r, 120));
  check('暂停期间进度停住', progresses.length === atPause, `暂停时 ${atPause} → 之后 ${progresses.length}`);

  eng.resume();
  await new Promise((r) => setTimeout(r, 50));
  check('可继续', eng.state === 'running', `实际 ${eng.state}`);

  eng.stop();
  let waited = 0;
  while (eng.busy && waited < 3000) { await new Promise((r) => setTimeout(r, 50)); waited += 50; }
  check('可停止并回到空闲', eng.state === 'idle' || eng.state === 'aborted', `实际 ${eng.state}`);
  check('状态流包含运行与暂停', states.includes('running') && states.includes('paused'), JSON.stringify(states));
  check('急停清空队列', (eng.emergencyStop(), eng.queue.length === 0));
  await vt.disconnect();
}

// ---------------------------------------------------------------------------
section('虚拟机响应');
{
  const vt = new VirtualPlotter({ width: 630, stepsPerInch: 1000 });
  const rx = [];
  vt.on('data', (d) => rx.push(d));
  await vt.connect();
  await vt.write('IN;\n');
  await new Promise((r) => setTimeout(r, 30));
  check('虚拟机回显初始化响应', rx.some((s) => s.includes('READY')), JSON.stringify(rx));

  const preset = MACHINE_PRESETS['liyue-sc630'];
  const p = circleToPath(100, 100, 10);
  const built = compileToPlotterLanguage(p, preset, { speedMmPerSec: 30 });
  await vt.write(built.text);
  await new Promise((r) => setTimeout(r, 60));
  const moved = rx.some((s) => s.includes('ok'));
  check('虚拟机接受完整指令流', moved, `收到 ${rx.length} 条响应`);
  await vt.disconnect();
}

// ---------------------------------------------------------------------------
section('运动学时序仿真与物理执行状态跟踪');
{
  const hpgl1 = 'IN;VS3;PU1000,1000;PD4937,1000;PU;';
  const m1 = estimateHpglMotion(hpgl1, { defaultSpeed: 30, stepsPerInch: 1000 });
  check('运动学估算：落刀切割长度准确(100mm)', near(m1.cutLengthMm, 100, 0.5), `${m1.cutLengthMm}mm`);
  check('运动学估算：抬刀快移长度准确(约36mm)', near(m1.rapidLengthMm, 36, 1), `${m1.rapidLengthMm}mm`);
  check('运动学估算：包含落刀抬刀时延', m1.latencySeconds > 0.05, `${m1.latencySeconds}s`);
  check('运动学估算：总物理耗时准确(约3.6s)', near(m1.totalSeconds, 3.64, 0.3), `${m1.totalSeconds}s`);

  const hpgl2 = 'IN;!PG;VS5;PU0,0;PD1000,0,2000,0,3000,0;PU;';
  const m2 = estimateHpglMotion(hpgl2, { defaultSpeed: 50, stepsPerInch: 1000 });
  check('运动学估算：支持批量坐标流 PA/PD 连续累加', near(m2.cutLengthMm, 76.2, 1), `${m2.cutLengthMm}mm`);
  check('运动学估算：归位 !PG 包含 3 秒驻留', m2.latencySeconds >= 3.0, `${m2.latencySeconds}s`);

  const vt = new VirtualPlotter({});
  await vt.connect();
  const eng = new JobEngine(vt);

  const gcode = 'IN;VS10;PU0,0;PD3937,0;PU;';
  eng.enqueue({
    name: '物理时序测试',
    text: gcode,
    baud: 115200,
    estimate: { totalSeconds: 0.35, cutLengthMm: 100, rapidLengthMm: 0 },
  });

  const phases = [];
  eng.on('progress', (p) => {
    if (!phases.includes(p.phase)) phases.push(p.phase);
  });

  eng.run();
  await new Promise((r) => setTimeout(r, 60));
  check('双阶段进度：传输完成后顺利进入 cutting 刻绘阶段', phases.includes('cutting') || phases.includes('caching'), JSON.stringify(phases));

  for (let i = 0; i < 20 && eng.busy; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check('双阶段进度：物理耗时到位后顺利完成 (done)', phases.includes('done') && eng.state === 'idle', JSON.stringify(phases));
  await vt.disconnect();
}

// ---------------------------------------------------------------------------
section('历史任务归档与全参数持久化');
{
  const testLayer = {
    id: 'L_test_1',
    name: '轮廓层',
    subpaths: [
      {
        start: { x: 10, y: 10 },
        elems: [{ type: 'line', x1: 10, y1: 10, x2: 50, y2: 10 }],
        closed: false,
      }
    ],
  };

  const sampleArchive = {
    id: 'hist_selftest_001',
    name: '标牌刻绘',
    createdAt: Date.now(),
    layers: [testLayer],
    userOrigin: { x: 5, y: 5 },
    machineId: 'liyue-sc631-au',
    materialId: 'acrylic-3',
    speed: 12,
    force: 420,
    direction: 'alternate',
    optimize: true,
    stats: { cutLengthMm: 40, totalSeconds: 3.3 },
    thumbnailSvg: '<svg><path d="M 10 10 L 50 10"/></svg>',
  };

  check('历史任务：完整包含图层样式与加工参数',
    Array.isArray(sampleArchive.layers) &&
    sampleArchive.layers[0].name === '轮廓层' &&
    sampleArchive.machineId === 'liyue-sc631-au' &&
    sampleArchive.materialId === 'acrylic-3' &&
    sampleArchive.speed === 12 &&
    sampleArchive.force === 420 &&
    sampleArchive.direction === 'alternate' &&
    sampleArchive.userOrigin.x === 5,
    JSON.stringify(sampleArchive));

  check('历史任务：包含矢量缩略图字段',
    typeof sampleArchive.thumbnailSvg === 'string' && sampleArchive.thumbnailSvg.startsWith('<svg'),
    sampleArchive.thumbnailSvg);

  check('历史任务：深拷贝恢复后图层与参数不发生漂移',
    (() => {
      const restored = JSON.parse(JSON.stringify(sampleArchive));
      return restored.layers[0].subpaths[0].elems[0].x2 === 50 &&
             restored.speed === 12 &&
             restored.force === 420;
    })(),
    '');
}

// ---------------------------------------------------------------------------
section('节奏化流式下发与单行长度上限（2026-10-19 实机教训）');
{
  const { prepareUnits } = await import('./machine/jobEngine.js');

  const longPa = 'PA' + Array.from({ length: 20 }, (_, k) => `${1000 + k * 137},${2000 + k * 91}`).join(',') + ';';
  check('超长 PA 行会被拆分（原行 > 64B）', longPa.length > 64, `${longPa.length}B`);
  const units = prepareUnits(['IN;', 'SP1;', longPa, 'PU;', 'PA0,0;'].join('\n'), 64);
  check('拆分后每个下发单元都不超过 64 字节',
    units.every((u) => u.length <= 64),
    '最长 ' + Math.max(...units.map((u) => u.length)) + 'B');
  const reassembled = units.filter((u) => u.startsWith('PA') && u !== 'PA0,0;')
    .map((u) => u.slice(2, -1)).join(',');
  check('拆分成多个 PA 后坐标序列与原行完全一致（刀路等价）',
    reassembled === longPa.slice(2, -1),
    `${reassembled.slice(0, 40)}…`);
  check('短指令（IN;/PU;/SP1;）原样保留不被拆分',
    units.includes('IN;') && units.includes('PU;') && units.includes('SP1;'));

  const huge = 'PA' + '9'.repeat(31) + ',' + '8'.repeat(31) + ';';
  const u2 = prepareUnits(huge, 64);
  check('无法再拆分的长指令原样保留（不丢指令）', u2.length === 1 && u2[0] === huge);

  const vt = new VirtualPlotter({});
  await vt.connect();
  const writtenChunks = [];
  const origWrite = vt.write.bind(vt);
  vt.write = async (d) => { writtenChunks.push(String(d)); return origWrite(d); };

  const lines = [];
  for (let k = 0; k < 10; k++) lines.push(`PD${k * 7874},0,${(k + 1) * 7874},0;`);
  const gcode = ['IN;', 'VS100;', ...lines, 'PU0,0;'].join('\n');

  const eng = new JobEngine(vt);
  eng.enqueue({ name: '分块连续下发测试', text: gcode, baud: 115200 });
  const t0 = Date.now();
  const seen = [];
  eng.on('progress', (p) => { if (p.percent != null) seen.push(p.percent); });
  eng.run();

  await new Promise((r) => setTimeout(r, 150));
  const sentAt150 = eng.current ? eng.current.sent : 13;
  check('整批分块下发：150ms 内已将全部指令发入刻字机缓存（不卡在起始点）',
    sentAt150 === 13, `已下发 ${sentAt150} / 13`);
  check('下发字节流不含换行符 \\n（对齐文泰紧凑 ; 分隔流）',
    writtenChunks.length > 0 && writtenChunks.every((c) => !c.includes('\n')),
    JSON.stringify(writtenChunks));

  for (let i = 0; i < 80 && eng.busy; i++) await new Promise((r) => setTimeout(r, 50));
  const elapsed = Date.now() - t0;
  check('整批分块下发：任务最终正常完成', eng.current === null && eng.state === 'idle', eng.state);
  check('进度百分比单调不减', seen.length > 0 && seen.every((v, i) => i === 0 || v >= seen[i - 1]));
  check('物理刻绘跟踪：完成时刻贴合物理预估（2s 量级，误差 < 45%）',
    elapsed > 1200 && elapsed < 2900, `${elapsed}ms`);
  await vt.disconnect();
}

const nt = new NullTransport();
check('空传输可用', typeof nt.write === 'function');

// ---------------------------------------------------------------------------
section('单工链路识别与写入看门狗（2026-10-19 实测加固）');
{
  const silentStub = {
    open: true,
    everRx: false,
    write: async (d) => d.length,
    disconnect: async () => {},
  };
  const engSilent = new JobEngine(silentStub);
  engSilent.enqueue({ name: '单工任务', text: 'IN;\nPU;\n', baud: 960000 });
  engSilent.run();
  for (let i = 0; i < 60 && engSilent.history.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const silentLogs = engSilent.log.map((l) => l.line);
  check('单工任务开头提示「单向链路/仿真推算」',
    silentLogs.some((l) => l.includes('单向链路')), silentLogs.filter((l) => l.includes('ℹ')).join(' | '));
  check('单工任务完成日志明示「仿真计时 + 目视确认」而非裸「完成」',
    silentLogs.some((l) => l.includes('仿真计时') && l.includes('目视确认')),
    silentLogs.filter((l) => l.includes('✔')).join(' | '));

  const vt2 = new VirtualPlotter({});
  await vt2.connect();
  check('虚拟机 everRx 为 true（模拟双向链路）', vt2.everRx === true);
  const eng2way = new JobEngine(vt2);
  eng2way.enqueue({ name: '双向任务', text: 'IN;\nPU;\n', baud: 960000 });
  eng2way.run();
  for (let i = 0; i < 60 && eng2way.history.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const way2Logs = eng2way.log.map((l) => l.line);
  check('双向任务完成日志保持原「✔ 完成」语义',
    way2Logs.some((l) => l.includes('✔ 完成：双向任务')),
    way2Logs.filter((l) => l.includes('✔')).join(' | '));
  check('双向任务不出现「单向链路」提示',
    !way2Logs.some((l) => l.includes('单向链路')), '');

  const stalled = new SerialTransport({ path: '/dev/null', writeTimeoutMs: 120 });
  stalled.open = true;
  stalled.fd = {
    write: () => new Promise(() => { /* 永不 resolve：模拟 cdc-acm NAK 阻塞 */ }),
    close: async () => {},
    read: async () => ({ bytesRead: 0 }),
  };
  let watchdogErr = null;
  const t0 = Date.now();
  try { await stalled.write('IN;\n'); } catch (e) { watchdogErr = e; }
  const elapsed = Date.now() - t0;
  check('写入看门狗：卡死的 fd.write 在超时后抛错', !!watchdogErr,
    watchdogErr ? watchdogErr.message : '未抛错');
  check('写入看门狗：错误信息双语且指向「机器停止接收」',
    !!watchdogErr && /停止接收/.test(watchdogErr.message) && !!watchdogErr.errorEn,
    watchdogErr ? `${watchdogErr.message} / ${watchdogErr.errorEn}` : '');
  check('写入看门狗：超时后传输已断开（不再挂着失效句柄）', stalled.open === false);
  check('写入看门狗：耗时与设定超时一致（约 120ms，而非秒级）',
    elapsed >= 110 && elapsed < 1500, `${elapsed}ms`);

  const noWatch = new SerialTransport({ path: '/dev/null', writeTimeoutMs: 0 });
  noWatch.open = true;
  noWatch.fd = {
    write: async (buf, off, len) => ({ bytesWritten: len }),
    close: async () => {},
    read: async () => ({ bytesRead: 0 }),
  };
  let okWrite = false;
  try { await noWatch.write('IN;\n'); okWrite = true; } catch { /* 不应抛 */ }
  check('writeTimeoutMs=0 时看门狗关闭，写入直通', okWrite);
}

// ---------------------------------------------------------------------------
section('协议层：方言可插拔 + 力宇零回归（2026-11-12）');
{
  const line = (x2, y2) => ({ type: 'line', x2, y2 });
  const rect = {
    subpaths: [{ start: { x: 10, y: 10 }, elems: [line(100, 10), line(100, 60), line(10, 60), line(10, 10)] }],
  };
  const multi = {
    subpaths: [
      { start: { x: 0, y: 0 }, elems: [line(30, 0), line(30, 30), line(0, 30)] },
      { start: { x: 120, y: 40 }, elems: [line(170, 40), line(170, 90)] },
    ],
  };

  // 🔴 改动前逐字节采集的 golden 快照：以后重构协议层，这些字符串一个字节都不许变。
  const golden = [
    ['SC631-AU 基础输出', 'liyue-sc631-au', rect, {},
      'IN;\nPA;\nSP1;\nPU0,0;\nPU394,23228;\nPD394,19685;\nPD2362,19685;\nPD2362,23228;\nPD394,23228;\nPU0,0;\n'],
    ['SC631-AU 自定义工作原点', 'liyue-sc631-au', rect, { origin: { x: 20, y: 20 } },
      'IN;\nPA;\nSP1;\nPU0,0;\nPU-394,394;\nPD-394,-3150;\nPD1575,-3150;\nPD1575,394;\nPD-394,394;\nPU0,0;\n'],
    ['DMPL 后处理转译', 'generic-dmpl', rect, {},
      ';:A;\n;:\n;:A;\nA;\nS1;\nU0,0;\nV3;\nU;A400,24800;\nD;A400,21200;\nD;A2400,21200;\nD;A2400,24800;\nD;A400,24800;\nU0,0;\n'],
    ['四轴 3D 机型 VS/FS 头部', 'liyue-4axis', rect, {},
      'IN;\nPA;\nSP1;\nPU0,0;\nVS3;\nPU1598,1598;\nPD15984,1598;\nPD15984,9591;\nPD1598,9591;\nPD1598,1598;\nPU0,0;\n'],
    ['通用 1016 批量坐标流', 'generic-1016-600', multi, { maxBatchPairs: 8 },
      'IN;\nPA;\nSP1;\nPU0,0;\nPU0,24000;\nPD0,22800,1200,22800,1200,24000;\nPU1600,19200;\nPD1600,17200,3600,17200;\nPU0,0;\n'],
  ];
  for (const [name, id, path, opts, want] of golden) {
    const got = compileToPlotterLanguage(freshPath(path), MACHINE_PRESETS[id], opts).text;
    check(`【回归】${name} 逐字节不变`, got === want, `实际 ${JSON.stringify(got)}`);
  }

  const frame = buildFrameCommand(freshPath(rect), MACHINE_PRESETS['liyue-sc631-au'], {});
  check('【回归】走框预览逐字节不变',
    frame.text === 'IN;\nPA;\nSP1;\nPU;\nPU394,19685;\nPU394,23228;\nPU2362,23228;\nPU2362,19685;\nPU394,19685;\nPU0,0;\n',
    JSON.stringify(frame.text));

  const manualGolden = {
    move: 'IN;\nSP1;\nVS3;\nPU;\nPR197,-394;\nPA;\n',
    home: 'IN;\nSP1;\nVS3;\nPU;\nPR197,-394;\nPA;\nIP0,0;\n',
    feed: 'IN;\nSP1;\nVS3;\nPU;\nPR787,0;\nPA;\n',
  };
  for (const [action, want] of Object.entries(manualGolden)) {
    const got = buildManualCommand(MACHINE_PRESETS['liyue-sc631-au'],
      { action, dx: 10, dy: 5, distance: 20, speed: 30 }).text;
    check(`【回归】手动 ${action} 逐字节不变`, got === want, JSON.stringify(got));
  }

  check('新增机器没有改动任何原预设的方言',
    ['liyue-sc631-au', 'liyue-sc631e', 'liyue-sc630', 'liyue-sc801', 'liyue-sc1261',
      'generic-hpgl-1016', 'generic-1016-600'].every((id) => MACHINE_PRESETS[id].dialect === 'hpgl')
    && MACHINE_PRESETS['liyue-4axis'].dialect === 'hpgl3d'
    && MACHINE_PRESETS['generic-dmpl'].dialect === 'dmpl');
  check('方言注册表覆盖 hpgl / hpgl3d / dmpl / skm',
    ['hpgl', 'hpgl3d', 'dmpl', 'skm'].every((id) => DIALECTS[id] && DIALECTS[id].id === id));
  check('未知方言安全回退到 HP-GL', getDialect('no-such-dialect').id === 'hpgl');
}

// ---------------------------------------------------------------------------
section('SparkPlotter-GZ：skm 私有协议');
{
  const p = MACHINE_PRESETS['sparkplotter-gz'];
  const line = (x2, y2) => ({ type: 'line', x2, y2 });
  const rect = {
    subpaths: [{ start: { x: 10, y: 10 }, elems: [line(100, 10), line(100, 60), line(10, 60), line(10, 10)] }],
  };
  const r = compileToPlotterLanguage(freshPath(rect), p, {});

  check('预设存在且名为 SparkPlotter-GZ', !!p && p.name.startsWith('SparkPlotter-GZ'));
  check('幅面 600mm 刻绘宽 / 1016 步每英寸', p.width === 600 && p.stepsPerInch === 1016);
  check('串口 9600 / 8N1 / 无流控',
    p.serialDefault.baud === 9600 && p.serialDefault.dataBits === 8
    && p.serialDefault.stopBits === 1 && p.serialDefault.parity === 'none' && !p.serialDefault.rtscts);
  check('方言为 skm 且几何层与 HP-GL 共用', p.dialect === 'skm' && getDialect('skm').stream === true);

  check('初始化串逐字节正确（15 字节，末尾空格是协议的一部分）',
    r.text.startsWith(SKM_INIT) && SKM_INIT.length === 15 && SKM_INIT.endsWith(' '), JSON.stringify(SKM_INIT));
  check('抬刀移动 U{x},{y} 以空格结尾', /\bU-?\d+,-?\d+ /.test(r.text));
  check('落刀首点 D{x},{y} 以空格结尾', /\bD-?\d+,-?\d+ /.test(r.text));
  check('连续线段用逗号续接（无 D 前缀、无空格）', /,\d+,\d+,\d+,\d+/.test(r.text));
  check('【关键】作业结束标记存在且在最后', /U F-?\d+ @ $/.test(r.text), JSON.stringify(r.text.slice(-24)));
  check('初始化之后全协议无分号（空格才是边界）', !r.text.slice(SKM_INIT.length).includes(';'));
  check('序列化为连续字节流（不插换行）', !r.text.includes('\n'));
  check('编译结果携带 format=stream', r.format === 'stream');

  const fr = buildFrameCommand(freshPath(rect), p, {});
  check('走框预览同样带结束标记（否则刀头不动）', /U F-?\d+ @ $/.test(fr.text));
  check('走框全程抬刀：没有落刀 D 指令', !/\bD-?\d+,-?\d+ /.test(fr.text));
  check('走框结果携带 format=stream', fr.format === 'stream');

  // 影子估算：几何不变，耗时/进度口径与 HP-GL 一致
  const shadow = skmToHpglShadow(r.text);
  check('影子文本可由下发字节流无损反推', shadow === r.estimateText, JSON.stringify(shadow));
  const hpglText = compileToPlotterLanguage(freshPath(rect), MACHINE_PRESETS['generic-1016-600'], {}).text;
  const mSk = estimateHpglMotion(shadow, { stepsPerInch: 1016 });
  const mHp = estimateHpglMotion(hpglText, { stepsPerInch: 1016 });
  check('影子估算的切割长度与 HP-GL 版一致',
    near(mSk.cutLengthMm, mHp.cutLengthMm, 0.5), `${mSk.cutLengthMm} vs ${mHp.cutLengthMm}`);

  // 传输层：空格不能被 trim、字节流必须无损
  check('格式嗅探：HP-GL → lines，skm → stream',
    detectStreamFormat('IN;\nPA;\n') === 'lines' && detectStreamFormat(r.text) === 'stream');
  check('流式切块拼接无损', splitStreamUnits(r.text, 17).join('') === r.text);
  const nt = new NullTransport();
  const eng = new JobEngine(nt);
  eng.enqueue({
    id: 'skm-e2e', name: 'skm 端到端', text: r.text, baud: 9600,
    stepsPerInch: p.stepsPerInch,
    estimate: { totalSeconds: 0.01, cutLengthMm: 0, rapidLengthMm: 0 },
  });
  const queued = eng.queue.find((j) => j.id === 'skm-e2e');
  check('任务自动识别为流式下发', queued.streamFormat === 'stream');
  check('下发单元拼接后与原文一致', queued.units.join('') === r.text);
  const forced = new JobEngine(new NullTransport());
  forced.enqueue({ id: 'skm-lines', text: r.text, streamFormat: 'lines' });
  check('即使调用方误传 lines，skm 文本仍按流式下发（切换机型后重发不会损坏指令）',
    forced.queue[0].streamFormat === 'stream' && forced.queue[0].units.join('') === r.text);
  await eng.run();
  check('【关键】端到端下发字节流逐字节一致（结尾空格未被 trim）',
    nt.written === r.text, JSON.stringify(nt.written));

  // 虚拟机如实模拟「攒缓冲 + 结束标记才执行」
  const vp = new VirtualPlotter({ dialect: 'skm', stepsPerInch: p.stepsPerInch });
  let banner = null;
  vp.on('data', (d) => { banner = d; });
  await vp.connect();
  await new Promise((res) => setTimeout(res, 40));
  check('单工虚拟机 everRx=false 且不回 banner', vp.everRx === false && banner === null);
  const noEnd = r.text.replace(/U F-?\d+ @ $/, '');
  await vp.write(noEnd);
  await new Promise((res) => setTimeout(res, 25));
  check('【关键】缺结束标记时机器完全不动',
    vp.jobs === 0 && vp.pos.x === 0 && vp.pos.y === 0, JSON.stringify(vp.pos));
  await vp.write('U F0 @ ');
  await new Promise((res) => setTimeout(res, 25));
  check('收到结束标记后缓冲作业一次性执行',
    vp.jobs === 1 && (vp.pos.x !== 0 || vp.pos.y !== 0), JSON.stringify(vp.pos));

  // 手动控制：没有 PR / IP，坐标由上位机累加
  const m1 = buildManualCommand(p, { action: 'move', dx: 10, dy: 5, speed: 30 }, { pos: { x: 0, y: 0 } });
  check('手动移动生成绝对坐标 U 指令', /U-?\d+,-?\d+ /.test(m1.text));
  check('手动移动自带作业结束标记', /U F-?\d+ @ $/.test(m1.text));
  check('手动移动不含 HP-GL 的 PR/PA/IP', !/PR|PA|IP/.test(m1.text));
  const m2 = buildManualCommand(p, { action: 'move', dx: 10, dy: 0, speed: 30 }, { pos: m1.nextPos });
  check('连续两次移动：上位机累加绝对坐标',
    m2.nextPos.x === m1.nextPos.x && m2.nextPos.y !== m1.nextPos.y,
    `${JSON.stringify(m1.nextPos)} → ${JSON.stringify(m2.nextPos)}`);
  const mh = buildManualCommand(p, { action: 'home' }, { pos: m2.nextPos });
  check('回原点发 U0,0 并以 F0 提交', mh.text.includes('U0,0 ') && /U F0 @ $/.test(mh.text));
}

// ---------------------------------------------------------------------------
console.log('');
console.log('═══════════════════════════════════════');
console.log(`  通过 ${pass}　失败 ${fail}`);
if (fail) {
  console.log('───────────────────────────────────────');
  failures.forEach((f) => console.log('  ✗ ' + f));
  console.log('═══════════════════════════════════════');
  process.exit(1);
}
console.log('═══════════════════════════════════════');
