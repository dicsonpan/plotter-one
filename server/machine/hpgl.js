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

import { DEG, normAngle, currentPoint, mapPathPoints, pathBBox, makePath, makeSubpath, addLine } from '../geom/path.js';

// ---------------------------------------------------------------------------
// 机器原点方位定义
// ---------------------------------------------------------------------------

/**
 * 不同刻字机/平板机的物理原点（0,0）方位枚举。
 *
 * - 滚筒式刻字机（力宇 SC 系列、皮卡、图云等）：操作者正对机器时，刀头小车开机归位在右手边（前右侧），
 *   即画布的「右下角 (bottom-right)」，切割时刀头向左走、滚筒向前进纸。
 * - 平板式 / 4 轴雕刻机或部分异形机：原点可在「左下 (bottom-left)」「右上 (top-right)」「左上 (top-left)」。
 */
export const ORIGIN_POSITIONS = {
  'bottom-right': {
    id: 'bottom-right',
    name: '右下（刀头在右 · 向左进刀）',
    nameEn: 'Bottom-Right (head right · cuts left)',
    rotate: 90,
  },
  'bottom-left': {
    id: 'bottom-left',
    name: '左下（刀头在左 · 向右进刀）',
    nameEn: 'Bottom-Left (head left · cuts right)',
    rotate: 0,
  },
  'top-right': {
    id: 'top-right',
    name: '右上（刀头在右上 · 向左下进刀）',
    nameEn: 'Top-Right (head top-right)',
    rotate: 180,
  },
  'top-left': {
    id: 'top-left',
    name: '左上（刀头在左上 · 向右下进刀）',
    nameEn: 'Top-Left (head top-left)',
    rotate: 270,
  },
};

/**
 * 根据机器幅面与原点方位（originPosition），返回该原点在画布坐标系（左下为 0,0，X 向右，Y 向上）下的角点坐标。
 */
