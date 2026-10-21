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
/**
 * 构造一条双语 note。
 *
 * 与 toolpath.js 的 warn() 同构：{zh, en} 由前端按语言挑。
 * 这样接口返回结构对所有 note 一致，前端只需要一套挑法。
 */
function n(zh, en) {
  return { zh, en: en || zh };
}

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
      if (dx === 0 && dy === 0) { notes.push(n('位移为 0，未发送移动指令', 'Zero displacement, no move command sent')); break; }
      if (Math.abs(dx) > MAX_STEP || Math.abs(dy) > MAX_STEP) {
        dx = Math.sign(dx) * Math.min(Math.abs(dx), MAX_STEP);
        dy = Math.sign(dy) * Math.min(Math.abs(dy), MAX_STEP);
        notes.push(n(`单次位移已限制在 ±${MAX_STEP}mm`, `Single move clamped to ±${MAX_STEP}mm`));
      }
      initPrefix();
      b.setSpeed(speed);
      relative(dx, dy);
      notes.push(n(`移动 ${dx.toFixed(1)}, ${dy.toFixed(1)} mm（抬刀状态，不划伤材料）`,
        `Move ${dx.toFixed(1)}, ${dy.toFixed(1)} mm (pen up, will not scratch)`));
      break;
    }

    case 'home': {
      /**
       * 回用户对刀原点 (0,0)。
       *
       * 🔴 严禁发送 `!PG;` 机械归位：
       *   `!PG;` 是搜索右端 X 轴机械限位开关的动作（滚筒 Y 轴无限位开关），
       *   不仅部分固件直接忽略导致「点了没反应」，在响应的机器上还会抛弃对刀原点去撞限位。
       *   因为每次手动移动开头都会发 `IN;` 重置固件内部原点，所以优先用前端记录的
       *   相对偏移 (dx, dy) 通过已实机验证 100% 有效的 `PR dx,dy;` 退回原点，
       *   并补发 `PA; PU0,0; IP0,0;` 锁定原点基准。
       */
      initPrefix();
      b.setSpeed(speed);
      b.forcePenUp();
      const dx = Number(cmd.dx) || 0;
      const dy = Number(cmd.dy) || 0;
      if (dx !== 0 || dy !== 0) {
        const d = b.toMachineDelta(dx, dy);
        b.emit(`PR${u(d.dx)},${u(d.dy)};`);
        b.emit('PA;');
      } else {
        b.emit('PA;');
        b.emit('PU0,0;');
      }
      b.emit('IP0,0;');
      notes.push(n('已抬刀并返回当前对刀原点 (0,0)',
        'Pen up and returned to current user origin (0,0)'));
      break;
    }

    case 'penup': {
      /**
       * 用 forcePenUp() 而不是 penUp()，并显式带上 PA; 与 PR0,0; 确保固件立即执行抬刀。
       */
      initPrefix();
      b.emit('PA;');
      b.forcePenUp();
      b.emit('PR0,0;');
      b.emit('PA;');
      notes.push(n('已抬刀（已强制下发 PU；若刀头原本已抬起则无机械动作）',
        'Pen up (PU forced; no physical movement if blade was already up)'));
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
      notes.push(n('落刀并在当前位置划入 2mm（用于试刀压）',
        'Pen down, cuts 2mm at current position (test press)'));
      break;
    }

    case 'setorigin': {
      // 力宇兼容 HP-GL，IP 就是「设定用户原点」：把当前位置定义为 (0,0)
      initPrefix();
      b.emit('PA;');
      b.forcePenUp();
      b.emit('IP0,0;');
      notes.push(n('已把当前位置设为新原点（后续坐标以此为基准）',
        'Current position set as new origin (all coordinates relative to it)'));
      break;
    }

    case 'feed':
    case 'eject': {
      /**
       * 进纸 / 出纸。
       *
       * 🔴 这台机器（以及力宇 SC 系列）的 **Y 轴就是走纸轴**：
       * 所以进纸必须沿 Y 相对移动。
       */
      let d = Math.abs(Number(cmd.distance) || 0);
      if (d === 0) { notes.push(n('距离为 0，未发送进纸指令', 'Zero distance, no feed command sent')); break; }
      if (d > MAX_STEP) { d = MAX_STEP; notes.push(n(`单次进纸限制在 ${MAX_STEP}mm`, `Single feed clamped to ${MAX_STEP}mm`)); }
      const sign = cmd.action === 'feed' ? 1 : -1;
      initPrefix();
      b.setSpeed(speed);
      relative(0, d * sign);
      notes.push(n(`${cmd.action === 'feed' ? '进纸' : '出纸'} ${d.toFixed(0)}mm`,
        `${cmd.action === 'feed' ? 'Feed' : 'Eject'} ${d.toFixed(0)}mm`));
      break;
    }

    case 'stop': {
      b.emit('PU;');
      notes.push(n('已抬刀并停止输出', 'Pen up and output stopped'));
      break;
    }

    case 'pause': {
      // HP-GL 没有标准暂停指令，用注释行占位。
      // 真正暂停应通过任务引擎（暂停会停止下发后续指令）
      b.emit('EC;');
      notes.push(n('已发送擦除/暂停指令（建议用「暂停」按钮，切任务更可靠）',
        'Erase/pause command sent (prefer the Pause button — more reliable)'));
      break;
    }

    case 'end': {
      /**
       * 抬刀回位：先强制抬刀，再退回当前对刀原点 (0,0)。
       * 严禁下发 `!PG;`（撞限位）与 `SP0;`（部分固件收到 SP0 后进入脱机拒动状态）。
       */
      initPrefix();
      b.setSpeed(speed);
      b.forcePenUp();
      const dx = Number(cmd.dx) || 0;
      const dy = Number(cmd.dy) || 0;
      if (dx !== 0 || dy !== 0) {
        const d = b.toMachineDelta(dx, dy);
        b.emit(`PR${u(d.dx)},${u(d.dy)};`);
        b.emit('PA;');
      } else {
        b.emit('PA;');
        b.emit('PU0,0;');
      }
      b.emit('IP0,0;');
      notes.push(n('已抬刀并返回对刀原点，本次控制结束',
        'Pen up and returned to user origin, control session ended'));
      break;
    }

    default:
      notes.push(n(`未知指令：${cmd.action}`, `Unknown command: ${cmd.action}`));
      return { text: '', notes };
  }

  return { text: b.cmds.join('\n') + '\n', notes };
}

export { MAX_STEP };
