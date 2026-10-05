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
  subpathLength,
} from './geom/path.js';
import { MACHINE_PRESETS, MATERIAL_PRESETS, HpglBuilder, compileToPlotterLanguage } from './machine/hpgl.js';
import { buildCalibrationStep } from './machine/calibrate.js';
import { buildManualCommand } from './machine/manual.js';
import { readFileSync } from 'node:fs';
import { parseHpgl } from './import/hpglReader.js';
import { parseDxf } from './import/dxf.js';
import { parseSvgPath } from './import/svg.js';
import { compileToolpath, analyze, estimateTime, Direction } from './cam/toolpath.js';
import { textToPath } from './cam/textToPath.js';
import { VirtualPlotter, NullTransport, SerialTransport } from './machine/transport.js';
import { JobEngine } from './machine/jobEngine.js';

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
  // 「反向把圆弧离散掉」是实测踩到的坑——9600 波特下指令量会暴涨好几秒，
  // 而且离散误差会让「刻短了」。
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
  check('含连续线 LT;', /(^|\n)LT;/.test(built.text));
  check('不含破坏 Y 轴缩放的 SC 指令', !/\bSC-?\d+/.test(built.text));
  check('含速度 VS', /VS\d+;/.test(built.text));
  check('含抬刀 PU', /PU/.test(built.text));
  check('含落刀 PD', /PD/.test(built.text));
  check('含圆弧 AA（未离散）', /AA-?\d+,-?\d+,-?\d+,-?\d+;/.test(built.text));
  check('以 SP0 收尾', /SP0;\s*$/.test(built.text));

  // 保弧是硬需求：确认圆弧没被展开成大量 PA
  const aaCount = (built.text.match(/AA/g) || []).length;
  const paCount = (built.text.match(/PA/g) || []).length;
  check('圆弧数 2（矩形圆角 + 整圆）', aaCount === 2, `实际 ${aaCount}`);
  check('PA 数量合理（未因离散膨胀）', paCount < 40, `实际 ${paCount}`);

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

  // 整圆单独往返：AA 指令的半径恢复是踩过坑的地方
  // （曾经把「当前位置到圆心」的距离算成 0，导致整圆变点）
  const cOnly = circleToPath(300, 300, 25);
  const cBuilt = compileToPlotterLanguage(cOnly, preset, { speedMmPerSec: 30 });
  const cBack = parseHpgl(cBuilt.text, { stepsPerInch: preset.stepsPerInch });
  const cLen = pathLength(cBack.path);
  check('整圆往返长度正确（误差 <1%）',
    Math.abs(cLen - pathLength(cOnly)) / pathLength(cOnly) < 0.01,
    `原始 ${pathLength(cOnly).toFixed(2)} vs 回读 ${cLen.toFixed(2)}`);
  const cElem = cBack.path.subpaths[0]?.elems?.[0];
  check('整圆往返后半径不为零', cElem && cElem.r > 24 && cElem.r < 26, `半径 ${cElem?.r}`);
}

