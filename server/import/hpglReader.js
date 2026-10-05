/**
 * HPGL / PLT 反向解析：把绘图指令还原成几何路径。
 *
 * 用途：
 *   1. 导入别处生成/导出的 .plt .hgl 文件，直接可视化，不经过自己的 CAM
 *   2. 「回显」自检——把自己编译出的 HPGL 读回来，验证没有丢失指令
 *   3. 手机上快速看一个客户发来的 PLT 文件长什么样
 *
 * 坐标换算必须与 hpgl.js 里的 toPlotterUnits 严格一致，否则回显会整体缩放。
 */

import { makePath, makeSubpath, addLine, addArc, DEG, TAU } from '../geom/path.js';

export function parseHpgl(text, opts = {}) {
  const stepsPerInch = opts.stepsPerInch || 1016;
  const spi = stepsPerInch / 25.4; // 单位/mm
  const path = makePath();
  const warnings = [];

  const toMm = (v) => v / spi;

  let sub = null;
  let cx = 0, cy = 0;          // 当前点（绘图仪单位）
  let sx = 0, sy = 0;
  let penDown = false;
  let mode = 'PA';             // PA 绝对 / PR 相对
  let scActive = false;
  const stats = { commands: 0, unknown: [], penDowns: 0 };

  // 先剥掉私有头
  let body = text.replace(/^LIYUEGRAVING;ESC;/i, '');

  const cmds = body.split(';').map((s) => s.trim()).filter(Boolean);
  for (let raw of cmds) {
    const cmd = raw.replace(/^;/, '').trim();
    if (!cmd) continue;
    stats.commands++;
    if (!Number.isFinite(cx)) cx = 0;
    if (!Number.isFinite(cy)) cy = 0;
    // 助记符长度不固定（PA / PD / PU / AA / SC / VS …），不能用 slice(1)，
    // 必须先吃掉全部字母部分，否则 Number('A3937') = NaN 会污染坐标。
    const mn = /^([A-Za-z!]+)/.exec(cmd);
    const mnemonic = mn ? mn[1].toUpperCase() : '';
    const rest = cmd.slice(mn ? mn[1].length : 0).trim();
    const c = mnemonic[0] || '';

    if (c === 'I' && mnemonic === 'IN') {
      cx = 0; cy = 0; penDown = false;
      continue;
    }
    if (c === 'S' && mnemonic.startsWith('SP')) {
      continue; // 选刀，刻字机只有一把
    }
    if (c === 'L' && mnemonic === 'LT') continue;
    if (c === 'V' && mnemonic === 'VS') continue;
    if (c === 'F' && mnemonic.startsWith('FS')) continue;
    if (c === 'D' && mnemonic === 'DF') { mode = 'PA'; scActive = false; continue; }

    if (c === 'S' && mnemonic.startsWith('SC')) {
      scActive = true;
      const p = rest.split(',').map(Number);
      // SC 之后坐标已经是绘图仪单位，与 mm 的换算一致
      if (p.length >= 4 && p.every((v) => !Number.isNaN(v))) {
        // 记录用户单位映射范围，供 bbox 对齐
        stats.sc = p;
      }
      continue;
    }
    if (c === 'I' && mnemonic.startsWith('IP')) { scActive = true; continue; }

    if (c === 'P' && mnemonic.startsWith('PA')) {
      mode = 'PA';
      const pts = rest.split(',').filter((s) => s !== '').map(Number).filter(Number.isFinite);
      if (!pts.length) continue;
      if (!penDown) {
        // 抬刀状态下的 PA 只是移动：更新位置，不产生路径
        cx = pts[0]; cy = pts[1] || 0;
        continue;
      }
      // 落刀状态下的 PA 是切割路径
      for (let k = 0; k + 1 < pts.length; k += 2) {
        cx = pts[k]; cy = pts[k + 1] || 0;
        addLine(sub, toMm(cx), toMm(cy));
      }
      continue;
    }
    if (c === 'P' && mnemonic.startsWith('PR')) {
      mode = 'PR';
      const pts = rest.split(',').map(Number);
      for (let k = 0; k + 1 < pts.length; k += 2) {
        cx += pts[k]; cy += pts[k + 1] || 0;
        if (penDown && sub) addLine(sub, toMm(cx), toMm(cy));
      }
      continue;
    }
    if (c === 'P' && mnemonic === 'PU') {
      if (penDown) penDown = false;
      const pts = rest.split(',').filter((s) => s !== '').map(Number);
      if (pts.length >= 2) {
        if (mode === 'PR') { cx += pts[0]; cy += pts[1]; } else { cx = pts[0]; cy = pts[1]; }
      }
      continue;
    }
    if (c === 'P' && mnemonic === 'PD') {
      if (!penDown) {
        penDown = true; stats.penDowns++;
        sub = makeSubpath(toMm(cx), toMm(cy));
        path.subpaths.push(sub);
      }
      // PD 可带坐标：PD100,200; 表示落刀并切到该点
      const pts = rest.split(',').filter((s) => s !== '').map(Number);
      for (let k = 0; k + 1 < pts.length; k += 2) {
        if (mode === 'PR') { cx += pts[k]; cy += pts[k + 1]; } else { cx = pts[k]; cy = pts[k + 1]; }
        addLine(sub, toMm(cx), toMm(cy));
      }
      continue;
    }
    if (c === 'A' && mnemonic.startsWith('AA')) {
      const p = rest.split(',').map(Number).filter(Number.isFinite);
      if (p.length >= 4) {
        const ccx = p[0], ccy = p[1], a0 = p[2] * DEG, sweep = p[3] * DEG;
        if (!penDown) { penDown = true; stats.penDowns++; sub = makeSubpath(toMm(cx), toMm(cy)); path.subpaths.push(sub); }
        // 半径由「当前位置到圆心」的实际距离决定，而不是从 a0 推算——
        // 生成器可能从圆周上任意点起弧，两者不一定一致
        const r = Math.hypot(cx - ccx, cy - ccy);
        sub.elems.push({
          type: 'arc',
          cx: toMm(ccx), cy: toMm(ccy),
          r: r / spi,
          a0, a1: a0 + sweep,
        });
        // 终点：绕圆心旋转 sweep。必须先算完再赋值，
        // 否则第二行会用到已被覆盖的 cx，结果半径/位置全错
        const vx = cx - ccx, vy = cy - ccy;
        const ex = vx * Math.cos(sweep) - vy * Math.sin(sweep);
        const ey = vx * Math.sin(sweep) + vy * Math.cos(sweep);
        cx = ccx + ex;
        cy = ccy + ey;
      }
      continue;
    }
    if (c === 'C' && mnemonic.startsWith('CI')) {
      const r = Number(rest);
      if (!penDown) { penDown = true; stats.penDowns++; sub = makeSubpath(toMm(cx), toMm(cy)); path.subpaths.push(sub); }
      sub.elems.push({ type: 'arc', cx: toMm(cx), cy: toMm(cy), r: toMm(r), a0: 0, a1: TAU });
      sub.closed = true;
      continue;
    }
    if (c === 'L' && mnemonic.startsWith('LB')) {
      warnings.push({
        zh: '文件含 LB 文本指令，刻字机场景建议在设计端转为路径后输出',
        en: 'File contains LB text commands — convert text to paths in the design app for engraving',
      });
      continue;
    }
    if (c === '!' && cmd.startsWith('!')) continue;

    if (/^[A-Z]{2}/.test(cmd)) stats.unknown.push(cmd.slice(0, 2));
  }

  if (stats.unknown.length) {
    warnings.push({
      zh: `忽略了 ${stats.unknown.length} 类不认识的指令：${[...new Set(stats.unknown)].join(' ')}`,
      en: `Ignored ${stats.unknown.length} unrecognised command(s): ${[...new Set(stats.unknown)].join(' ')}`,
    });
  }
  void scActive; void sx; void sy;
  return { path, warnings, stats };
}
