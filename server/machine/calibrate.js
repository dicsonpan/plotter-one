/**
 * 安全微动指令生成（原点校准 / 诊断用）。
 *
 * ⚠️ 2026-10-05 起**不再由界面调用**——坐标轴方向与版面朝向已在实机确认，
 * 并固化到 `machine/hpgl.js` 的机型预设里，界面不再暴露这些开关。
 * `/api/calibrate` 端点与对应的前端向导已一并移除。
 *
 * 保留这个模块有两个理由：
 *   1. 换机器 / 换控制板时仍需要一种**绝对安全**的方式去试方向：
 *      全程抬刀、一次只走 5mm、用相对移动所以未归位也能测。
 *      直接手写指令没有这个保证。
 *   2. 它是「相对移动 + 强制抬刀」这条安全约定的活文档与回归测试。
 *
 * 所以它现在是**诊断工具**，不是用户流程的一部分——
 * 文档与注释按这个定位写，别再把它当 wizard 看待。
 *
 * 全程 PU（抬刀），绝不下刀。
 *
 * 🔴 只用**相对移动**，绝不用绝对坐标（这是本文件最重要的一条）：
 *   前提是「刀头现在在哪」——而这恰恰是未知的。
 *   如果先 `PA cx,cy` 走到材料中心，在没归位或坐标系不对的机器上，
 *   这一发就是一次横跨整个工作台的冲刺，比待测的 5mm 危险得多。
 *   相对移动以「当前位置」为基准，与归位状态、坐标系设置完全无关。
 */

import { HpglBuilder } from './hpgl.js';

/** 每一步的位移很小，出错也只是一点距离 */
const STEP_MM = 5;

/**
 * 生成一步校准指令。
 *
 * @param {object} preset
 * @param {object} step { dir: 'x+'|'x-'|'y+'|'y-', axisX, axisY, swapAxes }
 */
export function buildCalibrationStep(preset, step) {
  const ax = step.axisX >= 0 ? 1 : -1;
  const ay = step.axisY >= 0 ? 1 : -1;
  const b = new HpglBuilder(preset, { axisX: ax, axisY: ay, swapAxes: !!step.swapAxes });
  // 校准一律低速，出错能立刻反应
  b.setSpeed(10);
  b.penUp();

  // 从**当前位置**往某方向走一小步，再原路回来。
  // 全程相对位移，不依赖任何绝对坐标。
  const dx = step.dir === 'x+' ? STEP_MM : step.dir === 'x-' ? -STEP_MM : 0;
  const dy = step.dir === 'y+' ? STEP_MM : step.dir === 'y-' ? -STEP_MM : 0;

  // 方向设置决定「发什么增量」：换轴与轴向都会影响增量，
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
 * 校准步骤定义（诊断用文案，界面已不再展示）。
 *
 * 提问按「用户站在机器正前方看到什么」来写，不是内部术语——
 * 这台机器的机械原点在用户右手边，用「左/右」「里/外」描述
 * 比让用户理解坐标符号可靠得多。
 *
 * `configKey` 说明这一步的答案该写回配置里的哪个字段。
 * ⚠️ 界面已移除该写回逻辑（`axisOptions()` 现在只读机型预设），
 * 所以这个映射**仅供人工诊断时参考**，不要再接回配置写入路径。
 */
export const CALIBRATION_STEPS = [
  {
    dir: 'x+',
    ask: '刀头是往**右**移动了吗？（你正对着机器时的右手边）',
    // 用户 X 在 swap 开启时实际由机器 Y 驱动
    configKey: (swap) => (swap ? 'axisY' : 'axisX'),
    yes: '方向正确',
    no: '方向相反',
  },
  {
    dir: 'y+',
    ask: '材料是往**里**走（远离你）了吗？',
    configKey: (swap) => (swap ? 'axisX' : 'axisY'),
    yes: '方向正确',
    no: '方向相反',
  },
];

/**
 * 判断某一步是否测到了「轴接反」而不是「方向相反」。
 *
 * 判据：让刀头往右走 5mm，如果动的是**走纸**（材料进出）而不是刀头，
 * 说明物理 X/Y 接反了 —— 这不是方向问题，翻转方向修不好。
 *
 * 供前端在用户答「不是」时决定：是改方向，还是提示改轴交换。
 * 返回 true 表示这一步很可能测的是接反。
 */
export function looksLikeAxisSwap(dir) {
  // 「按右」动的是走纸，或「按上」动的是刀头 → 接反
  return dir === 'x+' || dir === 'y-';
}

export { STEP_MM };