export function getOriginCorner(preset, originPosition) {
  const pos = originPosition || preset?.originPosition || 'bottom-right';
  const W = preset?.width || 600;
  const H = preset?.height || 710;
  switch (pos) {
    case 'bottom-right': return { x: W, y: 0 };
    case 'top-right':    return { x: W, y: H };
    case 'top-left':     return { x: 0, y: H };
    case 'bottom-left':
    default:             return { x: 0, y: 0 };
  }
}

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
    originPosition: 'bottom-right',
    // 实测（2026-10-04 / 2026-10-05，用户上机确认）：
    // 力宇刻字机物理原点在正对机器的右下角（右手边）：
    // - 机器 X 轴（HP-GL 第一参数）：走纸滚筒（材料前后进退，710mm）
    // - 机器 Y 轴（HP-GL 第二参数）：刀头龙门（从右向左横向移动，600mm）
    // 配合 layoutRotate: 90，画布右下角 (width, 0) 精确映射为机器物理原点 (0, 0)。
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 10, max: 500, default: 250, unit: 'g' },
    note: 'AU 版海外规格表标称刻绘 600mm / 进纸 710mm。默认原点在右下角（右手边对刀）。',
    noteEn: 'AU export spec lists 600mm plot width / 710mm feed. Default origin at bottom-right.',
  },
  'liyue-sc631e': {
    id: 'liyue-sc631e',
    name: '力宇 SC631E / SC631-AU（630mm）',
    nameEn: 'Liyue SC631E / SC631-AU (630mm)',
    width: 630, height: 710,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    originPosition: 'bottom-right',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 630mm，进纸宽度 710mm，默认原点在右下角。仅在确认机身标称 630mm 时使用。',
    noteEn: 'Max plot width 630mm, feed width 710mm, bottom-right origin. Use only after confirming nameplate rating.',
  },
  'liyue-sc630': {
    id: 'liyue-sc630',
    name: '力宇 SC630 / SC631E',
    nameEn: 'Liyue SC630 / SC631E',
    width: 630, height: 710,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    originPosition: 'bottom-right',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 630mm，进纸宽度 710mm，默认原点在右下角',
    noteEn: 'Max plot width 630mm, feed width 710mm, bottom-right origin',
  },
  'liyue-sc801': {
    id: 'liyue-sc801',
    name: '力宇 SC801 / SC801E',
    nameEn: 'Liyue SC801 / SC801E',
    width: 800, height: 880,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    originPosition: 'bottom-right',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 800mm，进纸宽度 880mm，默认原点在右下角',
    noteEn: 'Max plot width 800mm, feed width 880mm, bottom-right origin',
  },
  'liyue-sc1261': {
    id: 'liyue-sc1261',
    name: '力宇 SC1261 / SC1261E',
    nameEn: 'Liyue SC1261 / SC1261E',
    width: 1260, height: 1340,
    stepsPerInch: 1000,
    dialect: 'hpgl',
    originPosition: 'bottom-right',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '最大刻绘宽度 1260mm，进纸宽度 1340mm，默认原点在右下角',
    noteEn: 'Max plot width 1260mm, feed width 1340mm, bottom-right origin',
  },
  'generic-hpgl-1016': {
    id: 'generic-hpgl-1016',
    name: '通用 HPGL 刻字机（1016 单位/英寸）',
    nameEn: 'Generic HPGL engraver (1016 units/inch)',
    width: 630, height: 710,
    stepsPerInch: 1016,
    dialect: 'hpgl',
    originPosition: 'bottom-right',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '标准 HPGL 分辨率，进口机与部分国产板卡，默认原点在右下角',
    noteEn: 'Standard HPGL resolution; imported machines and some domestic boards, bottom-right origin',
  },
  /**
   * 通用 1016 机（600mm 刻绘宽）—— 金利来新机，2026-10-28 按文泰实机设置匹配。
   */
  'generic-1016-600': {
    id: 'generic-1016-600',
    name: '通用 1016（600mm 刻绘宽）',
    nameEn: 'Generic 1016 (600mm plot width)',
    width: 600, height: 710,
    stepsPerInch: 1016,
    dialect: 'hpgl',
    originPosition: 'bottom-right',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '文泰实测 1016 步/英寸（非力宇的 1000）。刻绘宽 600mm，进纸 710mm，默认右下角原点。',
    noteEn: 'ArtCut resolution 1016 steps/inch (not Liyu 1000). 600mm plot width, 710mm feed, bottom-right origin.',
  },
  'liyue-4axis': {
    id: 'liyue-4axis',
    name: '力宇四轴 / 伺服刻字机（3D）',
    nameEn: 'Liyue 4-axis / servo engraver (3D)',
    width: 800, height: 880,
    stepsPerInch: 4060,
    dialect: 'hpgl3d',
    originPosition: 'bottom-left',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 0,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: true },
    maxSpeed: 980, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 300, unit: 'g' },
    note: '4060 线/英寸，平板 3D 机型默认左下角原点，PU/PD 带 Z 分量，支持力度指令',
    noteEn: '4060 lines/inch, 3D flatbed default bottom-left origin, PU/PD carry Z component, supports force commands',
  },
  'generic-dmpl': {
    id: 'generic-dmpl',
    name: '通用 DMPL 割字机（国产 DMPL 板）',
    nameEn: 'Generic DMPL cutter (domestic DMPL boards)',
    width: 630, height: 710,
    stepsPerInch: 1016,
    dialect: 'dmpl',
    originPosition: 'bottom-right',
    axisX: 1,
    axisY: 1,
    swapAxes: false,
    layoutRotate: 90,
    serialDefault: { baud: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false },
    maxSpeed: 800, minSpeed: 12.5,
    force: { min: 70, max: 500, default: 250, unit: 'g' },
    note: '金谷田 / 赛博等国产通用 DMPL 语言刻字机，默认右下角原点',
    noteEn: 'Domestic DMPL engravers such as JinguTian / Saibo, bottom-right origin',
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
    this.originPosition = options.originPosition || preset.originPosition || 'bottom-right';
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
    // 若显式传入 options.layoutRotate 则优先；若传入了 options.originPosition，则由原点位置推导旋转角；
    // 否则回退到 preset.layoutRotate 或 preset.originPosition 对应的旋转角。
    let rawRotate;
    if (options.layoutRotate !== undefined) {
      rawRotate = options.layoutRotate;
    } else if (options.originPosition && ORIGIN_POSITIONS[options.originPosition]) {
      rawRotate = ORIGIN_POSITIONS[options.originPosition].rotate;
    } else if (preset.layoutRotate !== undefined) {
      rawRotate = preset.layoutRotate;
    } else if (preset.originPosition && ORIGIN_POSITIONS[preset.originPosition]) {
      rawRotate = ORIGIN_POSITIONS[preset.originPosition].rotate;
    } else {
      rawRotate = 0;
    }
    this.layoutRotate = normalizeRotate(rawRotate);
    this.origin = options.origin || null;
    this.dialect = preset.dialect || 'hpgl';
    this.cmds = [];
    this.pos = { x: 0, y: 0 };
    this.penDown = false;
    this.bytes = 0;
    this._coordBatch = [];
    this._flushing = false;
    // 默认单点直发 PD x,y;（兼容所有力宇/国产 GD32 刻字机精简固件，避免长包/多坐标被忽略）；
    // 仅在显式指定 maxBatchPairs > 1 时合并为批量 PD x1,y1,x2,y2...;
    this.maxBatchPairs = options.maxBatchPairs !== undefined ? options.maxBatchPairs : 1;
    // 2D 刻字机固件普遍不支持 AA/CI 硬件圆弧插补（文泰驱动一律离散为 PD 折线），默认离散化
    this.useNativeArc = options.useNativeArc === true;
    // 文泰闭合过切补偿（datacllt.dll SetCutterCloseAddDist / FUN_1001b2ac）：
    // 闭合子路径切回起点后，顺着起始段继续多切 overcutMm（默认 0.3mm），防止起收刀处留连皮
    this.overcutMm = options.overcutMm !== undefined ? Number(options.overcutMm) : 0.3;
  }

  /**
   * 机器物理 (0,0) 在画布坐标系下对应的机械原点坐标：
   *   - bottom-right (layoutRotate=90):  (width, 0)
   *   - bottom-left  (layoutRotate=0):   (0, 0)
   *   - top-right    (layoutRotate=180): (width, height)
   *   - top-left     (layoutRotate=270): (0, height)
   */
  get mechOrigin() {
    return this._rawToUser(0, 0);
  }

  /**
   * 用户自定义工作原点相对于机械原点（mechOrigin）的画布坐标偏移量。
   * 当未传 origin、传了 {x:0,y:0} 默认占位、或 origin 恰好等于 mechOrigin 时，偏移为 (0,0)。
   */
  _originShift(originOverride) {
    const orig = originOverride !== undefined ? originOverride : this.origin;
    if (!orig || (orig.x === 0 && orig.y === 0)) return { x: 0, y: 0 };
    const mech = this.mechOrigin;
    const dx = orig.x - mech.x;
    const dy = orig.y - mech.y;
    if (Math.abs(dx) <= 1e-6 && Math.abs(dy) <= 1e-6) return { x: 0, y: 0 };
    return { x: dx, y: dy };
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
   * 用户坐标约定：画布左下角为 (0,0)，X 向右，Y 向上。
   * 经过 layoutRotate 变换后，对应机器原点方位（如右下角 (W,0)）自动映射为机器物理 (0,0)。
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

  _flushCoords() {
    if (this._coordBatch && this._coordBatch.length > 0) {
      const coords = this._coordBatch.join(',');
      this._coordBatch = [];
      this._flushing = true;
      this.emit(`PD${coords};`);
      this._flushing = false;
    }
    return this;
  }

  /**
   * 不含工作原点偏移的基础逆变换：机器坐标 → 画布坐标。
   */
  _rawToUser(mx, my) {
    const sx = this.machineSpanX;
    const sy = this.machineSpanY;
    let ux = this.axisX >= 0 ? mx : (sx - mx);
    let uy = this.axisY >= 0 ? my : (sy - my);
    if (this.swapAxes) { const t = ux; ux = uy; uy = t; }
    const W = this.preset.width, H = this.preset.height;
    switch (this.layoutRotate) {
      case 90:  return { x: W - uy, y: ux };
      case 180: return { x: W - ux, y: H - uy };
      case 270: return { x: uy, y: H - ux };
      default:  return { x: ux, y: uy };
    }
  }

  /**
   * `toMachine` 的逆变换：机器坐标 → 用户（设计）坐标。
   * 若设置了自定义工作原点（this.origin），一并还原该偏移，确保 `/api/preview` 与画布图形完全重合。
   */
  toUser(mx, my) {
    const base = this._rawToUser(mx, my);
    const shift = this._originShift();
    return {
      x: base.x + shift.x,
      y: base.y + shift.y,
    };
  }

  /**
   * 初始化机器与设定状态。
   *
   * 🔴 严禁在卷筒刻字机上发送 SC 指令与 LT 指令：
   *   1. HP-GL 的 SC 指令在无固定 Y 上限的卷筒刻字机上会导致 Scale_Y 归零、Y 轴失灵；
   *   2. LT; 是笔式绘图仪虚线线型指令，部分刻字机精简固件不识别；
   *   3. 显式发送 PA; 锁定绝对坐标模式，对齐文泰（ArtCut）标准 PLT 头部。
   */
  setupCoords(origin) {
    this.emit('IN;');
    if (this.dialect === 'dmpl') {
      this.emit(';:');
      this.emit('IN;');
    }
    this.emit('PA;');
    this.emit('SP1;');
    this.emit('PU0,0;');
    this.penDown = false;
    this.pos = { x: 0, y: 0 };
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

  /** 结束落刀批次并标记抬刀（对齐文泰 WritePlt：不发孤立无坐标的 PU;，由后续 PU x,y; 执行抬刀空移） */
  penUp() {
    this._flushCoords();
    this.penDown = false;
    return this;
  }

  /**
   * 无条件抬刀：显式发一条 `PU;`（供手动按钮或安全測試调用）。
   */
  forcePenUp() {
    this._flushCoords();
    this.emit('PU;');
    this.penDown = false;
    return this;
  }

  penSelectOn() {
    this._flushCoords();
    this.penDown = false;
    return this;
  }

  /**
   * 抬刀空移到绝对坐标 (x, y)：使用文泰标准 `PU x,y;` 格式。
   */
  moveTo(x, y) {
    this._flushCoords();
    const p = this.toMachine(x, y);
    const px = toPlotterUnits(p.x, this.spi);
    const py = toPlotterUnits(p.y, this.spi);
    this.emit(`PU${px},${py};`);
    this.penDown = false;
    this.pos = { x: px, y: py };
    return this;
  }

  /**
   * 落刀切割到绝对坐标 (x, y)：使用文泰标准 `PD x,y;` 格式。
   */
  lineTo(x, y) {
    const p = this.toMachine(x, y);
    const px = toPlotterUnits(p.x, this.spi);
    const py = toPlotterUnits(p.y, this.spi);
    this.penDown = true;
    this.pos = { x: px, y: py };
    if (this.maxBatchPairs <= 1) {
      this.emit(`PD${px},${py};`);
      return this;
    }
    this._coordBatch.push(px, py);
    if (this.maxBatchPairs > 0 && this._coordBatch.length >= this.maxBatchPairs * 2) {
      this._flushCoords();
    }
    return this;
  }

  /**
   * 圆弧：默认按 0.02mm 弦高离散为标准 `PD x,y;` 折线。
   */
  arcTo(cx, cy, r, a0, a1) {
    if (!this.useNativeArc) {
      const rAbs = Math.max(0.001, Math.abs(r));
      const step = rAbs <= 0.02
        ? Math.PI / 4
        : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.02 / rAbs)));
      const abs = Math.abs(a1 - a0);
      const n = Math.max(12, Math.ceil(abs / step));
      for (let i = 1; i <= n; i++) {
        const t = a0 + ((a1 - a0) * i) / n;
        this.lineTo(cx + rAbs * Math.cos(t), cy + rAbs * Math.sin(t));
      }
      return this;
    }

    this._flushCoords();
    const c = this.toMachine(cx, cy);
    const cxq = toPlotterUnits(c.x, this.spi);
    const cyq = toPlotterUnits(c.y, this.spi);
    const rq = toPlotterUnits(r, this.spi);
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }

    let d0 = Math.round(Math.atan2(this.pos.y - cyq, this.pos.x - cxq) / DEG) % 360;
    if (d0 < 0) d0 += 360;

    let sweep = (a1 - a0) / DEG;
    if (this.isReflection) sweep = -sweep;
    if (Math.abs(sweep) >= 360 - 1e-9) {
      sweep = 360;
    } else if (sweep < 0) {
      sweep += 360;
    }
    const d1 = Math.round(sweep);
    this.emit(`AA${cxq},${cyq},${d0},${d1};`);

    const endA = d0 * DEG + d1 * DEG;
    this.pos = { x: cxq + rq * Math.cos(endA), y: cyq + rq * Math.sin(endA) };
    return this;
  }

  /**
   * 椭圆：离散为折线 `PD x,y;`。
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
   * 整圆：默认离散为闭合折线 `PU x,y;` + `PD x,y;`。
   */
  circleAt(x, y, r) {
    if (!this.useNativeArc) {
      this.penUp();
      this.moveTo(x + r, y);
      this.arcTo(x, y, r, 0, Math.PI * 2);
      this.penUp();
      return this;
    }
    const c = this.toMachine(x, y);
    this.penUp();
    this.emit(`PU${toPlotterUnits(c.x, this.spi)},${toPlotterUnits(c.y, this.spi)};`);
    this.pos = { x: toPlotterUnits(c.x, this.spi), y: toPlotterUnits(c.y, this.spi) };
    if (!this.penDown) { this.emit('PD;'); this.penDown = true; }
    const rq = toPlotterUnits(r, this.spi);
    this.emit(`CI${rq};`);
    const dir = this.axisX >= 0 ? 1 : -1;
    this.pos = { x: toPlotterUnits(c.x + r * dir, this.spi), y: toPlotterUnits(c.y, this.spi) };
    return this;
  }

  /**
   * 文泰闭合过切补偿（datacllt.dll FUN_1001b2ac / SetCutterCloseAddDist）：
   * 闭合环切回起点后，顺着起始段方向继续多走 overcutMm，彻底切断起收刀交界处的材料。
   */
  _emitOvercut(sub, distMm) {
    let remain = distMm;
    let curX = sub.start.x;
    let curY = sub.start.y;
    for (const e of sub.elems) {
      if (remain <= 1e-6) break;
      if (e.type === 'line') {
        const dx = e.x2 - curX;
        const dy = e.y2 - curY;
        const segLen = Math.hypot(dx, dy);
        if (segLen > 1e-9) {
          if (remain <= segLen) {
            const t = remain / segLen;
            this.lineTo(curX + dx * t, curY + dy * t);
            break;
          }
          this.lineTo(e.x2, e.y2);
          remain -= segLen;
          curX = e.x2;
          curY = e.y2;
        }
      } else if (e.type === 'arc') {
        const rAbs = Math.max(0.001, Math.abs(e.r));
        const sweep = e.a1 - e.a0;
        const arcLen = Math.abs(sweep) * rAbs;
        if (arcLen > 1e-9) {
          const takeAngle = Math.min(Math.abs(sweep), remain / rAbs) * (sweep >= 0 ? 1 : -1);
          this.arcTo(e.cx, e.cy, rAbs, e.a0, e.a0 + takeAngle);
          if (remain <= arcLen) break;
          remain -= arcLen;
          curX = e.cx + rAbs * Math.cos(e.a1);
          curY = e.cy + rAbs * Math.sin(e.a1);
        }
      } else if (e.type === 'ellipse') {
        const rMax = Math.max(0.001, e.rx, e.ry);
        const sweep = e.a1 - e.a0;
        const approxLen = Math.abs(sweep) * rMax;
        if (approxLen > 1e-9) {
          const takeAngle = Math.min(Math.abs(sweep), remain / rMax) * (sweep >= 0 ? 1 : -1);
          this.ellipseTo(e.cx, e.cy, e.rx, e.ry, e.a0, e.a0 + takeAngle);
          break;
        }
      }
    }
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
    const isClosed = sub.closed || closeAll;
    if (isClosed) {
      const end = currentPoint(sub);
      if (Math.hypot(end.x - sub.start.x, end.y - sub.start.y) > 1e-9) {
        this.lineTo(sub.start.x, sub.start.y);
      }
      if (this.overcutMm > 0 && sub.elems.length > 0) {
        this._emitOvercut(sub, this.overcutMm);
      }
    }
    this.penUp();
    return this;
  }

  /**
   * 回到对刀原点 (0,0)。
   */
  home() {
    this._flushCoords();
    this.emit('PU0,0;');
    this.penDown = false;
    this.pos = { x: 0, y: 0 };
    return this;
  }

  end() {
    this.penUp();
    return this;
  }

  /**
   * 生成完整任务指令。
   *
   * 🔴 原点保护与坐标偏移算法：
   *   1. 任务开头绝不默认发送 !PG; 机械归位（保护用户在机器面板设置的对刀原点）；
   *   2. 初始化采用文泰标准 `IN; PA; SP1; PU0,0;`；
   *   3. 当传入自定义工作原点 options.origin 时，偏移量必须相对于机械原点 `this.mechOrigin`
   *      计算（即 `shift = origin - mechOrigin`），而不是相对于画布左下角 `(0,0)`！
   *      这样当图形位于 `origin` 处时，平移后恰好落在 `mechOrigin`，经 `toMachine` 映射为 `(0,0)`，
   *      彻底消除右下角原点机型上错误的 Y 轴大幅空走。
   */
  build(path, options = {}) {
    if (options.origin !== undefined) this.origin = options.origin;
    const shift = this._originShift(options.origin);

    // 1. 默认绝不发 !PG;（仅当显式传入 homeFirst === true 时才发）
    if (options.homeFirst === true) {
      this.penUp();
      this.emit('!PG;');
    }

    // 2. 初始化与设置（文泰标准：IN; PA; SP1; PU0,0;）
    this.setupCoords(options.origin);
    if (options.emitSpeed === true || this.dialect === 'hpgl3d' || this.dialect === 'dmpl') {
      this.setSpeed(options.speedMmPerSec || 30);
    }
    if (options.force) this.setForce(options.force);
    this.penSelectOn();

    // 3. 图形本体：若有相对于机械原点的自定义工作原点偏移，平移到对应位置
    const workPath = (shift.x !== 0 || shift.y !== 0)
      ? mapPathPoints(path, (x, y) => ({ x: x - shift.x, y: y - shift.y }))
      : path;

    for (const sub of workPath.subpaths) {
      this.runSubpath(sub, { closeAll: !!options.closeAll });
    }

    // 4. 收尾：抬刀回到对刀原点 (0,0)
    this.penUp();
    if (options.homeEnd === true) {
      this.emit('!PG;');
    } else {
      this.emit('PU0,0;');
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

/**
 * 生成「走框预览」（边框范围巡边）指令：
 * 全程保持**抬刀状态（PU）**，从距离当前原点最近的包围盒角点出发，
 * 沿待刻图形的外接矩形四条边空走一圈，最后回到对刀原点 `PU0,0;`，绝不落刀（不含任何 PD）。
 * 让用户在真正下刀前直观看到机器在真实材料上的刻绘范围。
 */
export function buildFrameCommand(path, preset, options = {}) {
  const bbox = pathBBox(path);
  if (!Number.isFinite(bbox.minX) || (bbox.w <= 0 && bbox.h <= 0)) {
    throw new Error('图形为空，无法生成走框预览');
  }

  const builder = new HpglBuilder(preset, options);
  const shift = builder._originShift(options.origin);
  const mech = builder.mechOrigin;
  const effOrigin = { x: mech.x + shift.x, y: mech.y + shift.y };
  const pos = builder.originPosition;
  const isRight = pos === 'bottom-right' || pos === 'top-right';
  const isTop = pos === 'top-right' || pos === 'top-left';

  // 从离原点最近的角点开始，顺次走完外接矩形四个顶点并闭合回起点
  const nearX = isRight ? bbox.maxX : bbox.minX;
  const farX  = isRight ? bbox.minX : bbox.maxX;
  const nearY = isTop   ? bbox.maxY : bbox.minY;
  const farY  = isTop   ? bbox.minY : bbox.maxY;

  const corners = [
    { x: nearX, y: nearY },
    { x: farX,  y: nearY },
    { x: farX,  y: farY  },
    { x: nearX, y: farY  },
    { x: nearX, y: nearY },
  ];

  // 构造前端动画与预览可用的闭合矩形路径（画布坐标）
  const framePath = makePath();
  const sub = makeSubpath(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) {
    addLine(sub, corners[i].x, corners[i].y);
  }
  sub.closed = true;
  framePath.subpaths.push(sub);

  // 生成纯抬刀（PU）走框指令：绝不落刀
  builder.emit('IN;');
  if (builder.dialect === 'dmpl') {
    builder.emit(';:');
    builder.emit('IN;');
  }
  builder.emit('PA;');
  builder.emit('SP1;');
  builder.forcePenUp();
  if (options.emitSpeed === true || builder.dialect === 'hpgl3d' || builder.dialect === 'dmpl') {
    builder.setSpeed(options.speedMmPerSec || 40);
  }

  for (const pt of corners) {
    builder.moveTo(pt.x - shift.x, pt.y - shift.y);
  }
  builder.home();

  let text = builder.cmds.join('\n') + '\n';
  if (preset.dialect === 'dmpl') {
    text = hpglToDmpl(text);
  }

  // 计算相对于当前原点的距离范围，方便界面直观展示给用户
  const offsetX = Math.max(0, isRight ? (effOrigin.x - bbox.maxX) : (bbox.minX - effOrigin.x));
  const offsetY = Math.max(0, isTop   ? (effOrigin.y - bbox.maxY) : (bbox.minY - effOrigin.y));
  const originBBox = {
    offsetX,
    offsetY,
    reachX: offsetX + bbox.w,
    reachY: offsetY + bbox.h,
    w: bbox.w,
    h: bbox.h,
  };

  const wStr = bbox.w.toFixed(1);
  const hStr = bbox.h.toFixed(1);
  const rx0 = offsetX.toFixed(1), rx1 = originBBox.reachX.toFixed(1);
  const ry0 = offsetY.toFixed(1), ry1 = originBBox.reachY.toFixed(1);

  return {
    text,
    bytes: text.length,
    commandCount: builder.cmds.length,
    bbox,
    originBBox,
    framePath,
    notes: [
      {
        zh: `走框预览：外框尺寸 ${wStr}×${hStr}mm（距原点 X:${rx0}~${rx1}mm, Y:${ry0}~${ry1}mm），全程抬刀空走`,
        en: `Frame check: ${wStr}×${hStr}mm (from origin X:${rx0}~${rx1}mm, Y:${ry0}~${ry1}mm), blade up`,
      },
    ],
  };
}

/** DMPL 方言：把 HPGL 指令翻译成 DMPL 语法 */
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
  const w = createMotionWalker(options);
  for (const raw of splitCommands(text)) w.feed(raw);
  return w.summary();
}

/**
 * 逐行（每行一条或多条 ';' 指令）的物理耗时（毫秒）。
 */
export function estimateLineMotionMs(lines, options = {}) {
  const w = createMotionWalker(options);
  return lines.map((line) => {
    let sum = 0;
    for (const raw of splitCommands(line)) sum += w.feed(raw);
    return sum;
  });
}

function splitCommands(text) {
  return text.split(';').map((s) => s.trim()).filter(Boolean);
}

/**
 * 运动学遍历器：逐条喂入指令，**逐条**返回物理耗时（毫秒）。
 */
function createMotionWalker(options = {}) {
  const stepsPerInch = options.stepsPerInch || 1000;
  const mmPerUnit = 25.4 / stepsPerInch;
  const rapidRatio = options.rapidRatio || 4;
  const homingDwellMs = options.homingDwellMs ?? 3000;

  let cutSpeed = options.defaultSpeed || 30; // mm/s
  let rapidSpeed = Math.max(cutSpeed * rapidRatio, 150); // mm/s
  let cutLengthMm = 0;
  let rapidLengthMm = 0;
  let penDrops = 0;
  let penLifts = 0;
  let homingCount = 0;
  let penDown = false;
  let curX = 0, curY = 0;

  /** 走一段位移：返回耗时（ms），并按当前刀状态计入 cut/rapid 长度 */
  const walkSegment = (nx, ny) => {
    const dist = Math.hypot(nx - curX, ny - curY);
    if (penDown) cutLengthMm += dist;
    else rapidLengthMm += dist;
    curX = nx; curY = ny;
    return (dist / Math.max(1, penDown ? cutSpeed : rapidSpeed)) * 1000;
  };

  /** 走一串「绝对坐标列表」（PA / PD 带坐标的形式） */
  const walkCoordList = (coords) => {
    if (!coords) return 0;
    let cost = 0;
    const nums = coords.split(',').map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
        cost += walkSegment(nums[i] * mmPerUnit, nums[i + 1] * mmPerUnit);
      }
    }
    return cost;
  };

  /** 喂一条指令（不含分号），返回它的物理耗时（ms） */
  const feed = (raw) => {
    if (raw === '!PG' || raw === 'H') {
      homingCount++;
      curX = 0; curY = 0;
      penDown = false;
      return homingDwellMs;
    }
    const vsM = raw.match(/^(?:VS|V)(\d+)/);
    if (vsM) {
      cutSpeed = Math.max(1, +vsM[1] * 10);
      rapidSpeed = Math.max(cutSpeed * rapidRatio, 150);
      return 0;
    }
    if (raw.startsWith('PU') || raw === 'U') {
      let cost = 0;
      if (penDown) { penLifts++; penDown = false; cost += 30; }
      return cost + walkCoordList(raw.startsWith('PU') ? raw.slice(2).trim() : '');
    }
    if (raw.startsWith('PD') || raw === 'D') {
      let cost = 0;
      if (!penDown) { penDrops++; penDown = true; cost += 40; }
      return cost + walkCoordList(raw.startsWith('PD') ? raw.slice(2).trim() : '');
    }
    if (raw.startsWith('PA') || raw.startsWith('A')) {
      return walkCoordList(raw.slice(raw.startsWith('PA') ? 2 : 1).trim());
    }
    if (raw.startsWith('PR') || raw.startsWith('R')) {
      const coords = raw.slice(raw.startsWith('PR') ? 2 : 1).trim();
      if (!coords) return 0;
      let cost = 0;
      const nums = coords.split(',').map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
          cost += walkSegment(curX + nums[i] * mmPerUnit, curY + nums[i + 1] * mmPerUnit);
        }
      }
      return cost;
    }
    if (raw.startsWith('AA')) {
      const parts = raw.slice(2).split(',').map(Number);
      if (parts.length >= 3 && !parts.some(isNaN)) {
        const cx = parts[0] * mmPerUnit, cy = parts[1] * mmPerUnit;
        const rad = parts[2] * (Math.PI / 180);
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = curX - cx, ry = curY - cy;
        return walkSegment(cx + rx * cos - ry * sin, cx + rx * sin + ry * cos);
      }
      return 0;
    }
    return 0;
  };

  return {
    feed,
    summary() {
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
    },
  };
}