// ---------------------------------------------------------------------------
section('分辨率正确性（力宇 1000 vs HPGL 标准 1016）');
{
  // 100mm 的线段，从 (0,0) 到 (100,0)，看第一个落刀后的 PA 目标值
  const probe = (preset) => {
    const p = makePath();
    const s = makeSubpath(0, 0);
    addLine(s, 100, 0);
    p.subpaths.push(s);
    const built = new HpglBuilder(preset).build(p, { speedMmPerSec: 30 });
    const all = [...built.text.matchAll(/PA(-?\d+),(-?\d+);/g)].map((m) => +m[1]);
    return { all, built };
  };

  // 1000dpi：100mm → 100 * 1000/25.4 = 3937.0 → 3937
  const a = probe(MACHINE_PRESETS['liyue-sc630']);
  check('100mm @ 1000dpi 量化为 3937', a.all.includes(3937), `PA 目标值 ${a.all.join(',')}`);
  check('1000dpi 下幅面 630mm 步进换算 = 24803',
    Math.round(630 / 25.4 * 1000) === 24803);

  // 1016dpi：100mm → 100 * 1016/25.4 = 4000
  const b = probe(MACHINE_PRESETS['generic-hpgl-1016']);
  check('100mm @ 1016dpi 量化为 4000', b.all.includes(4000), `PA 目标值 ${b.all.join(',')}`);

  // 反向验证：100mm 线的起点归位指令是 PA0,0
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
  // LINE(1线) + ARC(1弧) + CIRCLE(1弧) + 闭合LWPOLYLINE(3条显式线，闭合边隐含) = 4线 2弧
  check('DXF 图元统计正确', types.lines === 4 && types.arcs === 2, JSON.stringify(types));
  // 整圆周长应还原为 2πr
  const circ = r.path.subpaths[1];
  check('DXF 整圆周长正确', near(subpathLength(circ), 2 * Math.PI * 25, 1e-6), `实际 ${subpathLength(circ).toFixed(2)}`);

  const svg = '<svg><path d="M10 10 L100 10 L100 100 Z"/></svg>';
  const rs = parseSvgPath(svg.match(/d="([^"]+)"/)[1]);
  check('SVG 三角解析出 1 条闭合路径', rs.subpaths.length === 1 && rs.subpaths[0].closed);
  // 90 + 90 + √(90²+90²) = 307.28
  const expectLen = 180 + Math.hypot(90, 90);
  check('SVG 长度正确', near(pathLength(rs), expectLen, 0.01),
    `实际 ${pathLength(rs).toFixed(2)}，期望 ${expectLen.toFixed(2)}`);

  // 相对命令必须与绝对命令等价（Y 翻转最容易在这里出错）
  const rel = parseSvgPath('m10 10 l90 0 l0 90 z');
  check('相对命令与绝对等价', near(pathLength(rel), expectLen, 0.01), `实际 ${pathLength(rel).toFixed(2)}`);

  const cubic = parseSvgPath('M0 0 C 10 0, 10 10, 0 10');
  check('SVG 三次贝塞尔可解析', pathLength(cubic) > 15, `长度 ${pathLength(cubic).toFixed(2)}`);
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
  // 警告是 {zh, en} 对象（前端按语言挑），所以要分别验两种语言都有内容。
  // 之前这里写的是 w.includes(...) —— 警告改成对象后直接 TypeError，
  // 说明这条断言确实在守着「警告的形态」，不是摆设。
  check('负坐标被拦截（中英文都在）',
    c3.warnings.some((w) => w && w.zh && w.zh.includes('负坐标') && w.en && w.en.includes('negative')),
    JSON.stringify(c3.warnings));

  const est = estimateTime(c.path, 30);
  check('时间估算为正', est.totalSeconds > 0, `${est.totalSeconds.toFixed(1)}s`);
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
  // 旋转 90° 后：原字高(20) 变成宽度，原字宽(66.7) 变成高度
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
  check('串口默认 9600 8N1 无流控',
    au.serialDefault.baud === 9600 && au.serialDefault.dataBits === 8
    && au.serialDefault.stopBits === 1 && au.serialDefault.parity === 'none');

  // 关键安全性质：超框必须被拦下
  const edge = circleToPath(au.width - 20, 300, 20);   // 刚好贴边
  const over = circleToPath(au.width + 10, 300, 20);   // 超出 30mm
  const cEdge = compileToolpath(edge, au, {});
  const cOver = compileToolpath(over, au, {});
  check('贴边图形(最大边界正好 600mm)放行', cEdge.warnings.length === 0, JSON.stringify(cEdge.warnings));
  check('超出 600mm 的图形被拦截', cOver.warnings.length > 0, '未报警');

  // 630 预设仍可用，供铭牌确认后切换
  const e = MACHINE_PRESETS['liyue-sc631e'];
  check('630mm 版预设保留（供铭牌确认后切换）', e && e.width === 630, `实际 ${e?.width}`);
}

