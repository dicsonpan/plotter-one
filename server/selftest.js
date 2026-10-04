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
import { MACHINE_PRESETS, HpglBuilder, compileToPlotterLanguage } from './machine/hpgl.js';
import { buildCalibrationStep } from './machine/calibrate.js';
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
  check('含坐标系 SC', /SC-?\d+,-?\d+,-?\d+,-?\d+;/.test(built.text));
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
  check('1000dpi 下 SC 上界 = 幅面 630mm → 24803',
    a.built.text.includes(`24803`), a.built.text.split('\n').find((l) => l.startsWith('SC')));

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
  check('负坐标被拦截', c3.warnings.some((w) => w.includes('负坐标')), JSON.stringify(c3.warnings));

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

section('坐标轴方向（曾因假定 P1 在左下角而撞机）');
{
  const au = MACHINE_PRESETS['liyue-sc631-au'];
  const seg = { subpaths: [{ start: { x: 0, y: 0 }, elems: [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0 }], closed: false }] };

  // SC 的 Xmin 映射到物理 P1。X 轴反向时必须 Xmin > Xmax（HP-GL 定义的镜像）
  const scOf = (opts) => {
    const t = compileToPlotterLanguage(seg, au, opts).text;
    return t.match(/SC(-?\d+),(-?\d+),(-?\d+),(-?\d+);/);
  };

  const normal = scOf({ axisX: 1, axisY: 1 });
  check('常规轴向 Xmin < Xmax', normal && +normal[1] < +normal[2], normal && normal[0]);

  const flipX = scOf({ axisX: -1, axisY: 1 });
  check('X 反向时 Xmin > Xmax（镜像）', flipX && +flipX[1] > +flipX[2], flipX && flipX[0]);

  const flipY = scOf({ axisX: 1, axisY: -1 });
  check('Y 反向时 Ymin > Ymax', flipY && +flipY[3] > +flipY[4], flipY && flipY[0]);

  check('SC 无 NaN', normal && !/NaN/.test(normal[0]));
  check('SC 覆盖整个幅面（用户单位=mm）',
    normal && +normal[2] === Math.round(au.width / 25.4 * au.stepsPerInch),
    normal && `Xmax=${normal[2]}`);

  // 关键安全项：回原点必须用机械归位指令，不能用 PA0,0
  // （SC 反向后 PA0,0 指向 P1，即右端，不是机械原点）
  const h = new HpglBuilder(au, { axisX: -1 }).home();
  check('回原点用 !PG（机械归位）而非 PA0,0',
    h.cmds.some((c) => c.includes('!PG')) && !h.cmds.some((c) => c.includes('PA0,0')),
    h.cmds.join(' '));

  // 校准指令必须小步、抬刀
  const cal = buildCalibrationStep(au, { dir: 'x+', axisX: 1, axisY: 1 });
  check('校准指令全程抬刀（不含 PD）', !cal.includes('PD'), cal.replace(/\n/g, ' ').slice(0, 70));
  // 从中心走 5mm 再回来，X 方向的往返差必须正好是 5mm 换算成 197 单位
  const pas = [...cal.matchAll(/PA(-?\d+),(-?\d+);/g)].map((m) => [+m[1], +m[2]]);
  const dx = Math.abs(pas[1][0] - pas[0][0]);
  check('校准位移为 5mm（197 单位）', dx === 197, `实测 ${dx} 单位 = ${(dx / au.stepsPerInch * 25.4).toFixed(2)}mm`);
  check('校准走完能回到起点', pas[0][0] === pas[2][0] && pas[0][1] === pas[2][1],
    JSON.stringify(pas));
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
