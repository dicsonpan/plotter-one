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
 * 🔴🔴 版面旋转（layoutRotate）：与「轴方向」是两件完全不同的事，别再混着调
 *
 *   2026-10-05 实机确认：把「SparkMinds」横排在画布上，刻出来整版**逆时针歪了 90°**，
 *   方向本身是对的（没有镜像），只是整块版面转错了向。
 *
 *   原因：机器的两个物理轴与画布的两个轴是**转置**关系，且其中一个还反向，
 *   合起来净效果是一次 90° 旋转（行列式 = +1，所以看着只是转、没有镜像）。
 *
 *   这跟 `swapAxes`（转置，行列式 = -1，是**镜像**）是两回事：
 *     - swapAxes = true  → 图形会左右/上下颠倒（镜像，能一眼看出不对）
 *     - layoutRotate = 90 → 图形只是转了 90°（旋转，方向全对，只是躺倒了）
 *   历史上把这两件事当成一件调，是本项目反复踩坑的根源。
 *
 *   所以方向一旦在实机确认过，就**不要再动 axisX/axisY/swapAxes**——
 *   它们只负责「每根轴往哪边是正」，版面朝向由 layoutRotate 独立负责。
 *   机器预设里写死实测值，界面不暴露这两个概念，避免再被误改。
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

import { DEG, normAngle, currentPoint, mapPathPoints } from '../geom/path.js';

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
    nameEn: 'Liyue SC631-AU (600mm conservative)',
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
    // 实测（2026-10-04 / 2026-10-05，用户上机确认）：
    // 力宇刻字机标准轴向：
    // - 机器 X 轴（HP-GL 第一参数）：刀头（龙门左右导轨，幅面宽度 600mm）
    // - 机器 Y 轴（HP-GL 第二参数）：走纸滚筒（材料进退，进纸方向 710mm）
    // 默认 X 轴向左进刀（向材料内部）、Y 轴向内进纸，均从用户对刀原点 (0,0) 开始正向递增。
    // 不开启 swapAxes，避免轴向混乱导致 Y 轴无响应、X 轴走反。
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    // 🔴 版面朝向：2026-10-05 实机确认，刻字时整版会**逆时针歪 90°**，
    // 方向本身正确（不镜像），纯粹是版面躺倒了。补偿值 = 顺时针 90°。
    //
    // 物理原因：机器的走纸轴（710mm）与刀头轴（600mm）在固件里是反的，
    // 而用户是站在机器正前方按「左右 / 里外」描述版面的——
    // 两个参考系差一次 90° 旋转，净效果就是整版转倒。
    //
    // ⚠️ 这个值与 axisX/axisY/swapAxes 无关，别用那三项来修版面朝向——
    // 那三项只管「每根轴往哪边是正」，动它们会把方向也搞坏。
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 10, max: 500, default: 250, unit: 'g' },
    note: 'AU 版海外规格表标称刻绘 600mm / 进纸 710mm。默认 X 轴为刀头（左右）、Y 轴为走纸滚筒（前后）。',
    noteEn: 'AU export spec lists 600mm plot width / 710mm feed. Default X = gantry (left-right), Y = media roller (in-out).',
  },
  'liyue-sc631e': {
    id: 'liyue-sc631e',
    name: '力宇 SC631E / SC631-AU（630mm）',
    nameEn: 'Liyue SC631E / SC631-AU (630mm)',
    width: 630, height: 710,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 630mm，进纸宽度 710mm。仅在确认机身标称 630mm 时使用。',
    noteEn: 'Max plot width 630mm, feed width 710mm. Use only after confirming the nameplate rating.',
  },
  'liyue-sc630': {
    id: 'liyue-sc630',
    name: '力宇 SC630 / SC631E',
    nameEn: 'Liyue SC630 / SC631E',
    width: 630, height: 710,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 630mm，进纸宽度 710mm',
    noteEn: 'Max plot width 630mm, feed width 710mm',
  },
  'liyue-sc801': {
    id: 'liyue-sc801',
    name: '力宇 SC801 / SC801E',
    nameEn: 'Liyue SC801 / SC801E',
    width: 800, height: 880,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 800mm，进纸宽度 880mm',
    noteEn: 'Max plot width 800mm, feed width 880mm',
  },
  'liyue-sc1261': {
    id: 'liyue-sc1261',
    name: '力宇 SC1261 / SC1261E',
    nameEn: 'Liyue SC1261 / SC1261E',
    width: 1260, height: 1340,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 1260mm，进纸宽度 1340mm',
    noteEn: 'Max plot width 1260mm, feed width 1340mm',
  },
  'generic-hpgl-1016': {
    id: 'generic-hpgl-1016',
    name: '通用 HPGL 刻字机（1016 单位/英寸）',
    nameEn: 'Generic HPGL engraver (1016 units/inch)',
    width: 630, height: 710,
    stepsPerInch: 1016,
    dialect: 'hpgl',
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '标准 HPGL 分辨率，进口机与部分国产板卡',
    noteEn: 'Standard HPGL resolution; imported machines and some domestic boards',
  },
  'liyue-4axis': {
    id: 'liyue-4axis',
    name: '力宇四轴 / 伺服刻字机（3D）',
    nameEn: 'Liyue 4-axis / servo engraver (3D)',
    width: 800, height: 880,
    stepsPerInch: 4060,
    dialect: 'hpgl3d',
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: true },
    maxSpeed: 980, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 300, unit: 'g' },
    note: '4060 线/英寸，2D 抬落刀指令 PU/PD 带 Z 分量，支持力度指令',
    noteEn: '4060 lines/inch, PU/PD carry a Z component, supports force commands',
  },
  'generic-dmpl': {
    id: 'generic-dmpl',
    name: '通用 DMPL 割字机（国产 DMPL 板）',
    nameEn: 'Generic DMPL cutter (domestic DMPL boards)',
    width: 630, height: 710,
    stepsPerInch: 1016,
    dialect: 'dmpl',
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '金谷田 / 赛博等国产通用 DMPL 语言刻字机',
    noteEn: 'Domestic DMPL engravers such as JinguTian / Saibo',
  },
};

