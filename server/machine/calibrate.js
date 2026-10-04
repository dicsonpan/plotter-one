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
 */

import { HpglBuilder } from './hpgl.js';

/** 每一步的位移很小，出错也只是一点距离 */
const STEP_MM = 5;

/**
 * 生成一步校准指令。
 * @param {object} preset
 * @param {object} step { dir: 'x+'|'x-'|'y+'|'y-', axisX, axisY }
 */
export function buildCalibrationStep(preset, step) {
  const ax = step.axisX >= 0 ? 1 : -1;
  const ay = step.axisY >= 0 ? 1 : -1;
  const b = new HpglBuilder(preset, { axisX: ax, axisY: ay });
  b.setupCoords({ x: 0, y: 0 });
  b.setSpeed(10);          // 校准一律低速，出错能立刻反应
  b.penUp();

  // 从材料中心往某方向走一小步，回到中心
  const cx = preset.width / 2;
  const cy = preset.height / 2;
  const d = STEP_MM;
  const dx = step.dir === 'x+' ? d : step.dir === 'x-' ? -d : 0;
  const dy = step.dir === 'y+' ? d : step.dir === 'y-' ? -d : 0;

  b.moveTo(cx, cy);
  b.moveTo(cx + dx, cy + dy);
  b.moveTo(cx, cy);
  b.penUp();

  return b.cmds.join('\n') + '\n';
}

/** 校准步骤定义。文字按「用户应该看到什么」写，不是内部术语。 */
export const CALIBRATION_STEPS = [
  {
    dir: 'x+',
    ask: '刀头是往**右**移动了吗？',
    yes: 'axisX = 1（X 向右）',
    no: 'axisX = -1（X 向左）',
  },
  {
    dir: 'y+',
    ask: '刀头是往**上**移动了吗？',
    yes: 'axisY = 1（Y 向上）',
    no: 'axisY = -1（Y 向下）',
  },
];

export { STEP_MM };
