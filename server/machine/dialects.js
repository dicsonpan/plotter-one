/**
 * 协议方言层（Dialect Layer）—— 2026-11-12 为 SparkPlotter-GZ 引入。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 几何层  HpglBuilder（hpgl.js）                                       │
 * │   坐标轴变换 / 版面旋转 / 图元离散 / 就近起刀 / 闭合过切             │
 * │   ↓ 只产出「语义动作」：抬刀到某点、落刀到某点、结束作业             │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ 协议层  本文件 DIALECTS 注册表                                       │
 * │   把语义动作翻译成某台机器听得懂的字节；决定分隔符、初始化、收尾     │
 * │   ↓ CommandStream：{ text, format, estimateText }                    │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ 传输层  jobEngine / transport / VirtualPlotter                       │
 * │   按 format 决定按行下发还是原样字节流下发、如何估算耗时             │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 为什么这样分：机器之间的差异是「怎么说话」，不是「怎么算刀路」。
 * 以前所有分支都塞在 HpglBuilder 里，加一台机器就得在几何代码里到处插
 * if (dialect === ...)，迟早会把已经实机校准过的力宇轴向改坏。
 * 现在新增机器只需要：① 在 MACHINE_PRESETS 加一条（幅面/分辨率/串口）
 * ② 若协议不同，在本文件加一个适配器。几何层一行都不用动。
 *
 * 🔴 回归铁律：hpgl / hpgl3d / dmpl 三个适配器的输出必须与引入本层之前
 * 逐字节一致。server/selftest.js 里有 golden 快照守着，改这里先跑自测。
 */

// ---------------------------------------------------------------------------
// 基准 HP-GL 适配器：力宇 SC 系列 / 通用 1016 机
// ---------------------------------------------------------------------------

const hpgl = {
  id: 'hpgl',
  /** true = 指令是「以空格分隔的连续字节流」，不能被按行 trim / 插换行 */
  stream: false,
  /** 是否默认下发速度指令（build() 里 emitSpeed 未显式指定时） */
  emitSpeedByDefault: false,
  /** 是否支持 AA/CI 硬件圆弧插补；不支持的方言一律离散成折线 */
  nativeArc: true,
  /** 连接后探活要发的字节；null = 不发（纯单工被动型机器） */
  probeCommand: 'IN;',
  /** 虚拟机是否模拟「永不回应答」的单工设备 */
  silent: false,
  /** dmpl 在标准初始化串里额外插两条 */
  initExtra: [],
  /** 是否需要后处理转译（见 compileToPlotterLanguage） */
  postProcess: null,
  /** 是否支持相对移动指令 PR；false 的方言手动控制必须由上位机累加绝对坐标 */
  supportsRelative: true,

  serialize(cmds) { return cmds.join('\n') + '\n'; },

  init(b) {
    b.emit('IN;');
    for (const s of this.initExtra) b.emit(s);
    b.emit('PA;');
    b.emit('SP1;');
    b.emit('PU0,0;');
    b.penDown = false;
    b.pos = { x: 0, y: 0 };
  },

  /** 连续坐标流合并的收束：把 _coordBatch 里的坐标对拼成一条 PD...; */
  flushCoords(b) {
    if (b._coordBatch && b._coordBatch.length > 0) {
      const coords = b._coordBatch.join(',');
      b._coordBatch = [];
      b._flushing = true;
      b.emit(`PD${coords};`);
      b._flushing = false;
    }
  },

  setSpeed(b, mmPerSec) {
    // VS 用 cm/s
    const cmps = Math.max(1, Math.round(mmPerSec / 10));
    b.emit(`VS${cmps};`);
  },

  setForce() {
    // 2D 刻字机的刀压是面板旋钮，软件控制不了
  },

  penUp(b) { b.penDown = false; },

  forcePenUp(b) {
    b.emit('PU;');
    b.penDown = false;
  },

  penSelectOn(b) { b.penDown = false; },

  moveTo(b, px, py) {
    b.emit(`PU${px},${py};`);
    b.penDown = false;
    b.pos = { x: px, y: py };
  },

  lineTo(b, px, py) {
    b.penDown = true;
    b.pos = { x: px, y: py };
    if (b.maxBatchPairs <= 1) {
      b.emit(`PD${px},${py};`);
      return;
    }
    b._coordBatch.push(px, py);
    if (b.maxBatchPairs > 0 && b._coordBatch.length >= b.maxBatchPairs * 2) {
      this.flushCoords(b);
    }
  },

  home(b) {
    b.emit('PU0,0;');
    b.penDown = false;
    b.pos = { x: 0, y: 0 };
  },

  /** 作业收尾。注意绝不默认发 !PG;（会撞限位、丢掉用户对刀原点） */
  finish(b, options) {
    if (options.homeEnd === true) b.emit('!PG;');
    else b.emit('PU0,0;');
  },
};

