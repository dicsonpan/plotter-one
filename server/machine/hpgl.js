/**
 * HPGL / DMPL 指令生成器 + 力宇刻字机预设。
 *
 * 力宇机器的三个关键事实（均已核对过厂商资料与实机调试记录）：
 *
 * 1. 分辨率是 0.0254mm/step，即 1000 步/英寸；而 HPGL 标准是 1016 单位/英寸。
 *    两者差 1.6%。直接发标准 HPGL 会让整幅图偏 1.6%——SC801E（800mm 幅面）
 *    末端偏 12.8mm，已经超出版心。
 *    解法：用 SC 指令把「用户单位（mm）」映射到「绘图仪单位」，把换算完全交给
 *    机器端，而不是自己在上位机乘系数。这样任何分辨率的机器都准。
 *
 * 2. 力宇兼容 HP-GL 与 DM-PL 两种。文泰驱动里的力宇初始化是私有的
 *    `LIYUEGRAVING;ESC;IN@`（2D）/ `LIYUEGRAVING;ESC;IN#`（3D）。
 *    纯 HPGL 模式下用 `IN;` 即可，实测通用。私有头只在需要锁定厂商行为时启用。
 *
 * 3. 力宇是 2D 刻字机：XY 两轴 + 刀压升降。没有 Z，所以不需要 G-code 的
 *    抬刀高度、也没有 Z 轴补偿。整条链路是「轮廓切割」，不是「区域铣削」。
 *
 * 指令速查（刻字机实际会用到的子集）：
 *   IN        初始化
 *   SP1       选刀（刻字机只有一把刀，SP1 即可；SP0 收起）
 *   VS v      速度 v cm/s
 *   PU x,y;   抬刀移动（空行程）
 *   PD x,y;   落刀移动（切割）
 *   PA x,y;   绝对坐标
 *   PR        相对坐标
 *   AA cx,cy,a1,a2  绝对圆弧（圆心绝对坐标，逆时针角度）
 *   CI r      以当前位置为起点画半径 r 的圆
 *   LT;       连续实线
 *   PW w;     笔宽（刻字机多为忽略）
 *   SC xmin,xmax,ymin,ymax;  定义用户单位范围
 *   !PG       力宇私有：归位到原点
 *   LB text;  标签输出（本服务一般不用，文本在上位机转路径更可控）
 */

import { DEG, normAngle, currentPoint } from '../geom/path.js';

// ---------------------------------------------------------------------------
// 机器预设
// ---------------------------------------------------------------------------

/**
 * stepsPerInch 是机器的物理分辨率，决定 HPGL 坐标到毫米的换算。
 * 力宇 SC 系列标注「分辨率 0.0254mm/step」即 1000 步/英寸。
 */
export const MACHINE_PRESETS = {
  /**
   * SC631-AU —— 用户实际使用的机型。
   *
   * 刻绘宽度在厂商资料里有三个说法：600mm（ly-store 海外规格表）、615mm（佰信泓）、
   * 630mm（部分经销商与 SC631E 的标称）。这里取最保守的 600mm：
   * 幅面放得小只是图形排版受限，放大了是刀走出材料、撞机甚至断刀。
   * 宁可少刻 30mm，也不要为多刻 30mm 冒风险。
   *
   * 确认方法：看机器机身铭牌，或问供应商「最大刻绘宽度」，
   * 若确实是 630mm 可切到 liyue-sc631e 预设。
   */
  'liyue-sc631-au': {
    id: 'liyue-sc631-au',
    name: '力宇 SC631-AU（按 600mm 保守设定）',
    width: 600, height: 710,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    // 实测：这台机器的原点在**右侧**（用户 2026-10-04 上机验证）。
    // 所以用户坐标 +X 对应物理向左，必须发 SC 时让 Xmin > Xmax（HP-GL 镜像）。
    // 这是从「图形一直往左走直到撞机」反推出来的——原先假设 P1 在左下角是错的。
    axisX: -1,
    axisY: 1,
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 10, max: 500, default: 250, unit: 'g' },
    note: 'AU 版海外规格表标称刻绘 600mm / 进纸 710mm。'
        + '本机实测原点在右侧，故 X 轴反向。',
  },
  'liyue-sc631e': {
    id: 'liyue-sc631e',
    name: '力宇 SC631E / SC631-AU（630mm）',
    width: 630, height: 710,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 630mm，进纸宽度 710mm。仅在确认机身标称 630mm 时使用。',
  },
  'liyue-sc630': {
    id: 'liyue-sc630',
    name: '力宇 SC630 / SC631E',
    width: 630, height: 710,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 630mm，进纸宽度 710mm',
  },
  'liyue-sc801': {
    id: 'liyue-sc801',
    name: '力宇 SC801 / SC801E',
    width: 800, height: 880,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 800mm，进纸宽度 880mm',
  },
  'liyue-sc1261': {
    id: 'liyue-sc1261',
    name: '力宇 SC1261 / SC1261E',
    width: 1260, height: 1340,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 1260mm，进纸宽度 1340mm',
  },
  'generic-hpgl-1016': {
    id: 'generic-hpgl-1016',
    name: '通用 HPGL 刻字机（1016 单位/英寸）',
    width: 630, height: 710,
    stepsPerInch: 1016,
    dialect: 'hpgl',
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '标准 HPGL 分辨率，进口机与部分国产板卡',
  },
  'liyue-4axis': {
    id: 'liyue-4axis',
    name: '力宇四轴 / 伺服刻字机（3D）',
    width: 800, height: 880,
    stepsPerInch: 4060,
    dialect: 'hpgl3d',
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: true },
    maxSpeed: 980, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 300, unit: 'g' },
    note: '4060 线/英寸，2D 抬落刀指令 PU/PD 带 Z 分量，支持力度指令',
  },
  'generic-dmpl': {
    id: 'generic-dmpl',
    name: '通用 DMPL 割字机（国产 DMPL 板）',
    width: 630, height: 710,
    stepsPerInch: 1016,
    dialect: 'dmpl',
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '金谷田 / 赛博等国产通用 DMPL 语言刻字机',
  },
};

