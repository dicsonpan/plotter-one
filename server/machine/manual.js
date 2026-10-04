/**
 * 手动控制指令生成。
 *
 * 面向实际操作场景：把刀头移到某个位置、抬刀落刀、回原点、设原点、进纸出纸。
 * 这些是 Ucancam / 文泰那类软件的基本操作，也是在真机上定位、校准、
 * 试刻前清场时反复要用的动作。
 *
 * 全部走 HP-GL，不用任何私有指令——力宇机器兼容 HP-GL，
 * 这样最稳，不依赖对固件私有命令的猜测。
 *
 * 坐标一律用「材料坐标（mm，左下为原点）」，与画布和 CAM 保持一致。
 * 内部换算交给 HpglBuilder 的 mm2u，避免各处重复写 stepsPerInch 系数。
 */

import { HpglBuilder } from './hpgl.js';

/** 单次移动/进纸的距离上限（mm）。防止手滑点一下把刀送到材料外。 */
const MAX_STEP = 200;

/**
 * 生成手动控制指令串。
 *
 * @param {object} preset 机器预设（提供 stepsPerInch / dialect / 幅面）
 * @param {object} cmd 指令描述
 *   - action: 'move' | 'home' | 'penup' | 'pendown' | 'setorigin'
 *             | 'feed' | 'eject' | 'stop' | 'pause' | 'end'
 *   - dx, dy: move 的相对位移（mm）
 *   - distance: feed/eject 的距离（mm，正数）
 *   - x, y: setorigin 的绝对位置（mm）
 *   - speed: 移动速度 mm/s（可选，缺省用 preset 的保守值）
 * @returns {{text: string, notes: string[]}}
 */