// ---------------------------------------------------------------------------
// 力宇四轴 / 伺服 3D 机：HP-GL 语法 + 力度指令 + 默认下发速度
// ---------------------------------------------------------------------------

const hpgl3d = {
  ...hpgl,
  id: 'hpgl3d',
  emitSpeedByDefault: true,
  setForce(b, gram) { b.emit(`FS${Math.round(gram)};`); },
};

// ---------------------------------------------------------------------------
// 通用 DMPL：语法仍是 HP-GL，最后整体转译成 DMPL
// ---------------------------------------------------------------------------

const dmpl = {
  ...hpgl,
  id: 'dmpl',
  initExtra: [';:', 'IN;'],
  emitSpeedByDefault: true,
  postProcess: 'hpglToDmpl',
};

// ---------------------------------------------------------------------------
// skm —— SparkPlotter-GZ / 致刻 SKA720 私有文本协议
//
// 实测（逐字节抓包文泰 ToCutter.exe + 上机验证）：
//   1. 不认任何标准 HP-GL，上电静默、从不主动吐数据、从不回应查询 → 纯单工；
//   2. 每条指令以空格 0x20 结尾，空格是唯一的指令边界（全协议没有分号）；
//   3. 抬刀绝对移动 U{x},{y}␠ / 落刀绝对移动 D{x},{y}␠；
//      连续画线用「逗号续接」：首点 D{x},{y}␠，后续点 ,{x},{y}（无空格无 D）；
//   4. 🔴 机器把指令攒在缓冲里，收到作业结束标记 `U F{x} @ ` 才一次性执行。
//      缺这一条 = 发了完全不动（历史上所有「发了不动」的唯一原因）；
//   5. 波特率 9600，8N1；没有 PR 相对移动，也没有 IP 设原点。
// 坐标轴：x = 走纸轴（x 增大 = 料子进），y = 刀头横轴（y 增大 = 往右），
// 物理原点在最右边 —— 与项目 toMachine()/toMachineDelta() 的右下角原点模型一致，
// 所以几何层完全复用，不需要为这台机器单独做变换。
// ---------------------------------------------------------------------------

const SKM_INIT = ';:H A L0 EC1 U ';

const skm = {
  id: 'skm',
  stream: true,
  emitSpeedByDefault: false,
  nativeArc: false,
  probeCommand: null,
  silent: true,
  initExtra: [],
  postProcess: null,
  supportsRelative: false,

  /** 连续字节流：每条指令自带边界空格，join('') 即最终下发字节，末尾不加换行 */
  serialize(cmds) { return cmds.join(''); },

  init(b) {
    b.emit(SKM_INIT);   // 末尾空格是协议的一部分，不能 trim
    b.penDown = false;
    b.pos = { x: 0, y: 0 };
  },

  /** skm 不用 _coordBatch：连续点走逗号续接，没有可「合并」的行 */
  flushCoords() {},

  setSpeed() {},       // 协议里没有速度指令，速度在机器面板设
  setForce() {},       // 刀压同样由面板旋钮控制

  /**
   * 抬刀 = 结束当前笔画。续接点末尾没有空格，必须补一个空格作为边界，
   * 否则下一条 U/D 指令会被机器当成上一条数字的延续。
   */
  penUp(b) {
    if (b.penDown) b.emit(' ');
    b.penDown = false;
  },

  forcePenUp(b) {
    if (b.penDown) b.emit(' ');
    b.emit('U ');
    b.penDown = false;
  },

  penSelectOn() {},

  moveTo(b, px, py) {
    b.emit(`U${px},${py} `);
    b.penDown = false;
    b.pos = { x: px, y: py };
  },

  lineTo(b, px, py) {
    if (!b.penDown) b.emit(`D${px},${py} `);
    else b.emit(`,${px},${py}`);
    b.penDown = true;
    b.pos = { x: px, y: py };
  },

  home(b) {
    b.emit('U0,0 ');
    b.penDown = false;
    b.pos = { x: 0, y: 0 };
  },

  /** 作业提交信号。x 取最后一点的走纸轴坐标；漏发机器完全不动。 */
  finish(b) {
    b.emit(`U F${Math.round(b.pos.x)} @ `);
  },
};

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const DIALECTS = { hpgl, hpgl3d, dmpl, skm };

