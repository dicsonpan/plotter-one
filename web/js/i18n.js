/**
 * 轻量 i18n：中英双语，零依赖、零构建。
 *
 * 设计取舍（为什么不用现成方案）：
 *   本项目要部署到 RK3399 上，前端是**原生 ES module、零构建**——
 *   部署就是拷贝文件，不能引入需要 npm build 的依赖。
 *   所以这里手写一个够用的：字典 + t() + data-i18n 属性扫描。
 *
 * 三种文案来源，分别处理：
 *   1. **静态 HTML**：元素上挂 `data-i18n="key"`，切换语言时自动扫一遍替换。
 *      属性翻译用 `data-i18n-attr="placeholder:key1,title:key2"`。
 *   2. **动态 JS 文案**：代码里写 `t('key')`。
 *   3. **服务端返回**：服务端同时返回两种语言，客户端按当前语言取。
 *
 * 🔴 为什么不用「单文件塞两个语言对象」的做法：
 *   key 拼错时 `t()` 会返回 key 本身（而不是 undefined），
 *   这样漏翻译在界面上表现为「显示出一个英文 key」——一眼看得见，
 *   而不是静默显示空白。静默失败是这类改动最危险的形态。
 */

/** 当前语言：'zh' | 'en' */
let current = 'zh';

const STORAGE_KEY = 'plotter-lang';