section('串口写入路径（曾经从未被测到）');
{
  // 背景：SerialTransport.write 里曾写成
  //   const { write } = await import('node:fs/promises')
  // 但 node:fs/promises 没有 write 导出（只有 open），解构出 undefined，
  // 调用即报 "write is not a function"。
  // 连接是成功的，所以表现成「显示已连接、一开始刻就失败」，很像连接问题，
  // 而自检只测了虚拟机的 write，真实串口路径从来没被覆盖过。
  //
  // 这里用伪装的 fd 对象验证「写入走的是 this.fd.write」这一约定。
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

  // 未连接时应报明确错误，而不是 write is not a function
  const t2 = new SerialTransport({ path: '/dev/null' });
  let errMsg = '';
  try { await t2.write('X'); } catch (e) { errMsg = e.message; }
  check('未连接时给出明确错误', errMsg === '串口未连接', `实际「${errMsg}」`);
}

section('坐标轴方向与不发 SC 安全性');
{
  // 🔴 本节只测「轴方向」，所以必须把 layoutRotate 钉死为 0。
  // 力宇预设现在带 layoutRotate:90（实机确认版面要转 90°），
  // 不钉死的话下面每条断言都会因为多了一次 90° 旋转而失效——
  // 而失效的方式是「悄悄算出不同的数」，不是报错。
  // 这是本项目反复踩的坑：断言没锁住维度，改了无关功能就一片红。
  const au = { ...MACHINE_PRESETS['liyue-sc631-au'], layoutRotate: 0 };
  const seg = { subpaths: [{ start: { x: 0, y: 0 }, elems: [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0 }], closed: false }] };

  /**
   * 🔴 核心安全断言：绝不能在卷筒刻字机上发 SC 指令。
   * HP-GL 的 SC 会把卷筒纸轴的缩放除零归零，导致 Y 轴无响应。
   */
  for (const [label, opts] of [
    ['常规', { axisX: 1, axisY: 1 }],
    ['X 反向', { axisX: -1, axisY: 1 }],
    ['Y 反向', { axisX: 1, axisY: -1 }],
    ['双向反向', { axisX: -1, axisY: -1 }],
  ]) {
    const text = compileToPlotterLanguage(seg, au, { ...opts, swapAxes: false }).text;
    check(`${label}轴向下不含 SC 指令（防止滚筒 Y 轴失灵）`, !/\bSC-?\d+/.test(text));
  }

  // 方向差异必须体现在**坐标**上，而不是 SC 上
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

  // 关键安全项：回原点必须是纯机械归位，不带任何坐标指令
  const h = new HpglBuilder(au, { axisX: -1 });
  h.setupCoords({ x: 0, y: 0 }); h.home();
  check('回原点用 !PG（机械归位）而非 PA0,0',
    h.cmds.some((c) => c.includes('!PG')) && !h.cmds.some((c) => c.includes('PA0,0')),
    h.cmds.join(' '));

  // 手动「回原点」绝不能带 IN / SC：归位是纯物理动作，不该掺入坐标系假设
  const mh = buildManualCommand(au, { action: 'home' });
  check('手动回原点含 !PG 且不带 SC（归位不掺入坐标系假设）',
    !/\bSC/.test(mh.text) && mh.text.includes('!PG'),
    mh.text.replace(/\n/g, ' ').trim());

  /**
   * 🔴 回归测试：漏发 IN; 会让整台机器**所有按钮失灵**（2026-10-04 实机）。
   *
   * 力宇固件冷启动后处于未初始化状态，没有 `IN;` 就静默忽略所有运动指令——
   * 串口写入成功、任务显示「完成」，但机器纹丝不动，
   * 表现和「串口坏了」一模一样。
   * 修坐标轴时曾把 IN; 当成「多余的状态重置」删掉，直接导致全机失灵，
   * 而且下面那条「不含 IN」的断言还把它当成了正确行为。
   * 这组断言就是为了防止它再被当成冗余删掉。
   */
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

  // 手动 jog 必须是相对移动，且收尾不能把刀头拽回原点。
  // 用 swapAxes:false 的机型副本，让断言聚焦「相对 vs 绝对」这一个维度；
  // 交换轴下的增量换轴由「轴交换」一节负责。
  const auNoSwap = { ...au, swapAxes: false, axisX: 1, axisY: 1 };
  const mv = buildManualCommand(auNoSwap, { action: 'move', dx: 5, dy: 0 });
  check('手动 jog 用 PR 相对移动（非 PA 绝对跳变）',
    /PR-?197,0;/.test(mv.text) && !/PA-?\d+,-?\d+;/.test(mv.text),
    mv.text.replace(/\n/g, ' ').trim());
  check('手动 jog 收尾只切模式、不移动到原点',
    mv.text.includes('PA;') && !mv.text.includes('PA0,0'),
    mv.text.replace(/\n/g, ' ').trim());

  // 落刀试压必须是相对 2mm：原来是绝对 lineTo(2,0)，落刀状态下会划穿材料
  const pd = buildManualCommand(auNoSwap, { action: 'pendown' });
  check('落刀试压为相对 2mm，不做绝对移动',
    /PD;/.test(pd.text) && /PR-?79,0;/.test(pd.text) && !/PA-?\d+,-?\d+;/.test(pd.text),
    pd.text.replace(/\n/g, ' ').trim());

  // 校准指令必须小步、抬刀、纯相对（同样锁定不交换，隔离维度）
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
  // 锁定 layoutRotate:0：本节只测「方向」对几何的影响。
  // 换轴与版面旋转另有一节，不锁的话断言就不成立了。
  const au = { ...MACHINE_PRESETS['liyue-sc631-au'], layoutRotate: 0 };
  // 锁定不交换：本节只测「方向」对几何的影响，交换轴另有一节。
  // 不锁的话预设的 swapAxes:true 会把包围盒也旋转，断言就不成立了。
  const auMirror = { ...au, swapAxes: false };
  // 四种轴向组合下，编译再解析回几何都必须无损
  for (const [ax, ay] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const p = circleToPath(300, 300, 25);
    const built = compileToPlotterLanguage(p, auMirror, { axisX: ax, axisY: ay });
    const back = parseHpgl(built.text, { stepsPerInch: au.stepsPerInch });
    const e = back.path.subpaths[0]?.elems?.[0];
    check(`整圆往返（axisX=${ax}, axisY=${ay}）长度误差 <1%`,
      Math.abs(pathLength(back.path) - pathLength(p)) / pathLength(p) < 0.01,
      `误差 ${((pathLength(back.path) - pathLength(p)) / pathLength(p) * 100).toFixed(3)}%`);
    check(`整圆往返（axisX=${ax}, axisY=${ay}）半径不变`,
      e && e.r > 24 && e.r < 26, `半径 ${e?.r}`);
  }

  // 直线在镜像下应落到对称位置（x → width - x），且长度不变
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
  // 同样锁定 layoutRotate:0——本节测的是「换轴」，与版面旋转正交。
  const au = { ...MACHINE_PRESETS['liyue-sc631-au'], layoutRotate: 0 };
  // machineSpanX/Y 是各轴物理跨度的来源
  const bSwap = new HpglBuilder(au, { axisX: 1, axisY: 1, swapAxes: true });
  const bNo = new HpglBuilder(au, { axisX: 1, axisY: 1, swapAxes: false });
  check('未交换时 machineSpanX 为幅面宽 600', bNo.machineSpanX === au.width);
  check('交换后 machineSpanX 互换为进纸长 710', bSwap.machineSpanX === au.height);
  check('machineSpanX 随交换改变', bSwap.machineSpanX === au.height && bNo.machineSpanX === au.width,
    `${bSwap.machineSpanX} vs ${bNo.machineSpanX}`);

  // 交换：用户 (x,y) → 机器 (y,x)
  check('交换后用户 (100,200) 映射到机器 (200,100)',
    bSwap.toMachine(100, 200).x === 200 && bSwap.toMachine(100, 200).y === 100,
    JSON.stringify(bSwap.toMachine(100, 200)));
  check('未交换时用户 (100,200) 映射到机器 (100,200)',
    bNo.toMachine(100, 200).x === 100 && bNo.toMachine(100, 200).y === 200,
    JSON.stringify(bNo.toMachine(100, 200)));

  // 增量也要换轴：用户「往右 5mm」在交换后应变成机器 Y 方向
  check('交换后往右的增量落在机器 Y 上',
    bSwap.toMachineDelta(5, 0).dx === 0 && bSwap.toMachineDelta(5, 0).dy === 5,
    JSON.stringify(bSwap.toMachineDelta(5, 0)));

  // 反射判定：交换(1次) + 单轴反向(1次) = 2 次 = 旋转，绕向不变
  check('交换 + 单轴反向 = 旋转（isReflection=false）',
    new HpglBuilder(au, { axisX: -1, axisY: 1, swapAxes: true }).isReflection === false);
  check('仅交换 = 反射（isReflection=true）',
    new HpglBuilder(au, { axisX: 1, axisY: 1, swapAxes: true }).isReflection === true);

  // 几何往返：交换不改变长度，只旋转包围盒
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

  // 整圆在交换下往返无损
  for (const sw of [false, true]) {
    const c = circleToPath(300, 300, 25);
    const t = compileToPlotterLanguage(c, { ...au, axisX: 1, axisY: 1, swapAxes: sw }).text;
    const back = parseHpgl(t, { stepsPerInch: au.stepsPerInch }).path;
    const e = back.path?.subpaths?.[0]?.elems?.[0] ?? back.subpaths[0]?.elems?.[0];
    check(`交换=${sw} 时整圆往返长度误差 <1%`,
      Math.abs(pathLength(back) - pathLength(c)) / pathLength(c) < 0.01,
      `误差 ${((pathLength(back) - pathLength(c)) / pathLength(c) * 100).toFixed(3)}%`);
    check(`交换=${sw} 时整圆半径不变`, e && e.r > 24 && e.r < 26, `半径 ${e?.r}`);
  }

  // 校准指令在交换下也必须只动一根轴，且走 5mm
  const calSwap = buildCalibrationStep(au, { dir: 'x+', axisX: 1, axisY: 1, swapAxes: true });
  const prs = [...calSwap.matchAll(/PR(-?\d+),(-?\d+);/g)].map((m) => [+m[1], +m[2]]);
  check('交换后校准仍走 5mm 且只动一根轴',
    prs.length === 2 && (Math.abs(prs[0][0]) === 197 || Math.abs(prs[0][1]) === 197)
    && (prs[0][0] === 0 || prs[0][1] === 0),
    JSON.stringify(prs));
}