export const MATERIAL_PRESETS = [
  { id: 'ivory-board', name: '象牙卡纸', nameEn: 'Ivory board', speed: 30, force: 180, note: '1.0mm PVC 雪弗板，常规招牌底板', noteEn: '1.0mm PVC foam board, typical sign substrate' },
  { id: 'pvc-foam-3', name: '3mm PVC 发泡板', nameEn: '3mm PVC foam', speed: 20, force: 350, note: '需分两次刻，先粗后精', noteEn: 'Cut in two passes: rough then finish' },
  { id: 'acrylic-3', name: '3mm 亚克力', nameEn: '3mm acrylic', speed: 12, force: 420, note: '易崩边，走慢刀压大', noteEn: 'Chips easily — go slow with high force' },
  { id: 'vinyl-sticker', name: '不干胶 / 刻字膜', nameEn: 'Vinyl sticker / film', speed: 45, force: 120, note: '一刀过，速度可快', noteEn: 'Single pass, can run fast' },
  { id: 'gold-foil', name: 'KT 板 + 烫金膜', nameEn: 'KT board + gold foil', speed: 35, force: 200, note: '注意不压断膜', noteEn: 'Do not press hard enough to tear the foil' },
  { id: 'paper-thin', name: '薄纸 / 标签', nameEn: 'Thin paper / label', speed: 60, force: 90, note: '低刀压，避免划伤', noteEn: 'Low force to avoid scoring' },
];

// ---------------------------------------------------------------------------
// HPGL 生成器
// ---------------------------------------------------------------------------

/** 毫米 → 绘图仪单位的量化。HPGL 坐标为整数，超范围 ±230（1016/inch 时） */
function toPlotterUnits(mm, stepsPerInch) {
  return Math.round(mm * (stepsPerInch / 25.4));
}