/** 词典。找不到的 key 会回退到中文，再找不到就返回 key 本身。 */
const DICT = {
  zh: {
    // ---- 顶栏 / 全局
    'app.title': '刻字机控制台',
    'app.brandMark': '刻',
    'btn.connect': '连接设备',
    'btn.connecting': '连接中…',
    'btn.connected': '已连接',
    'btn.disconnect': '断开',
    'btn.disconnected': '未连接',
    'conn.outputting': '输出中',
    'conn.paused': '已暂停',
    'srv.connecting': '连接中…',
    'srv.unresponsive': '服务未响应',
    'srv.qrHint': '同一 Wi-Fi 下，手机浏览器打开 {{host}} 即可控制这台刻字机，无需安装 App。',
    'srv.qrHint2': '把本页「添加到主屏幕」，用起来跟 App 一样。',
    'lang.switch': 'EN',
    'lang.switchTitle': 'Switch to English',

    // ---- 导入
    'sect.import': '导入文件',
    'import.hint': '支持 DXF / SVG / PLT / HPGL / AI 导出的矢量文件。位图请先在设计软件中描摹成矢量。',
    'btn.chooseFile': '选择文件',
    'btn.loadDemo': '载入示例',
    'toast.parsing': '正在解析 {name}…',
    'toast.noPath': '文件里没找到可用的路径',
    'toast.imported': '已导入 {name}',
    'toast.parseFail': '解析失败：{msg}',
    'log.parseFail': '解析失败：{msg}',
    'log.importOk': '导入成功：{n} 条路径，长度 {len}mm',
    'log.notice': '注意：{msg}',
    'toast.demoLoaded': '示例已载入',
    'toast.grouped': '已将 {n} 项编组',
    'toast.ungrouped': '已解组为 {n} 项独立内容',

    // ---- 对象属性
    'sect.props': '对象属性',
    'prop.w': '宽',
    'prop.h': '高',
    'prop.angle': '角度',
    'prop.lockRatio': '锁定宽高比',
    'prop.ccw90': '逆时针 90°',
    'prop.cw90': '顺时针 90°',
    'prop.alignH': '水平对齐',
    'prop.alignV': '垂直对齐',
    'prop.alignLeft': '左对齐',
    'prop.alignHCenter': '水平居中',
    'prop.alignRight': '右对齐',
    'prop.alignBottom': '底部对齐',
    'prop.alignVCenter': '垂直居中',
    'prop.alignTop': '顶部对齐',
    'prop.flipH': '水平镜像',
    'prop.flipV': '垂直镜像',
    'prop.dup': '复制',
    'prop.front': '置顶',
    'prop.del': '删除',
    'prop.group': '编组',
    'prop.ungroup': '解组',
    'prop.copySuffix': '{name} 副本',
    'prop.selectedCount': '已选择 {n} 个对象',
    'toast.undone': '已撤销',
    'toast.redone': '已重做',
    'toast.noUndo': '没有可撤销的操作',
    'toast.noRedo': '没有可重做的操作',
    'toast.deleted': '已删除 {n} 项',
    'toast.flippedH': '已水平镜像',
    'toast.flippedV': '已垂直镜像',

    // ---- 快速文字
    'sect.text': '快速文字',
    'text.content': '内容',
    'text.placeholder': '输入要刻的字',
    'text.heightMm': '字高 mm',
    'text.rotate': '旋转 °',
    'text.startX': '起点 X',
    'text.startY': '起点 Y',
    'text.add': '加入版面',
    'toast.emptyText': '请输入内容',
    'toast.added': '已加入',

    // ---- 图形
    'sect.shapes': '图形',
    'shape.type': '类型',
    'shape.sizeMm': '尺寸 mm',
    'shape.rect': '矩形',
    'shape.circle': '圆形',
    'shape.ellipse': '椭圆',
    'shape.line': '直线',

    // ---- 版面内容
    'sect.layers': '版面内容',
    'layers.empty': '版面还是空的',
    'layers.emptyHint': '导入文件或加点东西',
    'layers.count': '{n} 项',
    'layer.hidden': '显示/隐藏',
    'layer.text': '文字「{text}」',
    'demo.sign': '示例招牌',
    'srv.httpFail': '请求失败 {code}',

    // ---- 画布
    'tool.select': '选择',
    'tool.pan': '平移',
    'tool.fit': '适应窗口',
    'tool.grid': '网格',
    'canvas.hint': '滚轮缩放 · 拖拽平移',
    'canvas.origin': '原点',
    'canvas.mechOrigin': '机械 0,0',
    'canvas.knife': '刀头',

    // ---- 设备连接
    'sect.device': '设备连接',
    'dev.settingsToggle': '设置',
    'dev.autoConn': '正在自动连接设备…',
    'dev.autoConnSub': '开机或插上 USB 将自动连接',
    'dev.connectedSub': '已自动连接 · 准备就绪',
    'dev.machine': '机器型号',
    'dev.connType': '连接方式',
    'dev.serial': 'USB / 串口（推荐）',
    'dev.tcp': '网口 TCP',
    'dev.virtual': '内置虚拟机（调试用）',
    'dev.port': '串口设备',
    'dev.refresh': '刷新',
    'dev.ip': 'IP',
    'dev.portNum': '端口',
    'toast.deviceConnected': '设备已连接',
    'toast.deviceClosed': '设备已断开',
    'toast.deviceError': '设备错误：{msg}',
    'toast.noDevice': '设备未连接',
    'toast.disconnected': '已断开',
    'toast.machineChanged': '已切换机型',
    'toast.needPort': '请选择串口',
    'toast.connectOk': '已连接：{dev}',
    'toast.connectFail': '连接失败：{msg}',
    'log.connectOk': '已连接 {dev}',
    'log.connectFail': '连接失败：{msg}',
    'port.none': '未检测到串口设备',
    'log.portNone': '未检测到串口设备。若是 USB 转串口，请确认驱动已装、线缆已插',
    'log.portFound': '检测到 {n} 个串口',
    'log.scanFail': '串口扫描失败：{msg}',

    // ---- 材料参数
    'sect.material': '材料参数',
    'mat.preset': '材料预设',
    'mat.speed': '刻绘速度',
    'mat.force': '刀压',
    'mat.direction': '走刀方向',
    'dir.ccw': '逆时针（推荐，切口无毛边）',
    'dir.cw': '顺时针',
    'dir.alternate': '交替（多层防积屑）',

    // ---- 手动控制
    'sect.manual': '手动控制',
    'pad.up': '向上',
    'pad.left': '向左',
    'pad.right': '向右',
    'pad.down': '向下',
    'pad.pendown': '落刀（试刀压）',
    'pad.stepMm': '步长 mm',
    'pad.stepFine': '0.1（微调）',
    'pad.hint': '按住 Shift 反向 · 连续点击可连续移动',
    'manual.knifePos': '刀头位置',
    'manual.userOrigin': '当前原点',
    'btn.penup': '抬刀',
    'btn.home': '回原点',
    'btn.setorigin': '设原点',
    'btn.resetOrigin': '重置原点',
    'toast.originSet': '已设新原点：({x}, {y}) mm',
    'toast.originReset': '已重置原点为 (0, 0)',
    'btn.feed50': '进纸50',
    'btn.eject50': '出纸50',
    'btn.penupHome': '抬刀回位',
    'manual.warn': '「设原点」会把当前位置定为新基准，之前的坐标全部作废。「落刀」会在当前位置划入 2mm 试刀压——先放废料，别在成品上试。',
    'log.manualFail': '手动控制失败：{msg}',

    // ---- 刀路概览
    'sect.stats': '刀路概览',
    'stat.length': '总长度',
    'stat.shapes': '图形数',
    'stat.time': '预计耗时',
    'stat.bytes': '指令量',
    'stat.pending': '待生成',

    // ---- 输出
    'sect.output': '输出',
    'btn.preview': '预览刀路',
    'btn.compile': '生成指令',
    'btn.send': '开始刻绘',
    'btn.pause': '暂停',
    'btn.resume': '继续',
    'btn.stop': '停止',
    'btn.estop': '急停',
    'btn.estopTitle': '急停会立即中断输出并抬刀。确定吗？',
    'job.waiting': '等待中',
    'job.progress': '{pct}% · {sent}/{total} 行',
    'job.eta': '剩余约 {time}',
    'toast.estopped': '已急停',
    'toast.needCompile': '还没有生成指令',
    'toast.compileFirst': '请先生成指令',
    'toast.emptyLayout': '版面是空的',
    'toast.copied': '已复制',
    'toast.generated': '已生成 {kb} KB 指令',
    'toast.compileFail': '生成失败：{msg}',
    'toast.previewStart': '开始预览刀路',
    'toast.previewFail': '预览失败：{msg}',
    'toast.outputStarted': '已开始输出',
    'toast.outputFail': '输出失败：{msg}',
    'toast.bootFail': '初始化失败',
    'log.compileDone': '编译完成：{n} 条指令，{kb}KB，预计 {time}',
    'log.previewDone': '预览完成',
    'log.outputStart': '开始输出到刻字机',
    'log.initFail': '初始化失败：{msg}',
    'confirm.multi': '当前版面有 {n} 项内容，确定要一起输出吗？',
    'confirm.go': '确定开始刻绘？请确认材料已放好、刀压速度合适。',
    'confirm.pendown': '落刀会在当前位置划入 2mm 试刀压。\n请确认下面是废料，不是成品。',
    'confirm.setorigin': '把当前位置设为新原点？\n\n之前的坐标全部作废，后续按新位置计算。\n不确定就别点——先在机身面板上校准。',
    'job.name': '刻绘 {n} 项',

    // ---- 指令预览 / 日志
    'sect.gcode': '指令预览',
    'gcode.empty': '生成指令后在此查看',
    'btn.copy': '复制',
    'btn.download': '下载 PLT',
    'sect.log': '运行日志',
    'sect.mobile': '在手机上使用',
    'log.waiting': '等待操作',

    // ---- 移动端
    'tab.content': '内容',
    'tab.canvas': '画布',
    'tab.control': '控制',

    // ---- 时间格式
    'time.sec': '{n} 秒',
    'time.minSec': '{m} 分 {s} 秒',
    'time.hourMin': '{h} 小时 {m} 分',

    // ---- 服务端返回的动态消息（key 由服务端约定）
    'srv.oversize': '图形超出幅面：X 最大 {x}mm / Y 最大 {y}mm，机器上限 {w}×{h}mm',
    'srv.negative': '图形有部分位于原点左下方（负坐标），请先移动到材料区域内',
    'srv.emptyToolpath': '刀路为空，请检查图形是否过小或已全部被清理',
    'srv.noContent': '没有可输出的内容',
    'srv.noValidPath': '合并后没有有效路径',
    'srv.gcodeMissing': '缺少 gcode 参数',
    'srv.apiMissing': '接口不存在',
    'srv.bodyTooLarge': '请求体过大',
    'srv.noSerialPath': '缺少串口路径',
    'srv.unknownConn': '未知连接类型',
    'srv.noAction': '缺少 action',
    'srv.buildFail': '指令生成失败：{msg}',
    'srv.noCommand': '未生成任何指令',
    'srv.noGcode': '没有指令内容',
    'srv.configFail': '配置读取失败，使用默认配置：{msg}',
    'srv.svgEmpty': 'SVG 中未找到可用的路径数据',
    'srv.lbText': '文件含 LB 文本指令，刻字机场景建议在设计端转为路径后输出',
    'srv.unknownCmds': '忽略了 {n} 类不认识的指令：{list}',
    'srv.spline': '检测到 SPLINE 样条曲线，已按控制点折线处理。若曲线不圆滑，请在设计软件中先转为多段线。',
    'srv.glyphMissing': '字符 {list} 超出内置单线字体，已用方框占位。中文请用前端轮廓模式。',
    'srv.virtualPlotter': '内置虚拟刻字机（不驱动真实硬件）',
    'srv.serialDown': '串口未连接',
    'srv.tcpDown': 'TCP 未连接',
    'srv.tcpTimeout': 'TCP 连接超时',
    'srv.virtualDown': '虚拟机未连接',
    'srv.sttyFail': 'stty 配置失败（{path}）：{msg}',
    'srv.manual.move0': '位移为 0，未发送移动指令',
    'srv.manual.stepClamp': '单次位移已限制在 ±{max}mm',
    'srv.manual.move': '移动 {dx}, {dy} mm（抬刀状态，不划伤材料）',
    'srv.manual.home': '回机械原点（抬刀后归位，不受坐标设置影响）',
    'srv.manual.penup': '抬刀（已强制下发 PU，不依赖软件对刀状态的判断）',
    'srv.manual.pendown': '落刀并在当前位置划入 2mm（用于试刀压）',
    'srv.manual.setorigin': '已把当前位置设为新原点（后续坐标以此为基准）',
    'srv.manual.feed0': '距离为 0，未发送进纸指令',
    'srv.manual.feedClamp': '单次进纸限制在 {max}mm',
    'srv.manual.feed': '{act} {d}mm',
    'srv.manual.stop': '抬刀并关笔，停止输出',
    'srv.manual.pause': '已发送擦除/暂停指令（建议用「暂停」按钮，切任务更可靠）',
    'srv.manual.end': '抬刀并回机械原点，本次控制指令结束',
    'srv.manual.unknown': '未知指令：{act}',
    'srv.job.start': '▶ 开始输出：{name}（{lines} 行 / {bytes} 字节）',
    'srv.job.abortErr': '✕ 输出中断：{msg}',
    'srv.job.homing': '机械归位中，等待机器到位…',
    'srv.job.stopped': '■ 已中止：{name}（下发 {sent}/{total} 行）',
    'srv.job.done': '✔ 完成：{name}',
    'srv.job.paused': '⏸ 已暂停',
    'srv.job.resumed': '▶ 已继续',
    'srv.job.stopping': '■ 请求停止…',
    'srv.job.estop': '⛔ 急停（已抬刀，未发送任何移动指令）',
    'srv.job.untitled': '未命名任务',
  },

  en: {
    // ---- Top bar / global
    'app.title': 'Engraving Console',
    'app.brandMark': 'E',
    'btn.connect': 'Connect',
    'btn.connecting': 'Connecting…',
    'btn.connected': 'Connected',
    'btn.disconnect': 'Disconnect',
    'btn.disconnected': 'Not connected',
    'conn.outputting': 'Running',
    'conn.paused': 'Paused',
    'srv.connecting': 'Connecting…',
    'srv.unresponsive': 'Server unreachable',
    'srv.qrHint': 'On the same Wi-Fi, open {{host}} in your phone browser to control the engraver — no app needed.',
    'srv.qrHint2': 'Add to Home Screen to use it like a native app.',
    'lang.switch': '中',
    'lang.switchTitle': '切换到中文',

    // ---- Import
    'sect.import': 'Import file',
    'import.hint': 'Supports vector files exported from DXF / SVG / PLT / HPGL / AI. Trace bitmaps to vectors in your design app first.',
    'btn.chooseFile': 'Choose file',
    'btn.loadDemo': 'Load sample',
    'toast.parsing': 'Parsing {name}…',
    'toast.noPath': 'No usable path found in the file',
    'toast.imported': 'Imported {name}',
    'toast.parseFail': 'Parse failed: {msg}',
    'log.parseFail': 'Parse failed: {msg}',
    'log.importOk': 'Imported {n} paths, total length {len}mm',
    'log.notice': 'Note: {msg}',
    'toast.demoLoaded': 'Sample loaded',
    'toast.grouped': 'Grouped {n} items',
    'toast.ungrouped': 'Ungrouped into {n} items',

    // ---- Object properties
    'sect.props': 'Properties',
    'prop.w': 'W',
    'prop.h': 'H',
    'prop.angle': 'Angle',
    'prop.lockRatio': 'Lock aspect ratio',
    'prop.ccw90': 'Rotate 90° CCW',
    'prop.cw90': 'Rotate 90° CW',
    'prop.alignH': 'Align horizontally',
    'prop.alignV': 'Align vertically',
    'prop.alignLeft': 'Align left',
    'prop.alignHCenter': 'Center horizontally',
    'prop.alignRight': 'Align right',
    'prop.alignBottom': 'Align bottom',
    'prop.alignVCenter': 'Center vertically',
    'prop.alignTop': 'Align top',
    'prop.flipH': 'Mirror horizontally',
    'prop.flipV': 'Mirror vertically',
    'prop.dup': 'Duplicate',
    'prop.front': 'Bring to front',
    'prop.del': 'Delete',
    'prop.group': 'Group',
    'prop.ungroup': 'Ungroup',
    'prop.copySuffix': '{name} copy',
    'prop.selectedCount': '{n} items selected',
    'toast.undone': 'Undone',
    'toast.redone': 'Redone',
    'toast.noUndo': 'Nothing to undo',
    'toast.noRedo': 'Nothing to redo',
    'toast.deleted': 'Deleted {n} item(s)',
    'toast.flippedH': 'Mirrored horizontally',
    'toast.flippedV': 'Mirrored vertically',

    // ---- Quick text
    'sect.text': 'Quick text',
    'text.content': 'Content',
    'text.placeholder': 'Text to engrave',
    'text.heightMm': 'Height mm',
    'text.rotate': 'Rotate °',
    'text.startX': 'Start X',
    'text.startY': 'Start Y',
    'text.add': 'Add to layout',
    'toast.emptyText': 'Enter some text',
    'toast.added': 'Added',

    // ---- Shapes
    'sect.shapes': 'Shapes',
    'shape.type': 'Type',
    'shape.sizeMm': 'Size mm',
    'shape.rect': 'Rectangle',
    'shape.circle': 'Circle',
    'shape.ellipse': 'Ellipse',
    'shape.line': 'Line',

    // ---- Layout contents
    'sect.layers': 'Layout',
    'layers.empty': 'Layout is empty',
    'layers.emptyHint': 'Import a file or add something',
    'layers.count': '{n} items',
    'layer.hidden': 'Show / hide',
    'layer.text': 'Text "{text}"',
    'demo.sign': 'Sample sign',
    'srv.httpFail': 'Request failed ({code})',

    // ---- Canvas
    'tool.select': 'Select',
    'tool.pan': 'Pan',
    'tool.fit': 'Fit',
    'tool.grid': 'Grid',
    'canvas.hint': 'Scroll to zoom · Drag to pan',
    'canvas.origin': 'Origin',
    'canvas.mechOrigin': 'Machine 0,0',
    'canvas.knife': 'Knife',

    // ---- Device connection
    'sect.device': 'Device',
    'dev.settingsToggle': 'Settings',
    'dev.autoConn': 'Auto-connecting…',
    'dev.autoConnSub': 'Will connect once powered on or plugged in',
    'dev.connectedSub': 'Connected · Ready',
    'dev.machine': 'Machine model',
    'dev.connType': 'Connection',
    'dev.serial': 'USB / serial (recommended)',
    'dev.tcp': 'Ethernet TCP',
    'dev.virtual': 'Built-in virtual plotter (debug)',
    'dev.port': 'Serial port',
    'dev.refresh': 'Refresh',
    'dev.ip': 'IP',
    'dev.portNum': 'Port',
    'toast.deviceConnected': 'Device connected',
    'toast.deviceClosed': 'Device disconnected',
    'toast.deviceError': 'Device error: {msg}',
    'toast.noDevice': 'Device not connected',
    'toast.disconnected': 'Disconnected',
    'toast.machineChanged': 'Machine model changed',
    'toast.needPort': 'Select a serial port',
    'toast.connectOk': 'Connected: {dev}',
    'toast.connectFail': 'Connection failed: {msg}',
    'log.connectOk': 'Connected {dev}',
    'log.connectFail': 'Connection failed: {msg}',
    'port.none': 'No serial port found',
    'log.portNone': 'No serial port found. For a USB-to-serial adapter, check the driver is installed and the cable is plugged in.',
    'log.portFound': 'Found {n} serial port(s)',
    'log.scanFail': 'Port scan failed: {msg}',

    // ---- Material
    'sect.material': 'Material',
    'mat.preset': 'Material preset',
    'mat.speed': 'Speed',
    'mat.force': 'Force',
    'mat.direction': 'Cut direction',
    'dir.ccw': 'Counter-clockwise (recommended, burr-free)',
    'dir.cw': 'Clockwise',
    'dir.alternate': 'Alternate (multi-layer chipping)',

    // ---- Manual control
    'sect.manual': 'Manual control',
    'pad.up': 'Up',
    'pad.left': 'Left',
    'pad.right': 'Right',
    'pad.down': 'Down',
    'pad.pendown': 'Pen down (test press)',
    'pad.stepMm': 'Step mm',
    'pad.stepFine': '0.1 (fine)',
    'pad.hint': 'Hold Shift to reverse · Click repeatedly to move continuously',
    'manual.knifePos': 'Knife Pos',
    'manual.userOrigin': 'Origin',
    'btn.penup': 'Pen up',
    'btn.home': 'Home',
    'btn.setorigin': 'Set origin',
    'btn.resetOrigin': 'Reset origin',
    'toast.originSet': 'Origin set to: ({x}, {y}) mm',
    'toast.originReset': 'Origin reset to (0, 0)',
    'btn.feed50': 'Feed 50',
    'btn.eject50': 'Eject 50',
    'btn.penupHome': 'Pen up & home',
    'manual.warn': '"Set origin" makes the current position the new datum — all previous coordinates are discarded. "Pen down" cuts 2mm at the current position to test pressure. Try on scrap first, never on a finished piece.',
    'log.manualFail': 'Manual control failed: {msg}',

    // ---- Toolpath stats
    'sect.stats': 'Toolpath',
    'stat.length': 'Total length',
    'stat.shapes': 'Shapes',
    'stat.time': 'Est. time',
    'stat.bytes': 'Command size',
    'stat.pending': 'Not built',

    // ---- Output
    'sect.output': 'Output',
    'btn.preview': 'Preview path',
    'btn.compile': 'Build commands',
    'btn.send': 'Start engraving',
    'btn.pause': 'Pause',
    'btn.resume': 'Resume',
    'btn.stop': 'Stop',
    'btn.estop': 'E-stop',
    'btn.estopTitle': 'E-stop halts output immediately and lifts the pen. Continue?',
    'job.waiting': 'Waiting',
    'job.progress': '{pct}% · {sent}/{total} lines',
    'job.eta': '{time} left',
    'toast.estopped': 'E-stopped',
    'toast.needCompile': 'No commands built yet',
    'toast.compileFirst': 'Build commands first',
    'toast.emptyLayout': 'Layout is empty',
    'toast.copied': 'Copied',
    'toast.generated': 'Built {kb} KB of commands',
    'toast.compileFail': 'Build failed: {msg}',
    'toast.previewStart': 'Previewing toolpath',
    'toast.previewFail': 'Preview failed: {msg}',
    'toast.outputStarted': 'Output started',
    'toast.outputFail': 'Output failed: {msg}',
    'toast.bootFail': 'Init failed',
    'log.compileDone': 'Built {n} commands, {kb}KB, est. {time}',
    'log.previewDone': 'Preview complete',
    'log.outputStart': 'Sending to engraver',
    'log.initFail': 'Init failed: {msg}',
    'confirm.multi': 'Layout has {n} items. Output them together?',
    'confirm.go': 'Start engraving? Make sure material is placed and speed/force are right.',
    'confirm.pendown': 'Pen down cuts 2mm at the current position to test pressure.\nMake sure this is scrap, not a finished piece.',
    'confirm.setorigin': 'Make the current position the new origin?\n\nAll previous coordinates are discarded and recomputed from the new position.\nSkip if unsure — calibrate on the machine panel first.',
    'job.name': 'Engrave {n} items',

    // ---- Command preview / log
    'sect.gcode': 'Commands',
    'gcode.empty': 'Build commands to view them here',
    'btn.copy': 'Copy',
    'btn.download': 'Download PLT',
    'sect.log': 'Log',
    'sect.mobile': 'Use on phone',
    'log.waiting': 'Waiting for activity',

    // ---- Mobile
    'tab.content': 'Content',
    'tab.canvas': 'Canvas',
    'tab.control': 'Controls',

    // ---- Time format
    'time.sec': '{n}s',
    'time.minSec': '{m}m {s}s',
    'time.hourMin': '{h}h {m}m',

    // ---- Server messages (keys defined by the server side)
    'srv.oversize': 'Design exceeds bed: max X {x}mm / max Y {y}mm, machine limit {w}×{h}mm',
    'srv.negative': 'Part of the design lies left/below the origin (negative coords) — move it into the material area',
    'srv.emptyToolpath': 'Toolpath is empty — check the design is not too small or was fully pruned',
    'srv.noContent': 'Nothing to output',
    'srv.noValidPath': 'No valid path after merging',
    'srv.gcodeMissing': 'Missing gcode parameter',
    'srv.apiMissing': 'No such endpoint',
    'srv.bodyTooLarge': 'Request body too large',
    'srv.noSerialPath': 'Missing serial path',
    'srv.unknownConn': 'Unknown connection type',
    'srv.noAction': 'Missing action',
    'srv.buildFail': 'Command build failed: {msg}',
    'srv.noCommand': 'No commands generated',
    'srv.noGcode': 'No command content',
    'srv.configFail': 'Failed to read config, using defaults: {msg}',
    'srv.svgEmpty': 'No usable path data found in the SVG',
    'srv.lbText': 'File contains LB text commands — convert text to paths in the design app for engraving',
    'srv.unknownCmds': 'Ignored {n} unrecognised command(s): {list}',
    'srv.spline': 'SPLINE curves found, approximated by control polygon. If curves look faceted, convert to polylines in your design app first.',
    'srv.glyphMissing': 'Characters {list} are outside the built-in stroke font and were replaced with boxes. For Chinese use the outline mode.',
    'srv.virtualPlotter': 'Built-in virtual plotter (no real hardware)',
    'srv.serialDown': 'Serial port not connected',
    'srv.tcpDown': 'TCP not connected',
    'srv.tcpTimeout': 'TCP connection timed out',
    'srv.virtualDown': 'Virtual plotter not connected',
    'srv.sttyFail': 'stty configuration failed ({path}): {msg}',
    'srv.manual.move0': 'Zero displacement, no move command sent',
    'srv.manual.stepClamp': 'Single move clamped to ±{max}mm',
    'srv.manual.move': 'Move {dx}, {dy} mm (pen up, will not scratch)',
    'srv.manual.home': 'Mechanical home (pen up, independent of coordinate settings)',
    'srv.manual.penup': 'Pen up (PU forced, does not rely on software pen state)',
    'srv.manual.pendown': 'Pen down, cuts 2mm at current position (test press)',
    'srv.manual.setorigin': 'Current position set as new origin (all coordinates relative to it)',
    'srv.manual.feed0': 'Zero distance, no feed command sent',
    'srv.manual.feedClamp': 'Single feed clamped to {max}mm',
    'srv.manual.feed': '{act} {d}mm',
    'srv.manual.stop': 'Pen up and deselect pen, stop output',
    'srv.manual.pause': 'Erase/pause command sent (prefer the Pause button — more reliable)',
    'srv.manual.end': 'Pen up and return to mechanical home, control session ended',
    'srv.manual.unknown': 'Unknown command: {act}',
    'srv.job.start': '▶ Start output: {name} ({lines} lines / {bytes} bytes)',
    'srv.job.abortErr': '✕ Output aborted: {msg}',
    'srv.job.homing': 'Homing, waiting for machine…',
    'srv.job.stopped': '■ Stopped: {name} (sent {sent}/{total} lines)',
    'srv.job.done': '✔ Done: {name}',
    'srv.job.paused': '⏸ Paused',
    'srv.job.resumed': '▶ Resumed',
    'srv.job.stopping': '■ Stop requested…',
    'srv.job.estop': '⛔ E-stop (pen lifted, no motion sent)',
    'srv.job.untitled': 'Untitled job',
  },
};