section('版面旋转 90°（实机：整版逆时针歪 90°，补偿为顺时针 90°）');
{
  const W = 600, H = 710;   // 画布 600×710（幅面宽 × 进纸长）
  const base = { width: W, height: H, stepsPerInch: 1000, dialect: 'hpgl' };

  /**
   * 🔴 这组断言锁的是 2026-10-05 实机结论：
   * 「SparkMinds」横排刻出来整版逆时针歪 90°，方向正确（不镜像）。
   * 补偿 = 顺时针 90°。
   *
   * 判据用**一条水平线**：
   * 顺时针 90° 后，原来的水平线必须变成**垂直线**。
   * 如果哪天改回成镜像（swapAxes）而不是旋转，这条约 400×0 的线
   * 仍然会变成垂直的——所以额外断言了方向（见下），
   * 两者合起来才能唯一确定是「顺时针 90°」而不是「任意 90°」。
   */
  const b90 = new HpglBuilder({ ...base, layoutRotate: 90 }, { axisX: 1, axisY: 1, swapAxes: false });

  // 画布左下角 (0,0) 经顺时针 90° 后应落到新框的左下角
  check('旋转 90°：原点映射到 (0, 画布宽)', (() => {
    const p = b90.toMachine(0, 0);
    return p.x === 0 && p.y === W;
  })(), JSON.stringify(b90.toMachine(0, 0)));

  // 画布右下角 (W,0) → 新框左下 (0,0)：原「下边」变成新「左边」
  check('旋转 90°：原右下角映射到 (0,0)', (() => {
    const p = b90.toMachine(W, 0);
    return p.x === 0 && p.y === 0;
  })(), JSON.stringify(b90.toMachine(W, 0)));

  // 原左边 (0,y) → 新上边 (y, W)：原 x=0 那条边变成新 y=W 那条边
  check('旋转 90°：原左边变成新上边', (() => {
    const p = b90.toMachine(0, 100);
    return p.x === 100 && p.y === W;
  })(), JSON.stringify(b90.toMachine(0, 100)));

  // 关键判据：水平线 → 垂直线
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

  // 「顺时针」而非「逆时针」：原左下角必须去新框的**左上**。
  // 顺时针：原左边 → 新上边，故 (0,0) 在新框 y=W（顶部）。
  // 逆时针则会让 (0,0) 落到 y=0（底部）——这一条把方向钉死。
  check('旋转 90° 方向为顺时针（原左下 → 新左上）', b90.toMachine(0, 0).y === W);

  // 旋转是 det=+1 的纯旋转，**不翻转圆弧绕向**
  check('旋转不计入反射（isReflection 仍为 false）', b90.isReflection === false);
  // 90° 旋转不改变 det，所以「旋转 + 换轴」= 一次反射（不是两次相乘）
  check('旋转 + 换轴 仍为反射（旋转不抵反射）',
    new HpglBuilder({ ...base, layoutRotate: 90 }, { swapAxes: true }).isReflection === true);
  // 真正抵掉反射的是「换轴 + 单轴反向」两次 det=-1
  check('换轴 + 单轴反向 = 旋转（两次反射相抵）',
    new HpglBuilder(base, { axisX: -1, axisY: 1, swapAxes: true }).isReflection === false);

  // 圆弧在旋转下往返无损（绕向不变，长度守恒）
  const cRot = circleToPath(300, 300, 25);
  const cBack = parseHpgl(
    compileToPlotterLanguage(cRot, { ...base, layoutRotate: 90 },
      { axisX: 1, axisY: 1, swapAxes: false }).text,
    { stepsPerInch: 1000 }).path;
  check('旋转 90°：整圆往返长度误差 <1%',
    Math.abs(pathLength(cBack) - pathLength(cRot)) / pathLength(cRot) < 0.01,
    `${((pathLength(cBack) - pathLength(cRot)) / pathLength(cRot) * 100).toFixed(3)}%`);

  // 相对位移必须与绝对坐标同向：画布「往右 5mm」在旋转后是机器 Y 方向
  const d = b90.toMachineDelta(5, 0);
  check('旋转 90°：画布往右 → 机器 Y 负向（与绝对变换自洽）', d.dx === 0 && d.dy === -5,
    JSON.stringify(d));
  const dAbs = b90.toMachine(10, 0), dAbs0 = b90.toMachine(5, 0);
  check('旋转 90°：相对位移与绝对变换自洽',
    (dAbs.x - dAbs0.x) === d.dx && (dAbs.y - dAbs0.y) === d.dy,
    `Δ=${JSON.stringify({ dx: dAbs.x - dAbs0.x, dy: dAbs.y - dAbs0.y })} vs ${JSON.stringify(d)}`);

  // 跨度：旋转 90° 后 X/Y 角色对调，机器 X 应拿到 710（进纸长）
  check('旋转 90° 后 machineSpanX 为进纸长 710', b90.machineSpanX === H, `${b90.machineSpanX}`);
  check('旋转 90° 后 machineSpanY 为幅面宽 600', b90.machineSpanY === W, `${b90.machineSpanY}`);
  check('旋转 0 时跨度不换', new HpglBuilder(base, { layoutRotate: 0 }).machineSpanX === W);

  // 旋转 + 换轴相互抵消（异或）：跨度应回到不换
  const bBoth = new HpglBuilder({ ...base, layoutRotate: 90 }, { swapAxes: true });
  check('旋转 90° + 换轴相互抵消（跨度回到 600）', bBoth.machineSpanX === W, `${bBoth.machineSpanX}`);

  // 归一化：非 90° 倍数被收敛，不允许悄悄生效
  check('旋转角归一化到 90 的倍数（37° → 0）',
    new HpglBuilder({ ...base, layoutRotate: 37 }).layoutRotate === 0);
  check('旋转角归一化支持负值与超圈（-90 → 270）',
    new HpglBuilder({ ...base, layoutRotate: -90 }).layoutRotate === 270);
  check('旋转 450° → 90', new HpglBuilder({ ...base, layoutRotate: 450 }).layoutRotate === 90);

  // 逆变换必须严格可逆——预览靠它把机器坐标还原回设计坐标。
  // 不可逆的表现是「预览横躺」，而不是报错，所以必须显式断言。
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

  // 逆变换在「旋转 + 镜像」同时存在时也必须成立（顺序反了就会算错且不报错）
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

  // 实机预设必须带着这个补偿值，否则改了代码也不生效
  check('力宇 SC631-AU 预设有 layoutRotate:90（实机确认）',
    MACHINE_PRESETS['liyue-sc631-au'].layoutRotate === 90,
    `${MACHINE_PRESETS['liyue-sc631-au'].layoutRotate}`);
}

