/**
 * 原点校准向导。
 *
 * 为什么需要：坐标轴方向是**机器硬件属性**，不同型号、甚至同型号不同面板设置
 * 都不一样，没法靠猜。方向错了图形会镜像，再错就会撞机。
 *
 * 设计成「一次只动一小步、每步都问用户看到了什么」：
 * 步长只有 5-10mm，抬刀状态移动，就算方向判断错了也不会出事。
 * 走完一遍就能确定 X 和 Y 的真实方向。
 *
 * 全程 PU（抬刀），绝不下刀。
 *
 * 🔴 只用**相对移动**，绝不用绝对坐标（这是本文件最重要的一条）：
 *   校准的前提是「刀头现在在哪」——而这恰恰是未知的。
 *   如果先 `PA cx,cy` 走到材料中心，在没归位或坐标系不对的机器上，
 *   这一发就是一次横跨整个工作台的冲刺，比待测的 5mm 危险得多。
 *   相对移动以「当前位置」为基准，与归位状态、坐标系设置完全无关，
 *   所以未归位也能安全测试——这正是校准必须先于归位判断的原因。
 */

import { HpglBuilder } from './hpgl.js';

/** 每一步的位移很小，出错也只是一点距离 */
const STEP_MM = 5;

/**
 * 生成一步校准指令。
 *
 * @param {object} preset
 * @param {object} step { dir: 'x+'|'x-'|'y+'|'y-', axisX, axisY }
 */
export function buildCalibrationStep(preset, step) {
  const ax = step.axisX >= 0 ? 1 : -1;
  const ay = step.axisY >= 0 ? 1 : -1;
  const b = new HpglBuilder(preset, { axisX: ax, axisY: ay });
  // 校准一律低速，出错能立刻反应
  b.setSpeed(10);
  b.penUp();

  // 从**当前位置**往某方向走一小步，再原路回来。
  // 全程相对位移，不依赖任何绝对坐标。
  const dx = step.dir === 'x+' ? STEP_MM : step.dir === 'x-' ? -STEP_MM : 0;
  const dy = step.dir === 'y+' ? STEP_MM : step.dir === 'y-' ? -STEP_MM : 0;

  // 方向设置决定「发什么增量」：轴向为 -1 时增量取反，
  // 这样「x+」永远对应用户视角的「往右」，与机器内部正方向无关。
  const d = b.toMachineDelta(dx, dy);
  const u = (mm) => Math.round((mm / 25.4) * b.spi);

  // 🔴 必须先 IN; 初始化，否则力宇固件拒绝执行任何运动指令（见 manual.js 的说明）
  b.emit('IN;');
  b.emit('SP1;');
  b.emit('PR;');
  b.emit(`PR${u(d.dx)},${u(d.dy)};`);
  b.emit(`PR${u(-d.dx)},${u(-d.dy)};`);   // 原路返回
  b.emit('PA;');                          // 仅切回绝对模式，不移动

  return b.cmds.join('\n') + '\n';
}

/**
 * 校准步骤定义。
 *
 * 提问按「用户站在机器正前方看到什么」来写，不是内部术语——
 * 这台机器的机械原点在用户右手边，用「左/右」描述比用坐标符号可靠得多。
 */
export const CALIBRATION_STEPS = [
  {
    dir: 'x+',
    ask: '刀头是往**右**移动了吗？（你正对着机器时的右手边）',
    yes: 'axisX = 1（X 往右）',
    no: 'axisX = -1（X 往左）',
  },
  {
    dir: 'y+',
    ask: '材料是往**里**走（远离你）了吗？',
    yes: 'axisY = 1（Y 向里为正）',
    no: 'axisY = -1（Y 向外为正）',
  },
];

export { STEP_MM };
