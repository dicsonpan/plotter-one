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
   * 🔴 每条手动指令都必须先发初始化前缀 `IN;`（2026-10-04 实机踩到）。
   *
   * 教训：修坐标轴方向时，我嫌 `IN;` 「重置整机状态」把它删了，
   * 结果机器**所有按钮全部失灵**——点什么都没有反应。
   *
   * 原因：力宇固件在冷启动 / 重新上电后处于未初始化状态，
   * **没有 `IN;` 就拒绝执行任何运动指令**（PU / PR / PA / !PG 全部被静默忽略）。
   * 串口层面写入是成功的、任务显示「完成」，但机器不动——
   * 表现和「串口坏了」一模一样，极难定位。
   *
   * 所以「归位要发干净的物理指令」这个判断是对的，但**不能连初始化一起去掉**。
   * 正确做法：`IN;` 保留，危险的 SC 映射（反向 SC）由 hpgl.js 保证为正序。
   *
   * SP1 选刀 + LT 连续线一并带上，与刻字任务保持一致的起始状态。
   */
  const initPrefix = () => {
    b.emit('IN;');
    b.emit('SP1;');
  };

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
      initPrefix();
      b.setSpeed(speed);
      relative(dx, dy);
      notes.push(`移动 ${dx.toFixed(1)}, ${dy.toFixed(1)} mm（抬刀状态，不划伤材料）`);
      break;
    }

    case 'home': {
      /**
       * 机械归位：先 `IN;` 初始化（否则固件拒绝执行），再抬刀 + `!PG`。
       *
       * `!PG` 是物理归位，不经过坐标换算，所以**不带 SC**——
       * 归位不该掺入任何坐标系假设，这是它对轴向设置免疫的原因。
       */
      initPrefix();
      b.forcePenUp();
      b.emit('!PG;');
      notes.push('回机械原点（抬刀后归位，不受坐标设置影响）');
      break;
    }

    case 'penup': {
      /**
       * 用 forcePenUp() 而不是 penUp()。
       *
       * penUp() 在「软件认为刀已抬起」时不发任何指令。手动按钮场景下这是个坑：
       * 上一次任务被停止 / 串口重连 / 换控制板之后，软件认知与机器真实状态
       * 可能不一致，此时按「抬刀」会一条指令都不发——按钮点了没反应，
       * 而刀可能还压着材料。抬刀是安全操作，多发一个字节的成本可忽略。
       */
      initPrefix();
      b.forcePenUp();
      notes.push('抬刀（已强制下发 PU，不依赖软件对刀状态的判断）');
      break;
    }

    case 'pendown': {
      /**
       * 落刀试压：沿当前方向走 2mm 再抬刀。
       *
       * 原来用 `lineTo(2, 0)`，那是**绝对**移动到 (2,0)——
       * 落刀状态下从当前位置直插材料左下角，等于在成品上划一道对角线。
       * 必须用相对移动。
       */
      initPrefix();
      b.forcePenUp();
      b.setSpeed(Math.max(5, speed / 2));
      b.emit('PD;');
      const d = b.toMachineDelta(2, 0);
      b.emit(`PR${u(d.dx)},${u(d.dy)};`);
      b.emit('PA;');
      b.forcePenUp();
      notes.push('落刀并在当前位置划入 2mm（用于试刀压）');
      break;
    }

    case 'setorigin': {
      // 力宇兼容 HP-GL，IP 就是「设定用户原点」：把当前位置定义为 (0,0)
      initPrefix();
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
       * 原来写的是 `moveTo(d, 0)`——那是**绝对**移动到 (d, 0)，
       * 名为「进纸 50mm」实际却是把刀头横移到画面某个位置。
       */
      let d = Math.abs(Number(cmd.distance) || 0);
      if (d === 0) { notes.push('距离为 0，未发送进纸指令'); break; }
      if (d > MAX_STEP) { d = MAX_STEP; notes.push(`单次进纸限制在 ${MAX_STEP}mm`); }
      const sign = cmd.action === 'feed' ? 1 : -1;
      initPrefix();
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
      initPrefix();
      b.forcePenUp();
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