/**
 * 把任意角度收敛到最近的 90° 倍数，返回 0/90/180/270。
 *
 * 为什么要归一化：版面旋转的推导（换轴后跨度怎么算）只在 90° 的整数倍上成立。
 * 传进来 37° 会让 machineSpan 与实际不符——**不崩不卡、图形照刻，
 * 只是整体位置偏掉**，属于最难发现的一类错误。所以在入口就锁死。
 *
 * ⚠️ 以前这里只做了 `Math.round(deg)`，文档写着「收敛到 90 的倍数」，
 * 实现却把 37° 原样放行——文档与实现不一致，比没写文档更糟。
 */
function normalizeRotate(deg) {
  const d = Math.round(Number(deg) || 0);
  const snapped = Math.round(d / 90) * 90;   // 收敛到最近的 90° 倍数
  return ((snapped % 360) + 360) % 360;
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
    // 版面整体朝向。与 swapAxes（镜像）正交：swapAxes 管「图形是否镜像」，
    // layoutRotate 管「整块版面转多少度」。见文件头的说明。
    // 只接受 0/90/180/270——任意角度会让 machineSpan 的推导失效。
    this.layoutRotate = normalizeRotate(
      options.layoutRotate !== undefined ? options.layoutRotate : preset.layoutRotate);
    this.dialect = preset.dialect || 'hpgl';
    this.cmds = [];
    this.pos = { x: 0, y: 0 };
    this.penDown = false;
    this.bytes = 0;
    this._coordBatch = [];
    this._flushing = false;
    // 连续坐标流合并：每条 PA 指令最多合并 30 对坐标（约 300~360 字节），
    // 既能消除数以万计重复的 PA 助记符与分号/换行符传输开销（提速 20%~30%），
    // 又完全适配 9600 串口小缓冲与固件接收能力。
    this.maxBatchPairs = options.maxBatchPairs !== undefined ? options.maxBatchPairs : 30;
  }

  // -------------------------------------------------------------------------
  // 坐标变换：用户坐标(mm) → 机器坐标(mm)
  // -------------------------------------------------------------------------
  /**
   * 机器坐标系在**各轴上的物理跨度**。
   *
   * 🔴 换轴有两个来源，必须一起算：
   *   1. `swapAxes`（轴接反，镜像）
   *   2. `layoutRotate` 为 90/270（版面转了 90°，X/Y 的角色对调）
   * 两者是异或关系——都发生时相互抵消，净效果等于没换。
   * 漏算任何一个都表现为「不崩不卡、图形照刻、整体位置或尺寸偏掉」，
   * 属于最难发现的一类错误，所以集中到 `axesSwapped` 一个 getter 里算。
   */
  get axesSwapped() {
    const rotSwaps = this.layoutRotate === 90 || this.layoutRotate === 270;
    return this.swapAxes !== rotSwaps;   // 异或
  }

  get machineSpanX() { return this.axesSwapped ? this.preset.height : this.preset.width; }
  get machineSpanY() { return this.axesSwapped ? this.preset.width : this.preset.height; }

  /**
   * 版面旋转：把设计稿摆正到机器的材料框里。
   *
   * 只在**绝对坐标**上做（含画布尺寸的偏移），
   * 相对位移走 `toMachineDelta()` 里的同名逻辑——两处必须成对改。
   *
   * @param {number} x,y 用户坐标（mm，Y 向上，原点在材料左下角）
   * @returns {{x,y}} 旋转后、仍在正象限内的坐标
   */
  rotateUser(x, y) {
    const W = this.preset.width, H = this.preset.height;
    switch (this.layoutRotate) {
      // 顺时针 90°：原左边变成新上边 → (x,y) → (y, W-x)，新框 H×W
      case 90:  return { x: y, y: W - x };
      case 180: return { x: W - x, y: H - y };
      // 顺时针 270°（= 逆时针 90°）：原右边变成新上边 → 新框 H×W
      case 270: return { x: H - y, y: x };
      default:  return { x, y };
    }
  }

  /**
   * 绝对坐标变换。
   *
   * 用户坐标约定：原点在材料**左下角**，X 向右，Y 向上（与画布一致）。
   * 机器坐标由 SC 正序定义，机器固件只认「x 增大 = 机器 x 增大」。
   *
   * 三步，顺序不能换：
   *   1. **layoutRotate**：把设计稿按机器的材料框朝向摆正。
   *      这是「版面层面的旋转」，与下面两步的性质不同——
   *      它决定工件落在材料上的朝向，不决定某根轴的正方向。
   *   2. swapAxes：换轴。用户 (x,y) → 机器 (y,x)。
   *      换轴只是重新分配「哪根轴」，不涉及方向，所以放在旋转之后。
   *   3. axisX/axisY：再按各轴方向做镜像（宽度按**该轴自己的跨度**取，
   *      换轴后 X 轴要减去的是 710 而不是 600——这是容易写错的地方）。
   *
   * 关键点：**SC 始终正序**。固件永远只看到一个正常的坐标系，
   * 方向填错的后果仅限于「图形镜像」，而不会像反向 SC 那样
   * 让固件算出负缩放、进而回原点时飞车。
   */
  toMachine(x, y) {
    const r = this.rotateUser(x, y);
    let mx = r.x;
    let my = r.y;
    if (this.swapAxes) { const t = mx; mx = my; my = t; }
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
   * 与 toMachine 的区别：位移只有方向，没有位置，所以**不**做
   * 「绕画布尺寸翻转」那部分偏移，只做旋转的线性部分 + 换轴 + 翻符号。
   * 手动方向键、PR 增量走刀都必须走这里——
   * 早先的手动 jog 误用了绝对 moveTo，在镜像机器上会变成「朝原点狂冲」。
   *
   * ⚠️ 版面旋转**必须**在这里体现：方向键的语义是「画布上往右」，
   * 而画布上的右在旋转后的机器坐标里是另一个方向。
   * 漏掉这一步的表现是「图形转对了、方向键却还是老方向」——
   * 机器动起来是安全的，但手动定位会与图形对不上，很难立刻联想到是旋转漏了。
   */
  toMachineDelta(dx, dy) {
    let mdx = dx, mdy = dy;
    switch (this.layoutRotate) {
      case 90:  { const t = mdx; mdx = dy;  mdy = -t; break; }
      case 180: { mdx = -mdx; mdy = -mdy; break; }
      case 270: { const t = mdx; mdx = -dy; mdy = t;  break; }
      default: break;
    }
    if (this.swapAxes) { const t = mdx; mdx = mdy; mdy = t; }
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
   *
   * 🔴 `layoutRotate` 不参与判定：90/180/270 都是纯旋转（det = +1），
   * 绕向不变。把它算进去会让所有圆弧的扫掠角被取反，
   * 表现为「圆和直线都对、唯独圆弧刻反了方向」。
   */
  get isReflection() {
    let n = 0;
    if (this.swapAxes) n++;
    if (this.axisX < 0) n++;
    if (this.axisY < 0) n++;
    return n % 2 === 1;
  }

  emit(str) {
    if (this._flushing) {
      this.cmds.push(str);
      this.bytes += str.length;
      return this;
    }
    this._flushCoords();
    this.cmds.push(str);
    this.bytes += str.length;
    return this;
  }

  /**
   * 将缓存中的连续坐标合并为单条 PA 指令下发。
   *
   * 提速核心：在 9600 串口物理带宽下，每对坐标原先独立占一行（`PA x,y;\n`），
   * 重复的 `PA` 与分号换行带来约 30% 的协议字符冗余。
   * 合并为 `PA x1,y1,x2,y2...;` 后，体积下降 20%~30%，行数减少 90%+，
   * 既大幅降低串口传输耗时，又让下位机固件在单条 PA 内部平滑运动规划。
   */
  _flushCoords() {
    if (this._coordBatch && this._coordBatch.length > 0) {
      const coords = this._coordBatch.join(',');
      this._coordBatch = [];
      this._flushing = true;
      this.emit(`PA${coords};`);
      this._flushing = false;
    }
    return this;
  }

  /**
   * `toMachine` 的逆变换：机器坐标 → 用户（设计）坐标。
   *
   * 存在的唯一理由是**预览**：`/api/preview` 把生成的 HPGL 读回来得到的是
   * 机器坐标，若直接画到画布上，版面旋转 90° 时预览会**横着躺**，
   * 与设计稿对不上——用户看到的预览就不再是「所见即所刻」。
   *
   * 逆变换必须严格按 toMachine 的**逆序**逐步反演：
   *   1. 先反 axisX/axisY 镜像（用各轴自己的跨度）
   *   2. 再反 swapAxes
   *   3. 最后反 layoutRotate
   * 顺序反了就会在旋转 + 镜像同时存在时算出错误坐标，且不报错。
   */
  toUser(mx, my) {
    const sx = this.machineSpanX;
    const sy = this.machineSpanY;
    let ux = this.axisX >= 0 ? mx : (sx - mx);
    let uy = this.axisY >= 0 ? my : (sy - my);
    if (this.swapAxes) { const t = ux; ux = uy; uy = t; }
    // 反解 rotateUser：正向 (x,y)→(y,W-x) 的逆就是 (x,y)→(W-y,x)
    const W = this.preset.width, H = this.preset.height;
    switch (this.layoutRotate) {
      case 90:  return { x: W - uy, y: ux };
      case 180: return { x: W - ux, y: H - uy };
      case 270: return { x: uy, y: H - ux };
      default:  return { x: ux, y: uy };
    }
  }

  /**
   * 初始化机器与设定状态。
   *
   * 🔴 严禁在卷筒刻字机上发送 SC 指令：
   *   HP-GL 的 SC Xmin,Xmax,Ymin,Ymax 指令依赖物理缩放点 P1 与 P2：
   *     Scale_Y = (P2y - P1y) / (Ymax - Ymin)
   *   刻字机采用滚筒进纸（卷材），Y 轴为连续进纸滚筒，硬件根本没有固定的 Y 轴物理上限（P2y = 0 或未初始化）。
   *   一旦下发 SC，固件算出的 Y 轴缩放比例直接被归零（Scale_Y = 0），
   *   导致后续所有 Y 轴运动指令在固件内部全部乘以 0，表现为「Y 轴彻底失去响应」；
   *   同时 X 轴因错误的缩放基准导致失控狂奔。
   *
   *   上位机在 moveTo() / lineTo() / arcTo() 中已经通过 toPlotterUnits()
   *   把毫米精确按机器脉冲分辨率（如 1000 步/英寸）量化成了整数步进，
   *   因此直发原生绘图仪步进即可，完全不需要也绝不能下发 SC。
   */
  setupCoords(origin) {
    this.emit('IN;');
    if (this.dialect === 'dmpl') {
      this.emit(';:');
      this.emit('IN;');
    }
    this.emit('SP1;');
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
    this._flushCoords();
    if (this.penDown) { this.emit('PU;'); this.penDown = false; }
    return this;
  }

  /**
   * 无条件抬刀：不管软件以为刀是抬着还是落着，都发一条 `PU;`。
   *
   * `penUp()` 是给生成任务用的省字节优化（9600 波特下每个字节都要花时间），
   * 但**手动「抬刀」按钮不能用它**：
   *   软件对刀状态的认知来自「我这次任务有没有下发过 PD」，
   *   而机器的真实状态可能与它不一致——比如上一次任务中途被停止、
   *   串口断线重连、或者换了控制板。
   *   这时按「抬刀」却因为「我认为刀本来就是抬着的」而不发任何指令，
   *   结果就是**按钮点了没反应**，而且刀还压着材料。
   *
   * 抬刀是安全操作，多发一个字节的成本可以忽略；不发指令的风险不行。
   */
  forcePenUp() {
    this._flushCoords();
    this.emit('PU;');
    this.penDown = false;
    return this;
  }

  penSelectOn() {
    this.penUp();
    // 初始化时已发过 SP1，不重复
    return this;
  }

  moveTo(x, y) {
    this._flushCoords();
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
    if (!this.penDown) {
      this.emit('PD;');
      this.penDown = true;
    }
    // 连续落刀切割坐标流合并：将连续的点缓存在当前批次中
    this._coordBatch.push(px, py);
    this.pos = { x: px, y: py };
    if (this.maxBatchPairs > 0 && this._coordBatch.length >= this.maxBatchPairs * 2) {
      this._flushCoords();
    }
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
    this._flushCoords();
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
   *
   * 🔴 这里**不能**调 `moveTo(toMachine(x,y))`：moveTo 内部会再变换一次，
   * 等于把用户坐标变换了两遍。原点附近两次变换的结果相同，看不出问题；
   * 但版面旋转 90° 时两次变换会把它推到材料另一头去。
   * 所以直接发已经映射好的机器坐标。
   */
  circleAt(x, y, r) {
    const c = this.toMachine(x, y);
    this.penUp();
    this.emit(`PA${toPlotterUnits(c.x, this.spi)},${toPlotterUnits(c.y, this.spi)};`);
    this.pos = { x: toPlotterUnits(c.x, this.spi), y: toPlotterUnits(c.y, this.spi) };
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }
    const rq = toPlotterUnits(r, this.spi);
    this.emit(`CI${rq};`);
    // CI 结束在圆心正右方（机器坐标），记录真实终点供后续闭合判断。
    // 镜像时圆心正右方会翻到左侧，所以偏移方向要跟着 axisX 走。
    const dir = this.axisX >= 0 ? 1 : -1;
    this.pos = { x: toPlotterUnits(c.x + r * dir, this.spi), y: toPlotterUnits(c.y, this.spi) };
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

  /**
   * 生成完整任务指令。
   *
   * 🔴 原点保护原则：
   *   刻字机通常由操作者在材料上手动定位刀尖后，按下机身面板的【原点】(Origin) 按钮，
   *   将当前对刀位置设为局部原点 (0,0)。
   *   因此任务开头**绝不能默认发送 !PG; 机械归位**！
   *   `!PG;` 是机械限位搜索动作（仅 X 轴导轨有机械开关，滚筒 Y 轴无开关），
   *   发 `!PG;` 会使刀头抛弃用户对刀原点、横跨整个导轨去撞右端限位，造成 X 轴疯狂远离原点。
   *   默认从用户当前对刀原点开始刻绘；仅当明确指定 `options.homeFirst === true` 时才归位。
   *   刻绘收尾默认抬刀并返回原点 `PA0,0;`，不强行机械撞限位。
   */
  build(path, options = {}) {
    const origin = options.origin || { x: 0, y: 0 };

    // 1. 默认不发 !PG;（保护用户在机器面板设置的对刀原点）
    if (options.homeFirst === true) {
      this.penUp();
      this.emit('!PG;');
    }

    // 2. 初始化与设置（IN; SP1; LT;）
    this.setupCoords(origin);
    this.setSpeed(options.speedMmPerSec || 30);
    if (options.force) this.setForce(options.force);
    this.penSelectOn();

    // 3. 图形本体：若有自定义工作原点，平移到工作原点相对坐标
    const workPath = (origin && (origin.x || origin.y))
      ? mapPathPoints(path, (x, y) => ({ x: x - origin.x, y: y - origin.y }))
      : path;

    for (const sub of workPath.subpaths) {
      this.runSubpath(sub, { closeAll: !!options.closeAll });
    }

    // 4. 收尾：抬刀回到起点并关笔
    this.penUp();
    if (options.homeEnd === true) {
      this.home();
    } else {
      this.emit('PA0,0;');
    }
    this.end();
    this._flushCoords();

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
    if ((m = line.match(/^PA((?:-?\d+,-?\d+,?)+);$/))) { out.push(`A${m[1].replace(/,$/, '')};`); continue; }
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

/**
 * 刻字机运动学物理耗时估算：
 * 基于指令流（HP-GL / DMPL）中的实际物理运动位移、落刀切割速度、
 * 抬刀快移速度、抬落刀机械时延与机械归位驻留耗时，进行物理执行时间仿真。
 */
export function estimateHpglMotion(text, options = {}) {
  const stepsPerInch = options.stepsPerInch || 1000;
  const mmPerUnit = 25.4 / stepsPerInch;
  let cutSpeed = options.defaultSpeed || 30; // mm/s
  const rapidRatio = options.rapidRatio || 4;
  let rapidSpeed = Math.max(cutSpeed * rapidRatio, 150); // mm/s

  let cutLengthMm = 0;
  let rapidLengthMm = 0;
  let penDrops = 0;
  let penLifts = 0;
  let homingCount = 0;

  let penDown = false;
  let curX = 0, curY = 0;

  const commands = text.split(';').map((s) => s.trim()).filter(Boolean);
  for (const raw of commands) {
    if (raw === '!PG' || raw === 'H') {
      homingCount++;
      curX = 0; curY = 0;
      penDown = false;
      continue;
    }
    const vsM = raw.match(/^(?:VS|V)(\d+)/);
    if (vsM) {
      cutSpeed = Math.max(1, +vsM[1] * 10);
      rapidSpeed = Math.max(cutSpeed * rapidRatio, 150);
      continue;
    }
    if (raw.startsWith('PU') || raw === 'U') {
      if (penDown) { penLifts++; penDown = false; }
      const coords = raw.startsWith('PU') ? raw.slice(2).trim() : '';
      if (coords) {
        const nums = coords.split(',').map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2) {
          if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
            const nx = nums[i] * mmPerUnit, ny = nums[i + 1] * mmPerUnit;
            rapidLengthMm += Math.hypot(nx - curX, ny - curY);
            curX = nx; curY = ny;
          }
        }
      }
      continue;
    }
    if (raw.startsWith('PD') || raw === 'D') {
      if (!penDown) { penDrops++; penDown = true; }
      const coords = raw.startsWith('PD') ? raw.slice(2).trim() : '';
      if (coords) {
        const nums = coords.split(',').map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2) {
          if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
            const nx = nums[i] * mmPerUnit, ny = nums[i + 1] * mmPerUnit;
            cutLengthMm += Math.hypot(nx - curX, ny - curY);
            curX = nx; curY = ny;
          }
        }
      }
      continue;
    }
    if (raw.startsWith('PA') || raw.startsWith('A')) {
      const prefix = raw.startsWith('PA') ? 2 : 1;
      const coords = raw.slice(prefix).trim();
      if (coords) {
        const nums = coords.split(',').map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2) {
          if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
            const nx = nums[i] * mmPerUnit, ny = nums[i + 1] * mmPerUnit;
            const dist = Math.hypot(nx - curX, ny - curY);
            if (penDown) cutLengthMm += dist;
            else rapidLengthMm += dist;
            curX = nx; curY = ny;
          }
        }
      }
      continue;
    }
    if (raw.startsWith('PR') || raw.startsWith('R')) {
      const prefix = raw.startsWith('PR') ? 2 : 1;
      const coords = raw.slice(prefix).trim();
      if (coords) {
        const nums = coords.split(',').map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2) {
          if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
            const dx = nums[i] * mmPerUnit, dy = nums[i + 1] * mmPerUnit;
            const dist = Math.hypot(dx, dy);
            if (penDown) cutLengthMm += dist;
            else rapidLengthMm += dist;
            curX += dx; curY += dy;
          }
        }
      }
      continue;
    }
    if (raw.startsWith('AA')) {
      const parts = raw.slice(2).split(',').map(Number);
      if (parts.length >= 3 && !parts.some(isNaN)) {
        const cx = parts[0] * mmPerUnit, cy = parts[1] * mmPerUnit;
        const angle = parts[2];
        const r = Math.hypot(curX - cx, curY - cy);
        const arcLen = Math.abs(angle) * (Math.PI / 180) * r;
        if (penDown) cutLengthMm += arcLen;
        else rapidLengthMm += arcLen;
        const rad = angle * (Math.PI / 180);
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = curX - cx, ry = curY - cy;
        curX = cx + rx * cos - ry * sin;
        curY = cy + rx * sin + ry * cos;
      }
      continue;
    }
  }

  const cutSeconds = cutLengthMm / Math.max(1, cutSpeed);
  const rapidSeconds = rapidLengthMm / Math.max(1, rapidSpeed);
  const latencySeconds = (penDrops * 0.04) + (penLifts * 0.03) + (homingCount * 3.0);
  const totalSeconds = cutSeconds + rapidSeconds + latencySeconds;

  return {
    cutLengthMm,
    rapidLengthMm,
    cutSeconds,
    rapidSeconds,
    latencySeconds,
    totalSeconds,
    totalMs: Math.max(200, Math.round(totalSeconds * 1000)),
  };
}