export const MATERIAL_PRESETS = [
  { id: 'ivory-board', name: '象牙卡纸', speed: 30, force: 180, note: '1.0mm PVC 雪弗板，常规招牌底板' },
  { id: 'pvc-foam-3', name: '3mm PVC 发泡板', speed: 20, force: 350, note: '需分两次刻，先粗后精' },
  { id: 'acrylic-3', name: '3mm 亚克力', speed: 12, force: 420, note: '易崩边，走慢刀压大' },
  { id: 'vinyl-sticker', name: '不干胶 / 刻字膜', speed: 45, force: 120, note: '一刀过，速度可快' },
  { id: 'gold-foil', name: 'KT 板 + 烫金膜', speed: 35, force: 200, note: '注意不压断膜' },
  { id: 'paper-thin', name: '薄纸 / 标签', speed: 60, force: 90, note: '低刀压，避免划伤' },
];

// ---------------------------------------------------------------------------
// HPGL 生成器
// ---------------------------------------------------------------------------

/** 毫米 → 绘图仪单位的量化。HPGL 坐标为整数，超范围 ±230（1016/inch 时） */
function toPlotterUnits(mm, stepsPerInch) {
  return Math.round(mm * (stepsPerInch / 25.4));
}

/**
 * 指令生成器。用法：new HpglBuilder(preset).build(path, options)
 * 保留 line/arc/ellipse 图元，真圆弧直接下发 AA，不离散成折线。
 */
export class HpglBuilder {
  constructor(preset, options = {}) {
    this.preset = preset;
    this.spi = preset.stepsPerInch;
    this.originMode = options.originMode || 'user'; // 'user' = 按材料坐标
    // 轴向：+1 常规, -1 反向。由 preset 提供默认值，用户可在界面覆盖。
    // 不可假定——P1 在哪个角由机器硬件决定，见 setupCoords 的说明。
    this.axisX = options.axisX !== undefined ? options.axisX
                 : (preset.axisX !== undefined ? preset.axisX : 1);
    this.axisY = options.axisY !== undefined ? options.axisY
                 : (preset.axisY !== undefined ? preset.axisY : 1);
    this.dialect = preset.dialect || 'hpgl';
    this.cmds = [];
    this.pos = { x: 0, y: 0 };
    this.penDown = false;
    this.bytes = 0;
  }

  emit(str) {
    this.cmds.push(str);
    this.bytes += str.length;
    return this;
  }