/**
 * 取一条文案。
 * @param {string} key 词典 key
 * @param {object} [vars] 插值变量，如 t('layers.count', {n: 3})
 * @returns {string}
 */
export function t(key, vars) {
  // 兜底顺序：当前语言 → 中文 → key 本身。
  // 返回 key 本身是刻意的：漏翻译会显示成 "some.key"，一眼可见，
  // 而静默显示空白会被当成「界面坏了」，排查成本高得多。
  let s = DICT[current]?.[key] ?? DICT.zh[key] ?? key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  }
  // {{host}} 在这里统一替换，而不是散落在各处。
  // 静态文案（HTML 里的 data-i18n）和动态文案（JS 里的 t()）都走这一条路径，
  // 否则静态那份会露出未替换的占位符 —— 表现为界面上直接显示「{{host}}」。
  if (s.includes('{{host}}')) {
    const loc = (typeof location !== 'undefined' && location) || {};
    s = s.replace('{{host}}', `<b>http://${loc.hostname || 'localhost'}:${loc.port || 80}</b>`);
  }
  return s;
}

/** 当前语言 */
export function lang() {
  return current;
}

/** 可用语言 */
export const LANGS = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

/**
 * 切换语言：刷新 DOM 静态文案、重跑一次状态拉取、重绘画布。
 *
 * ⚠️ 必须触发这三件事，缺一个就会出现「半边界面还是旧语言」：
 *   1. applyI18n —— HTML 里的静态文案
 *   2. 回调 —— 那些由 JS 写进去的文案（状态栏、统计、图层列表…）
 *   3. 重绘 —— 画布上的尺寸标注等
 * 只做 1 的话，切换后按钮变了但统计数字还是中文，非常迷惑。
 */