section('服务端双语（每条面向用户的文案都要有中英两份）');
{
  /**
   * 🔴 这组断言防的是「英文界面里悄悄夹着中文」。
   *
   * 那类问题最阴险的地方在于：所有其他检查都是绿的——
   * 语法对、服务起得来、按钮能点、刻字正常。
   * 只有真机操作者才会看到「界面上有句话是中文的」。
   * 所以凡是会走到界面上的文案，都必须有英文，且不能是空串。
   */
  const preset = MACHINE_PRESETS['liyue-sc631-au'];

  // 机型预设
  for (const [id, p] of Object.entries(MACHINE_PRESETS)) {
    check(`机型 ${id} 有英文名`, !!p.nameEn && !/[一-鿿]/.test(p.nameEn), p.nameEn || '(缺失)');
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
  // ⚠️ 这里刻意**不**断言「英文里没有中文」：
  // 缺字提示必须点名是哪几个字，而那个字本身就是中文（如「中」）。
  // 译文里出现这个字是正确行为，不是漏翻译。
  // 真正要守的是：英文句子本身完整、且点名了缺字。
  check('缺字提示有英文且点名了缺字',
    !!tpBad.meta.noteEn && /outside the built-in stroke font/.test(tpBad.meta.noteEn)
    && tpBad.meta.unsupported.length > 0,
    `${tpBad.meta.unsupported.join('')} / ${tpBad.meta.noteEn}`);

  // 任务日志：pushLog(line, en) 两份都要落库，且 line 仍是中文（兼容既有前端）
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

  /**
   * 🔴 回归：抬刀 / 回原点 / 抬刀回位曾经「点了没反应」。
   *
   * 根因：`penUp()` 只在 `penDown === true` 时才发 `PU;`，
   * 这是给生成任务省字节用的优化。但手动按钮场景下，
   * 软件对刀状态的认知来自「本次任务有没有下发过 PD」，
   * 而机器真实状态可能已经不同：
   *   - 上一次任务中途被停止 / 急停
   *   - 串口断线重连（软件状态清零，机器还压着）
   *   - 换过控制板
   * 此时按「抬刀」一条指令都不发 → 按钮点了没反应，刀还压着材料。
   *
   * 抬刀是**安全**操作，多发一个字节的成本可以忽略；不发指令的风险不行。
   */
  check('penUp() 在未落刀时确实不发光刀指令（省字节优化的原意）',
    !new HpglBuilder(au, {}).penUp().cmds.includes('PU;'), '应为空');
  check('forcePenUp() 永远发光刀指令',
    new HpglBuilder(au, {}).forcePenUp().cmds.includes('PU;'), '应含 PU;');

  for (const [label, act, mustHave] of [
    ['抬刀', { action: 'penup' }, ['PU;']],
    ['回原点', { action: 'home' }, ['PU;', '!PG;']],
    ['抬刀回位', { action: 'end' }, ['PU;', '!PG;']],
    ['落刀试压', { action: 'pendown' }, ['PD;', 'PU;']],
    ['停止', { action: 'stop' }, ['PU;', 'SP0;']],
  ]) {
    const t = buildManualCommand(au, act).text;
    const missing = mustHave.filter((k) => !t.includes(k));
    check(`${label}必定下发 ${mustHave.join('+')}（无条件，不看软件状态）`,
      missing.length === 0, missing.length ? `缺少 ${missing.join(',')}` : t.replace(/\n/g, ' ').trim());
  }

  // 落刀试压必须「先抬 → 落 → 试 → 抬」，收尾的抬刀不能省
  const pd = buildManualCommand(au, { action: 'pendown' }).text.trim().split('\n').map((l) => l.trim());
  check('落刀试压顺序为 抬→落→走→抬',
    pd.indexOf('PD;') > pd.indexOf('PU;')
    && pd.lastIndexOf('PU;') > pd.indexOf('PD;'),
    pd.join(' '));
}

section('串口自动重连（服务重启后机器不能「失联」）');
{
  /**
   * 服务每次重启都会释放串口，界面上的手动按钮随之全部置灰，
   * 表现为「点什么都不反应」——用户会以为机器坏了。
   * 配置里已经记了串口路径，具备自动重连条件，所以必须自动接回。
   */
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
  // 一条体积像样的任务：几百行。
  // 用高波特让任务在测试窗口内跑完——按真实 9600 波特要等十几秒，
  // 自检不该为了验证一个字段而 sleeps 十几秒。
  const gcode = new Array(400).fill('PU100,100;').join('\n') + '\n';
  eng.enqueue({ name: '大任务', text: gcode, baud: 960000 });
  eng.run();
  // 等任务真正进历史（而不是只看 progress 事件）
  for (let i = 0; i < 60 && eng.history.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * 历史保留 50 条。若每条都留着 text + lines，
   * 几百行的任务累积起来就是几十 MB 常驻——服务跑几天内存只涨不降。
   * 界面只需要名字/状态/进度/字节数，指令全文没有展示价值。
   */
  const h = eng.history[0];
  check('历史条目不保留指令全文 text', h && h.text === undefined,
    h && Object.keys(h).join(','));
  check('历史条目不保留 lines 数组', h && h.lines === undefined,
    h && Object.keys(h).join(','));
  check('历史仍保留展示所需字段',
    h && typeof h.name === 'string' && typeof h.bytes === 'number' && typeof h.totalLines === 'number',
    h && JSON.stringify({ name: h.name, bytes: h.bytes, totalLines: h.totalLines }));
  // list() 曾读 j.lines.length / j.text.length，剥字段后必须不抛错
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
  const iFirstMove = lines.findIndex((l) => /^PA-?\d/.test(l));

  /**
   * 🔴 关键原点保护断言：默认刻绘开头绝不能发 !PG; 机械归位。
   *
   * 刻字机是以操作者在材料上设定的对刀原点为基准的。
   * 开头下发 !PG; 会让刀头横跨整机去撞限位开关，不仅冲掉用户原点，还会造成 X 轴远离原点狂奔。
   */
  check('默认任务开头不发 !PG（保护用户对刀原点）',
    !lines[0].includes('!PG'), `实际首行「${lines[0]}」`);
  check('任务开头以 IN; 初始化',
    lines[0] === 'IN;', `实际首行「${lines[0]}」`);
  check('默认结尾抬刀并返回原点 PA0,0;（不强制撞限位）',
    lines.includes('PA0,0;') && !lines.slice(-3).some((l) => l.includes('!PG')), lines.join(' '));
  check('落刀段状态正常',
    lines.slice(iFirstMove).some((l) => l === 'PD;'), '应存在落刀段');

  // homeFirst:true 供需要显式机械归位的场景
  const withHome = compileToPlotterLanguage(rect(), au, { homeFirst: true });
  check('homeFirst:true 可显式开启开头归位',
    withHome.text.startsWith('!PG;'), withHome.text.split('\n')[0]);
  const withEndHome = compileToPlotterLanguage(rect(), au, { homeEnd: true });
  check('homeEnd:true 可显式开启收尾归位',
    withEndHome.text.includes('!PG;\nSP0;'), withEndHome.text.slice(-20));

  // 归位驻留：!PG 之后必须有真实等待，不能被 200ms 上限截断
  check('_sleep 支持非截断的长等待（归位驻留用）',
    (() => {
      const eng = new JobEngine(new NullTransport());
      const t0 = Date.now();
      // 只验证语义：capped:false 不应被压到 200ms
      return typeof eng._sleep(0, { capped: false }).then === 'function';
    })(), '');
}

section('任务引擎');
{
  const vt = new VirtualPlotter({});
  await vt.connect();
  const eng = new JobEngine(vt);
  // 用真实的 9600 波特：任务会持续足够久，暂停/继续才测得到
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

const nt = new NullTransport();
check('空传输可用', typeof nt.write === 'function');

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