  /** 坐标系设置：把 mm 直接作为用户单位，机器端做换算 */
  /**
   * 设置坐标系。
   *
   * 🔴 SC 指令的语义（这是踩过坑的地方）：
   *   SC Xmin, Xmax, Ymin, Ymax
   * 里的 Xmin/Ymin 映射到**物理点 P1**，Xmax/Ymax 映射到**物理点 P2**。
   * P1 在机器的哪个角，是由硬件与面板设置决定的，**不是我们能假定的**。
   *
   * 早期版本直接发 SC0,W,0,H，等于假定「P1 在左下角」。
   * 用户实测这台 SC631-AU 的原点在**右边**，于是用户坐标 0 对应物理右侧，
   * X 增大的方向朝左——图形越画越往左，直到撞机。
   *
   * HP-GL 规范允许 Xmin > Xmax，语义就是「X 轴反向」（镜像）。
   * 所以正确做法是把轴向做成可配置项，由用户在界面上按实际机器选，
   * 而不是在这里替用户猜死。
   *
   * axisX: +1 用户坐标 +X 对应物理向右（常规）, -1 反向
   * axisY: +1 用户坐标 +Y 对应物理向上（常规）, -1 反向
   */
  setupCoords(origin) {
    const w = this.preset.width;
    const h = this.preset.height;
    this.emit('IN;');
    if (this.dialect === 'dmpl') {
      this.emit(';:');
      this.emit('IN;');
    }
    this.emit('SP1;');

    if (this.originMode === 'user') {
      const ax = this.axisX >= 0 ? 1 : -1;
      const ay = this.axisY >= 0 ? 1 : -1;
      // 轴向为 -1 时交换 P1/P2 的位置，即 Xmin > Xmax（HP-GL 定义的镜像）
      const x0 = toPlotterUnits(origin.x, this.spi);
      const y0 = toPlotterUnits(origin.y, this.spi);
      const x1 = toPlotterUnits(origin.x + w, this.spi);
      const y1 = toPlotterUnits(origin.y + h, this.spi);
      this.emit(`SC${ax > 0 ? x0 : x1},${ax > 0 ? x1 : x0},${ay > 0 ? y0 : y1},${ay > 0 ? y1 : y0};`);
    } else {
      const ax = this.axisX >= 0 ? 1 : -1;
      const ay = this.axisY >= 0 ? 1 : -1;
      const xa = toPlotterUnits(ax > 0 ? 0 : w, this.spi);
      const xb = toPlotterUnits(ax > 0 ? w : 0, this.spi);
      const ya = toPlotterUnits(ay > 0 ? 0 : h, this.spi);
      const yb = toPlotterUnits(ay > 0 ? h : 0, this.spi);
      this.emit(`SC${xa},${xb},${ya},${yb};`);
    }
    this.emit('LT;');
    return this;
  }

  setSpeed(mmPerSec) {
    // VS 用 cm/s
    const cmps = Math.max(1, Math.round(mmPerSec / 10));
    this.emit(`VS${cmps};`);
    return this;
  }

  setForce(gram) {
    // 力宇 3D 机型支持力度指令；2D 机器的刀压是面板旋钮，软件控制不了
    if (this.dialect === 'hpgl3d') this.emit(`FS${Math.round(gram)};`);
    return this;
  }

  /** 抬刀。已在抬刀状态时不重复发指令——9600 波特下每个字节都要花时间 */
  penUp() {
    if (this.penDown) { this.emit('PU;'); this.penDown = false; }
    return this;
  }

  penSelectOn() {
    this.penUp();
    // 初始化时已发过 SP1，不重复
    return this;
  }

  moveTo(x, y) {
    const px = toPlotterUnits(x, this.spi);
    const py = toPlotterUnits(y, this.spi);
    this.emit(`PA${px},${py};`);
    this.pos = { x: px, y: py };
    return this;
  }