const listeners = new Set();

/** 注册语言切换回调（由 app.js 用来刷新动态文案） */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyI18n(root = document) {
  // 元素文本：<span data-i18n="key">旧文本</span>
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  // 属性：<input data-i18n-attr="placeholder:key1,title:key2">
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const i = pair.indexOf(':');
      if (i < 0) continue;
      const attr = pair.slice(0, i).trim();
      const key = pair.slice(i + 1).trim();
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  // 文档标题单独处理：它是 <title> 不是属性
  const ttl = root.querySelector('title[data-i18n]');
  if (ttl) document.title = t(ttl.dataset.i18n);
}

/**
 * 切换语言。
 * @param {'zh'|'en'} id
 * @param {boolean} [persist=true] 是否写入 localStorage
 */
export function setLang(id, persist = true) {
  if (id !== 'zh' && id !== 'en') return;
  current = id;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* 隐私模式下会失败，忽略 */ }
  }
  document.documentElement.setAttribute('lang', id === 'en' ? 'en' : 'zh-CN');
  applyI18n();
  for (const fn of listeners) {
    try { fn(id); } catch (e) { console.error('[i18n] 回调失败', e); }
  }
}

/**
 * 初始化：优先级 = 用户上次选择 > 浏览器语言 > 中文。
 * @returns {string} 实际生效的语言
 */
export function initLang() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* 忽略 */ }
  if (saved !== 'zh' && saved !== 'en') {
    // 用户没手动选过时，按系统/浏览器语言自动选。
    // 用 navigator.languages（用户完整的偏好排序）而不是只看主语言，
    // 这样「系统语言是英语」一定能命中英文；中文偏好排在前面才落中文。
    const prefs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || 'zh-CN'];
    let match = null;
    for (const l of prefs) {
      const low = String(l).toLowerCase();
      if (low.startsWith('zh')) { match = 'zh'; break; }
      if (low.startsWith('en')) { match = 'en'; break; }
    }
    saved = match || 'en';
  }
  setLang(saved, false);
  return current;
}

/** 当前语言下的取词函数（给不方便 import t 的地方用） */
export function tr(key, vars) {
  return t(key, vars);
}
