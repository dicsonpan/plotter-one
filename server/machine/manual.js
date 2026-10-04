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
 *             | 'feed' | 'eject' | 'stop' | 'pause' | 'resume' | 'end'
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
  b.setupCoords({ x: 0, y: 0 });
  // 手动控制用中低速，避免手滑时一冲到底把刀撞坏
  const speed = Number(cmd.speed) > 0 ? Number(cmd.speed) : 30;
  b.setSpeed(speed);

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
      // PR = 相对坐标。必须先切到 PR，否则 PA 会跳到绝对位置而不是相对移动
      b.penUp();
      b.emit('PR;');
      b.emit(`PA${u(dx)},${u(dy)};`);
      b.emit('PU;PA0,0;');   // 切回绝对坐标，避免影响后续指令
      notes.push(`移动 ${dx.toFixed(1)}, ${dy.toFixed(1)} mm（抬刀状态，不划伤材料）`);
      break;
    }

    case 'home': {
      b.penUp();
      b.home();
      notes.push('回机械原点（刀头移到左下角）');
      break;
    }

    case 'penup': {
      b.penUp();
      notes.push('抬刀');
      break;
    }

    case 'pendown': {
      b.penSelectOn();
      b.lineTo(2, 0);   // lineTo 内部会先 PD 落刀，再走 2mm 让刀切入材料
      notes.push('落刀并在当前位置划入 2mm（用于试刀压）');
      break;
    }

    case 'setorigin': {
      // 力宇兼容 HP-GL，IP 就是「设定用户原点」：把当前位置定义为 (0,0)
      b.penUp();
      b.emit('IP0,0;');
      notes.push('已把当前位置设为新原点（后续坐标以此为基准）');
      break;
    }

    case 'feed': {
      let d = Math.abs(Number(cmd.distance) || 0);
      if (d === 0) { notes.push('距离为 0，未发送进纸指令'); break; }
      if (d > MAX_STEP) { d = MAX_STEP; notes.push(`单次进纸限制在 ${MAX_STEP}mm`); }
      b.penUp();
      b.moveTo(d, 0);   // 相对当前材料位置向右（进纸方向）
      notes.push(`进纸 ${d.toFixed(0)}mm`);
      break;
    }

    case 'eject': {
      let d = Math.abs(Number(cmd.distance) || 0);
      if (d === 0) { notes.push('距离为 0，未发送出纸指令'); break; }
      if (d > MAX_STEP) { d = MAX_STEP; notes.push(`单次出纸限制在 ${MAX_STEP}mm`); }
      b.penUp();
      b.moveTo(-d, 0);  // 往回走 = 出纸
      notes.push(`出纸 ${d.toFixed(0)}mm`);
      break;
    }

    case 'stop': {
      b.emit('SP0;');
      notes.push('关笔/停止输出');
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
      b.end();
      notes.push('抬刀并回原点，本次控制指令结束');
      break;
    }

    default:
      notes.push(`未知指令：${cmd.action}`);
      return { text: '', notes };
  }

  return { text: b.cmds.join('\n') + '\n', notes };
}

export { MAX_STEP };