export function buildManualCommand(preset, cmd) {
  const notes = [];
  const b = new HpglBuilder(preset);
  // mm → 机器单位。与 HpglBuilder.moveTo 用的是同一套换算
  // （0.0254mm/step，力宇为 1000 步/英寸）。
  const u = (mm) => Math.round((mm / 25.4) * b.spi);

  // 手动控制用中低速，避免手滑时一冲到底把刀撞坏
  const speed = Number(cmd.speed) > 0 ? Number(cmd.speed) : 30;

  /**
   * 相对位移指令。
   *
   * 🔴 HP-GL 的 PA/PR 语义（这里原先踩了大坑）：
   *   `PR;` 只是把模式切成相对，**不带坐标**；
   *   随后的 `PA x,y;` 是「切回绝对并移动到 (x,y)」——
   *   不是「相对移动 x,y」。原代码 `PR;` + `PA197,0;` 在镜像机器上
   *   表现为一记朝原点的绝对冲刺。
   *   正确的相对移动是 `PR dx,dy;`（带坐标的 PR 本身就是相对位移）。
   *
   * 收尾用 `PA;`（不带坐标）只切模式、不移动。
   * 原代码收尾写的是 `PU;PA0,0;`——`PA0,0` 是**真的移动到 (0,0)**，
   * 于是每点一次方向键，刀头都会被拽回原点。改成 `PA;`。
   */
  const relative = (dxMm, dyMm) => {
    const d = b.toMachineDelta(dxMm, dyMm);
    b.emit('PU;');
    b.emit(`PR${u(d.dx)},${u(d.dy)};`);
    b.emit('PA;');   // 仅切回绝对模式，不移动
  };

  switch (cmd.action) {
    case 'move': {
      let dx = Number(cmd.dx) || 0;
      let dy = Number(cmd.dy) || 0;
      if (dx === 0 && dy === 0) { notes.push('位移为 0，未发送移动指令'); break; }
      if (Math.abs(dx) > MAX_STEP || Math.abs(dy) > MAX_STEP) {
        dx = Math.sign(dx) * Math.min(Math.abs(dx), MAX_STEP);
        dy = Math.sign(dy) * Math.min(Math.abs(dy), MAX_STEP);
        notes.push(`单次位移已限制在 ±${MAX_STEP}mm`);
      }
      relative(dx, dy);
      notes.push(`移动 ${dx.toFixed(1)}, ${dy.toFixed(1)} mm（抬刀状态，不划伤材料）`);
      break;
    }

    case 'home': {
      /**
       * 🔴 机械归位：**只发 PU + !PG**，不发 IN、也不发 SC。
       *
       * 理由：
       *   - `!PG` 是力宇的物理归位，不经过坐标换算，对轴向设置免疫；
       *   - `IN;` 会重置整机状态，SC 会改变 P1/P2 映射——
       *     在归位前塞这两条，等于让机器带着人为设定的坐标系去找机械原点，
       *     是「Y 轴飞转、X 轴反走」这类失控的温床。
       * 归位就该是归位：最少指令，物理动作，不掺杂任何坐标假设。
       */
      b.penUp();
      b.emit('PU;');
      b.emit('!PG;');
      notes.push('回机械原点（抬刀后归位，不受坐标设置影响）');
      break;
    }

    case 'penup': {
      b.penUp();
      notes.push('抬刀');
      break;
    }

    case 'pendown': {
      /**
       * 落刀试压：沿当前方向走 2mm 再抬刀。
       *
       * 原代码用 `lineTo(2, 0)`，那是**绝对**移动到 (2,0)——
       * 落刀状态下从当前位置直插材料左下角，等于在成品上划一道对角线。
       * 必须用相对移动。
       */
      b.penUp();
      b.setSpeed(Math.max(5, speed / 2));
      b.emit('PD;');
      const d = b.toMachineDelta(2, 0);
      b.emit(`PR${u(d.dx)},${u(d.dy)};`);
      b.emit('PA;');
      b.penUp();
      notes.push('落刀并在当前位置划入 2mm（用于试刀压）');
      break;
    }

    case 'setorigin': {
      // 力宇兼容 HP-GL，IP 就是「设定用户原点」：把当前位置定义为 (0,0)
      b.penUp();
      b.emit('PU;');
      b.emit('IP0,0;');
      notes.push('已把当前位置设为新原点（后续坐标以此为基准）');
      break;
    }

    case 'feed':
    case 'eject': {
      /**
       * 进纸 / 出纸。
       *
       * 🔴 这台机器（以及力宇 SC 系列）的 **Y 轴就是走纸轴**：
       * 用户报「回原点时 Y 轴疯狂转动」，那个转的就是走纸滚筒。
       * 所以进纸必须沿 Y 相对移动。
       *
       * 原代码写的是 `moveTo(d, 0)`——那是**绝对**移动到 (d, 0)，
       * 名为「进纸 50mm」实际却是把刀头横移到画面某个位置。
       */
      let d = Math.abs(Number(cmd.distance) || 0);
      if (d === 0) { notes.push('距离为 0，未发送进纸指令'); break; }
      if (d > MAX_STEP) { d = MAX_STEP; notes.push(`单次进纸限制在 ${MAX_STEP}mm`); }
      const sign = cmd.action === 'feed' ? 1 : -1;
      b.setSpeed(speed);
      relative(0, d * sign);
      notes.push(`${cmd.action === 'feed' ? '进纸' : '出纸'} ${d.toFixed(0)}mm`);
      break;
    }

    case 'stop': {
      b.emit('PU;');
      b.emit('SP0;');
      notes.push('抬刀并关笔，停止输出');
      break;
    }

    case 'pause': {
      // HP-GL 没有标准暂停指令，用注释行占位。
      // 真正暂停应通过任务引擎（暂停会停止下发后续指令）
      b.emit('EC;');
      notes.push('已发送擦除/暂停指令（建议用「暂停」按钮，切任务更可靠）');
      break;
    }

    case 'end': {
      b.penUp();
      b.emit('PU;');
      b.home();
      b.emit('SP0;');
      notes.push('抬刀并回机械原点，本次控制指令结束');
      break;
    }

    default:
      notes.push(`未知指令：${cmd.action}`);
      return { text: '', notes };
  }

  return { text: b.cmds.join('\n') + '\n', notes };
}

export { MAX_STEP };
