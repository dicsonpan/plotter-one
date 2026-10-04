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
 * 🔴🔴 坐标轴方向：最容易造成「撞机 / 飞车」的地方，务必读完再改
 *
 *   曾经踩过：为了镜像 X 轴，代码发 `SC23622,0,...`（Xmin > Xmax）。
 *   HP-GL 规范确实允许 Xmin>Xmax 表示镜像，**但力宇固件不支持**——
 *   它照样按 Xmax-Xmin 算每单位步数，分母为负 → 整机得到一个**负缩放系数**。
 *   后果不是「图形镜像」，而是回原点时 Y 轴疯狂转动、X 轴朝反方向狂奔。
 *   那是负缩放导致的失控，不是方向填错。
 *
 *   正确做法（现在的代码）：
 *     1. `SC` **永远正序**（Xmin < Xmax、Ymin < Ymax），不给固件任何歧义；
 *     2. 方向差异全部在**上位机**做——用户坐标(mm) → 机器坐标(mm) 的仿射变换，
 *        见 `toMachine()` / `toMachineDelta()`；
 *     3. 圆弧在反射变换下绕向会反转，`arcTo()` 用「顺时针 s 段 ≡ 逆时针 (360-s) 段」
 *        换算，保证 AA 仍然只发逆时针。
 *
 *   这样固件看到的永远是「正序 SC + 正常坐标」，方向对错只影响我们发什么数字，
 *   不会让机器进入失控状态。方向仍然可配置——它决定「发什么」，
 *   但不再决定「怎么跟机器说话」。
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
    // 实测（2026-10-04，用户上机确认）：这台机器的机械原点在**用户的右手边**。
    //
    // 「正对机器时右手边」= 站在机器前看，原点在右侧。
    // 也就是说**刀头（龙门）**前进的方向是向左，与画布的 X 方向相反。
    //
    // 🔴 镜像只在**上位机**做（toMachine 里 x → span - x），
    //    绝不能靠发 SC23622,0,... 让固件自己镜像——固件不支持，
    //    会算出负缩放系数，回原点时 Y 轴飞转、X 轴狂奔。
    //    这里的 axisX/axisY 只影响「发什么坐标」，不影响「怎么跟机器说话」。
    // ⚠️ 交换轴之后 axisX/axisY 的物理含义变了，不能沿用交换前的取值。
    //
    // 交换前：机器X = 刀头（龙门），所以「原点在右手边」→ axisX = -1。
    // 交换后：机器Y = 刀头，机器X = 走纸。同一个物理事实
    // （刀头归位在右手边）现在要落在**机器Y** 上 → axisY = -1。
    // 把 -1 留在 axisX 上会让走纸方向反掉、刀头方向仍然错。
    //
    // 走纸轴（机器X）的方向无法从「原点在右手边」推出来（那是刀头的性质），
    // 先按正向设，由校准向导的第二步确认。
    axisX: 1,
    axisY: -1,
    // 实机确认（2026-10-04）：这台机器的**物理 X/Y 与用户坐标是接反的**——
    // 推动刀头（龙门）的那个电机，固件里编号是 Y；走纸的那个是 X。
    //
    // 「接反」和「方向相反」是两件事，可以同时成立。
    // 交换后机器 X 实际走 710mm（走纸方向），所以 SC 上界按 710 声明，
    // 由 machineSpanX 处理，不要写死 preset.width。
    swapAxes: true,
    serialDefault: { baud: 9600, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 10, max: 500, default: 250, unit: 'g' },
    note: 'AU 版海外规格表标称刻绘 600mm / 进纸 710mm。'
        + '本机实测：机械原点在用户右手边（刀头轴 = 机器Y，故 axisY=-1）、'
        + '且物理 X/Y 接反（故交换轴）。走纸轴方向待校准确认。',
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
    // 不可假定——原点位置与轴向是机器硬件属性，见文件头与 toMachine 的说明。
    this.axisX = options.axisX !== undefined ? options.axisX
                 : (preset.axisX !== undefined ? preset.axisX : 1);
    this.axisY = options.axisY !== undefined ? options.axisY
                 : (preset.axisY !== undefined ? preset.axisY : 1);
    // 轴交换：这台机器的物理 X/Y 与用户坐标 X/Y 是接反的（2026-10-04 实机确认）。
    // 与 axisX/axisY 正交——「接反」和「方向相反」是两件事，可以叠加。
    this.swapAxes = options.swapAxes !== undefined ? !!options.swapAxes
                    : !!preset.swapAxes;
    this.dialect = preset.dialect || 'hpgl';
    this.cmds = [];
    this.pos = { x: 0, y: 0 };
    this.penDown = false;
    this.bytes = 0;
  }

  // -------------------------------------------------------------------------
  // 坐标变换：用户坐标(mm) → 机器坐标(mm)
  // -------------------------------------------------------------------------
  /**
   * 机器坐标系在**各轴上的物理跨度**。
   *
   * 🔴 轴交换时必须换过来：交换前机器 X 走 600mm（幅面宽），
   * 交换后机器 X 实际走的是用户的 Y，也就是 710mm（进纸方向）。
   * SC 的上界按这个值算，写错会导致机器按错误的比例换算坐标。
   */
  get machineSpanX() { return this.swapAxes ? this.preset.height : this.preset.width; }
  get machineSpanY() { return this.swapAxes ? this.preset.width : this.preset.height; }

  /**
   * 绝对坐标变换。
   *
   * 用户坐标约定：原点在材料**左下角**，X 向右，Y 向上（与画布一致）。
   * 机器坐标由 SC 正序定义，机器固件只认「x 增大 = 机器 x 增大」。
   *
   * 三步，顺序不能换：
   *   1. swapAxes：先换轴。用户 (x,y) → 机器 (y,x)。
   *      换轴只是重新分配「哪根轴」，不涉及方向，所以放在最前面。
   *   2. axisX/axisY：再按各轴方向做镜像（宽度按**该轴自己的跨度**取，
   *      交换后 X 轴要减去的是 710 而不是 600——这是容易写错的地方）。
   *
   * 关键点：**SC 始终正序**。固件永远只看到一个正常的坐标系，
   * 方向填错的后果仅限于「图形镜像」，而不会像反向 SC 那样
   * 让固件算出负缩放、进而回原点时飞车。
   */
  toMachine(x, y) {
    let mx = x;
    let my = y;
    if (this.swapAxes) { const t = mx; mx = y; my = t; }
    const sx = this.machineSpanX;
    const sy = this.machineSpanY;
    return {
      x: this.axisX >= 0 ? mx : (sx - mx),
      y: this.axisY >= 0 ? my : (sy - my),
    };
  }

  /**
   * 相对位移变换。
   *
   * 与 toMachine 的区别：位移只有方向，没有位置，所以**不**做 span-x 偏移，
   * 只换轴 + 翻符号。手动方向键、PR 增量走刀都必须走这里——
   * 早先的手动 jog 误用了绝对 moveTo，在镜像机器上会变成「朝原点狂冲」。
   */
  toMachineDelta(dx, dy) {
    let mdx = dx;
    let mdy = dy;
    if (this.swapAxes) { const t = mdx; mdx = dy; mdy = t; }
    return {
      dx: this.axisX >= 0 ? mdx : -mdx,
      dy: this.axisY >= 0 ? mdy : -mdy,
    };
  }

  /**
   * 当前变换是否为反射（会翻转圆弧绕向）。
   *
   * 行列式：每次轴交换或单轴反向都是一次反射（det = -1）。
   * 偶数次反射 = 旋转（det = +1，绕向不变）；奇数次 = 反射（绕向翻转）。
   */
  get isReflection() {
    let n = 0;
    if (this.swapAxes) n++;
    if (this.axisX < 0) n++;
    if (this.axisY < 0) n++;
    return n % 2 === 1;
  }

  emit(str) {
    this.cmds.push(str);
    this.bytes += str.length;
    return this;
  }

  /**
   * 设置坐标系。
   *
   * 🔴 SC 的语义（这是踩过坑的地方）：
   *   SC Xmin, Xmax, Ymin, Ymax
   * 里的 Xmin/Ymin 映射到**物理点 P1**，Xmax/Ymax 映射到**物理点 P2**。
   * P1 在机器的哪个角，是由硬件与面板设置决定的，**不是我们能假定的**。
   *
   * HP-GL 规范允许 Xmin > Xmax 来表达「X 轴镜像」，但**力宇固件不支持**：
   * 它仍按 Xmax-Xmin 计算每单位步数，负分母直接产生负缩放系数。
   * 实测症状：回原点时 Y 轴疯狂转动、X 轴朝反方向狂奔（2026-10-04）。
   *
   * 所以这里**永远发正序 SC**，方向差异交给 toMachine() 在上位机处理。
   * 这样即便方向设错，最坏也只是图形镜像，不会让机器失控撞机。
   */
  setupCoords(origin) {
    // 🔴 交换轴时用 machineSpanX/Y（已互换），不能用 preset.width/height，
    // 否则 SC 上界按错误的跨度声明，机器换算坐标会整体缩放。
    const w = this.machineSpanX;
    const h = this.machineSpanY;
    this.emit('IN;');
    if (this.dialect === 'dmpl') {
      this.emit(';:');
      this.emit('IN;');
    }
    this.emit('SP1;');

    // 正序：Xmin < Xmax、Ymin < Ymax。任何情况下都不反转。
    const x0 = toPlotterUnits(origin.x, this.spi);
    const y0 = toPlotterUnits(origin.y, this.spi);
    const x1 = toPlotterUnits(origin.x + w, this.spi);
    const y1 = toPlotterUnits(origin.y + h, this.spi);
    this.emit(`SC${Math.min(x0, x1)},${Math.max(x0, x1)},${Math.min(y0, y1)},${Math.max(y0, y1)};`);
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
    const p = this.toMachine(x, y);
    const px = toPlotterUnits(p.x, this.spi);
    const py = toPlotterUnits(p.y, this.spi);
    this.emit(`PA${px},${py};`);
    this.pos = { x: px, y: py };
    return this;
  }

  lineTo(x, y) {
    const p = this.toMachine(x, y);
    const px = toPlotterUnits(p.x, this.spi);
    const py = toPlotterUnits(p.y, this.spi);
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }
    this.emit(`PA${px},${py};`);
    this.pos = { x: px, y: py };
    return this;
  }

  /**
   * 绝对圆弧：AA cx,cy,起始角,扫掠角（角度制，只能逆时针）
   *
   * 🔴 反射变换（镜像 / 换轴）有两个坑，都必须处理：
   *
   *   1. **绕向翻转**：X 镜像 x→w-x 与轴交换 x,y→y,x 都是反射（det = -1），
   *      会把用户坐标里逆时针的弧变成机器坐标里顺时针的弧。
   *      而 HP-GL 的 AA 只能逆时针。
   *      换算：顺时针 s 段 ≡ 逆时针 (360-s) 段，落点与圆弧完全一致。
   *      反射次数为偶数（如换轴 + 单轴反向 = 旋转 180°）时绕向不变。
   *
   *   2. **起始角也要镜像**：起点角 a0 在反射后不再是 a0。
   *      （X 镜像：a0 → 180-a0；Y 镜像：a0 → -a0）
   *      起点角发错，固件会从当前位置直线拉到「算出来的圆弧起点」——
   *      也就是凭空多刻一条不在设计里的线。
   *
   * 起点角不手算，直接由**当前实际位置**与映射后的圆心反解：
   * 当前点必然是 runSubpath 走出来的、已经映射过的真实位置，
   * 这样起点角与实际位置永远自洽，不依赖任何角度变换公式。
   */
  arcTo(cx, cy, r, a0, a1) {
    const c = this.toMachine(cx, cy);
    const cxq = toPlotterUnits(c.x, this.spi);
    const cyq = toPlotterUnits(c.y, this.spi);
    const rq = toPlotterUnits(r, this.spi);
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }

    // 起点角由当前点反解（atan2 结果规范化到 0-360）
    let d0 = Math.round(Math.atan2(this.pos.y - cyq, this.pos.x - cxq) / DEG) % 360;
    if (d0 < 0) d0 += 360;

    // 扫掠角：反射则取反，再统一成「逆时针为正」。
    // isReflection 已把 swapAxes 计入（交换轴也是一次反射，det = -1）。
    let sweep = (a1 - a0) / DEG;
    if (this.isReflection) sweep = -sweep;
    if (Math.abs(sweep) >= 360 - 1e-9) {
      sweep = 360;              // 整圆：不能被换算成 0（那会退化成零长度弧）
    } else if (sweep < 0) {
      sweep += 360;
    }
    const d1 = Math.round(sweep);
    this.emit(`AA${cxq},${cyq},${d0},${d1};`);

    // 终点按实际下发的扫掠角推算（绕向换算过，与原始 a1 可能不同）
    const endA = d0 * DEG + d1 * DEG;
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

  /**
   * 整圆：CI 以**当前位置**为起点画圆，所以必须先把笔移到映射后的圆心位置。
   *
   * 圆是镜像不变的（反射后仍是同一个圆），所以半径不用改，
   * 但圆心坐标要经过 toMachine——否则镜像机器上整圆会跑到材料另一头。
   */
  circleAt(x, y, r) {
    const c = this.toMachine(x, y);
    this.moveTo(c.x, c.y);
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }
    const rq = toPlotterUnits(r, this.spi);
    this.emit(`CI${rq};`);
    // CI 结束在圆心正右方（机器坐标），记录真实终点供后续闭合判断
    this.pos = { x: toPlotterUnits(c.x + r, this.spi), y: toPlotterUnits(c.y, this.spi) };
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
   *
   * `!PG` 是机器的**物理**动作，不经过任何坐标换算，
   * 因此它对轴向设置免疫——这也是方向填错时它仍然安全的原因。
   */
  home() {
    this.penUp();
    // DMPL 与 HPGL 都用 !PG；力宇的归位不依赖 SC
    this.emit('!PG;');
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