/** 未知方言一律回退到 HP-GL，避免一个拼错的 preset.dialect 让整台机器哑掉 */
export function getDialect(id) {
  return DIALECTS[id] || DIALECTS.hpgl;
}

/** 从已有指令文本反推下发格式（供用户手工粘贴 gcode、历史任务复用等场景兜底） */
export function detectStreamFormat(text) {
  return typeof text === 'string' && text.startsWith(SKM_INIT) ? 'stream' : 'lines';
}

/**
 * 把连续字节流切成下发单元。
 *
 * 🔴 与 prepareUnits() 的区别：这里绝不能 trim，也不能按 \n 切行——
 * skm 的结尾空格就是指令边界，trim 掉会让机器把两条指令粘成一条。
 * 纯按长度等分即可：字节流连续，串口收到的拼接结果与原文完全一致。
 */
export function splitStreamUnits(text, maxBytes = 512) {
  if (!text) return [];
  const units = [];
  for (let i = 0; i < text.length; i += maxBytes) {
    units.push(text.slice(i, i + maxBytes));
  }
  return units;
}

/**
 * skm 字节流 → 等价 HP-GL 影子文本，只用于运动学耗时估算，绝不下发。
 *
 * 现有 estimateHpglMotion() 是按 HP-GL 语法解析文本的；与其为每种方言
 * 重写一遍估算器，不如让方言提供一份「同几何的 HP-GL 影子」。
 * 这样进度条 / ETA / 切割长度对所有机器口径一致，且估算器一行未改。
 */
export function skmToHpglShadow(text) {
  if (!text) return '';
  let s = text.replace(/^;:H A L0 EC1 U /, '');
  s = s.replace(/U F-?\d+ @ /g, ' ');   // 结束标记不产生位移
  const out = [];
  const pushPairs = (cmd, body) => {
    const nums = body.split(',').filter((v) => v !== '');
    for (let i = 0; i + 1 < nums.length; i += 2) {
      out.push(`${cmd}${nums[i]},${nums[i + 1]};`);
    }
  };
  for (const tok of s.split(' ')) {
    if (!tok) continue;
    const head = tok[0];
    if (head === 'U' || head === 'D') {
      const body = tok.slice(1);
      if (/^-?\d/.test(body)) pushPairs(head === 'U' ? 'PU' : 'PD', body);
    } else if (head === ',') {
      pushPairs('PD', tok.slice(1));
    }
    // 'F123' / '@' / 孤立 'U' 等非位移 token 直接略过
  }
  return out.join('\n') + '\n';
}

/**
 * DMPL 方言：把 HPGL 指令翻译成 DMPL 语法。
 * （从 hpgl.js 迁到协议层，函数体保持原样；hpgl.js 会 re-export 以兼容旧 import）
 */
export function hpglToDmpl(hpglText) {
  // DMPL: A=绝对, R=相对, D=落刀, U=抬刀, V=速度, S=选笔, Z=复位
  const map = {
    'IN;': ';:A;',
    'PA;': 'A;',
    'PA': 'A',
    'PR': 'R',
    'PD;': 'D;',
    'PU;': 'U;',
    'SP1;': 'S1;',
    'SP0;': 'S0;',
    'LT;': 'T0;',
    'PA0,0;': 'U0,0;',
    'PU0,0;': 'U0,0;',
  };
  const out = [];
  for (let line of hpglText.split('\n')) {
    line = line.trim();
    if (!line) continue;
    if (map[line]) { out.push(map[line]); continue; }
    let m;
    if ((m = line.match(/^PA((?:-?\d+,-?\d+,?)+);$/))) { out.push(`A${m[1].replace(/,$/, '')};`); continue; }
    if ((m = line.match(/^PU((?:-?\d+,-?\d+,?)+);$/))) { out.push(`U;A${m[1].replace(/,$/, '')};`); continue; }
    if ((m = line.match(/^PD((?:-?\d+,-?\d+,?)+);$/))) { out.push(`D;A${m[1].replace(/,$/, '')};`); continue; }
    if ((m = line.match(/^PD;$/))) { out.push('D;'); continue; }
    if ((m = line.match(/^PU;$/))) { out.push('U;'); continue; }
    if ((m = line.match(/^VS(\d+);$/))) { out.push(`V${m[1]};`); continue; }
    if ((m = line.match(/^AA(-?\d+),(-?\d+),(-?\d+),(-?\d+);$/))) { out.push(`A${m[1]},${m[2]};CA${m[3]},${m[4]};`); continue; }
    out.push(line);
  }
  return out.join('\n') + '\n';
}

export { SKM_INIT };