  lineTo(x, y) {
    const px = toPlotterUnits(x, this.spi);
    const py = toPlotterUnits(y, this.spi);
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }
    this.emit(`PA${px},${py};`);
    this.pos = { x: px, y: py };
    return this;
  }

  /** 绝对圆弧：AA cx,cy,起始角,结束角（角度制，逆时针为正） */
  arcTo(cx, cy, r, a0, a1) {
    const cxq = toPlotterUnits(cx, this.spi);
    const cyq = toPlotterUnits(cy, this.spi);
    const rq = toPlotterUnits(r, this.spi);
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }
    // HPGL 角度为逆时针度数，且 Y 轴向上为正
    const d0 = Math.round(normAngle(a0) / DEG);
    let sweep = (a1 - a0) / DEG;
    // HPGL 圆弧只能逆时针；顺时针需转为「负角」
    if (sweep < 0) sweep = 360 + sweep;
    const d1 = Math.round(sweep);
    this.emit(`AA${cxq},${cyq},${d0},${d1};`);
    const endA = a0 + (d1 * DEG);
    this.pos = { x: cxq + rq * Math.cos(endA), y: cyq + rq * Math.sin(endA) };
    return this;
  }

  /**
   * 椭圆：降级为折线。
   *
   * HPGL 的 EA 指令中心量是「相对当前位置」，且不同厂商固件对 Y 轴正方向的
   * 处理不一致（有的是屏幕坐标向下，有的是数学坐标向上）——实测风险大于收益。
   * 椭圆在刻字机作业里本来就少见，离散后按 0.02mm 弦高走，肉眼与工件都无差别。
   * 整圆走 CI/AA 是原生的，不受影响。
   */
  ellipseTo(cx, cy, rx, ry, a0, a1) {
    const rMax = Math.max(rx, ry);
    let step;
    if (rMax <= 0.02) step = Math.PI;
    else step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.02 / rMax)));
    const abs = Math.abs(a1 - a0);
    const n = Math.max(8, Math.ceil(abs / step));
    for (let i = 1; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      this.lineTo(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    }
    return this;
  }

  circleAt(x, y, r) {
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }
    const rq = toPlotterUnits(r, this.spi);
    this.emit(`CI${rq};`);
    this.pos = { x: toPlotterUnits(x + r, this.spi), y: toPlotterUnits(y, this.spi) };
    return this;
  }

  /** 走完一条子路径 */
  runSubpath(sub, { closeAll = false } = {}) {
    this.penUp();
    this.moveTo(sub.start.x, sub.start.y);
    for (const e of sub.elems) {
      if (e.type === 'line') this.lineTo(e.x2, e.y2);
      else if (e.type === 'arc') this.arcTo(e.cx, e.cy, e.r, e.a0, e.a1);
      else if (e.type === 'ellipse') this.ellipseTo(e.cx, e.cy, e.rx, e.ry, e.a0, e.a1);
    }
    // 闭合子路径若最后一段没回到起点，补一条，否则图形缺边
    if (sub.closed || closeAll) {
      const end = currentPoint(sub);
      if (Math.hypot(end.x - sub.start.x, end.y - sub.start.y) > 1e-9) {
        this.lineTo(sub.start.x, sub.start.y);
      }
    }
    this.penUp();
    return this;
  }

  /** 回到原点。力宇私有指令 !PG，通用 HPGL 用 PU 移到原点 */
  /**
   * 回机械原点。
   *
   * 🔴 关键区分（踩过坑）：
   *   - `PU;PA0,0;` 只是**回到 P1 点**。SC 生效后 P1 在哪由映射决定，
   *     如果 X 轴反向，P1 在右侧，PA0,0 就跑到右端去了——**不是机械原点**。
   *   - `!PG;` 才是力宇的**机械归位**指令（文泰驱动文档里明确写「归位 !PG;」）。
   *
   * 刻完必须机械归位，否则下次开机的位置不对，材料会刻歪。
   * 所以这里统一用 !PG;，不管当前 SC 怎么设。
   */
  home() {
    this.penUp();
    if (this.dialect === 'dmpl' || this.dialect === 'dmpl3d') {
      // DM-PL 同样用 !PG
      this.emit('!PG;');
    } else {
      this.emit('!PG;');
    }
    return this;
  }

  end() {
    this.penUp();
    this.emit('SP0;');
    return this;
  }

  build(path, options = {}) {
    const origin = options.origin || { x: 0, y: 0 };
    this.setupCoords(origin);
    this.setSpeed(options.speedMmPerSec || 30);
    if (options.force) this.setForce(options.force);
    this.penSelectOn();

    for (const sub of path.subpaths) {
      this.runSubpath(sub, { closeAll: !!options.closeAll });
    }
    this.home();
    this.end();

    const text = this.cmds.join('\n') + '\n';
    return {
      text,
      bytes: text.length,
      commandCount: this.cmds.length,
      lines: this.cmds.length,
    };
  }
}

/** DMPL 方言：把 HPGL 指令翻译成 DMPL 语法 */
export function hpglToDmpl(hpglText) {
  // DMPL: A=绝对, R=相对, D=落刀, U=抬刀, V=速度, S=选笔, Z=复位
  const map = {
    'IN;': ';:A;',
    'PA': 'A',
    'PR': 'R',
    'PD;': 'D',
    'PU;': 'U',
    'SP1;': 'S1;',
    'SP0;': 'S0;',
    'LT;': 'T0;',
    'PA0,0;': 'U0,0;',
  };
  const out = [];
  for (let line of hpglText.split('\n')) {
    line = line.trim();
    if (!line) continue;
    if (map[line]) { out.push(map[line]); continue; }
    let m;
    if ((m = line.match(/^PA(-?\d+),(-?\d+);$/))) { out.push(`A${m[1]},${m[2]};`); continue; }
    if ((m = line.match(/^PD;$/))) { out.push('D;'); continue; }
    if ((m = line.match(/^PU;$/))) { out.push('U;'); continue; }
    if ((m = line.match(/^VS(\d+);$/))) { out.push(`V${m[1]};`); continue; }
    if ((m = line.match(/^AA(-?\d+),(-?\d+),(-?\d+),(-?\d+);$/))) { out.push(`A${m[1]},${m[2]};CA${m[3]},${m[4]};`); continue; }
    out.push(line);
  }
  return out.join('\n') + '\n';
}

/** 生成 HPGL 文本（按方言分发） */
export function compileToPlotterLanguage(path, preset, options = {}) {
  const builder = new HpglBuilder(preset, options);
  const res = builder.build(path, options);
  if (preset.dialect === 'dmpl') {
    const t = hpglToDmpl(res.text);
    return { text: t, bytes: t.length, commandCount: res.commandCount, lines: res.lines };
  }
  return res;
}
