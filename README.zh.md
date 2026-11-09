# 刻字机 Web 控制服务（SparkPlotter / plotter-one）

**[English](README.md)** | 简体中文

把 Windows 独占的刻字机输出软件（Ucancam / UcanSign、文泰刻绘）搬到浏览器。
一台低功耗小板子插在刻字机旁边，局域网内任何设备用浏览器打开就能用——Windows、Mac、iPad、安卓手机，甚至没装任何东西的瘦客户端。

```
                 同一局域网
   ┌────────┐  ┌────────┐  ┌────────┐
   │  电脑  │  │  手机  │  │  平板  │     浏览器，不用装软件
   └────┬───┘  └───┬────┘  └───┬────┘
        └──────────┴───────────┘
                   │ HTTP + WebSocket
                   ▼
        ┌──────────────────────┐
        │  RK3399 / 任意 ARM64 │   常驻 3-5W
        │  Node.js 零依赖      │
        └──────────┬───────────┘
                   │ USB / RS-232 115200 8N1
                   ▼
              力宇刻字机
```

---

## 特点

| | Ucancam / UcanSign / 文泰 | 本项目 (SparkPlotter) |
|---|---|---|
| 平台 | 仅 Windows | 任意设备，电脑/手机/平板浏览器打开即用 |
| 安装 | 每台机器装一次 | 免安装，零前端构建 |
| 串口驱动 | 需装驱动 | 直接 `/dev/ttyACM0` 或 `/dev/ttyUSB0`，免驱动 |
| 原点模型 | 固定或隐式配置 | **支持四方位机器原点（右下/左下/右上/左上）+ 自动贴靠原点排版** |
| 下刀前确认 | 盲刻易超出材料 | **内置「⬚ 走框预览（巡边确认范围）」，抬刀沿外框空走一圈确认物理范围** |
| 离线输出 | 依赖 U 盘 | 局域网直接流式下发 + 历史任务一键重刻 |
| 依赖 | 商业软件 | **零运行时依赖**（仅用 Node.js 标准库） |

零依赖是刻意的设计：串口用 `stty` + 文件描述符而不是 `serialport`（后者带 C++ 扩展，在 ARM64 上要么没预编译、要么要交叉编译）。HTTP 用 `node:http`，WebSocket 实现了 RFC6455 最小版。**在板子上不需要 `npm install`，部署就是拷贝文件。**

---

## 快速开始

```bash
# 克隆
git clone https://github.com/dicsonpan/plotter-one.git
cd plotter-one

# 自检（286 项，验证几何/协议/状态机/四方位原点/消除Y轴空走/走框预览/双语，无需接真机）
npm run selftest

# i18n 体检（确认全部 364 条文案中英严格对齐）
node tools/i18n-check.js

# 启动服务
npm start
```

浏览器打开 `http://localhost:8080`。

要把它装到刻字机旁的小板子上，见下面的 **[部署](#部署)** 一节——只需一条命令（`sudo bash deploy/install.sh --port 8080`）。
8080 只是默认值；板子安装经常会改绑 **80 端口**，这样直接输 `http://<板子IP>/` 就能打开（需要在 systemd 单元里配 `AmbientCapabilities=CAP_NET_BIND_SERVICE`，见 `docs/`）。

图形怎么画、用什么软件画，见 [docs/设计工作流.md](docs/设计工作流.md)。

---

## 核心机制：机器原点位置、坐标映射与「走框预览」

### 1. 机器原点位置（`originPosition`）

不同类型、不同品牌的刻字机或雕刻机，其开机归位与面板对刀的**物理原点 `(0, 0)`** 所在的角落不同：
- **滚筒式刻字机（力宇 SC 系列、通用 1016、皮卡、图云、国产 DMPL 板卡等）**：操作者正对机器正面时，刀头小车停靠在**右手边（右下角，`bottom-right`）**，刻绘时刀头向左移动（横跨材料幅面）、走纸滚筒前后进退。
- **平板式 / 四轴雕刻机或特殊改装机型**：原点可能位于**左下角（`bottom-left`）**、**右上角（`top-right`）**或**左上角（`top-left`）**。

因此，机器预设库 `MACHINE_PRESETS`（`server/machine/hpgl.js`）为每台机器内置了 `originPosition` 字段，并与版面旋转角 `layoutRotate` 自动联动：

| 原点位置 (`originPosition`) | 物理含义 | 画布上的机械原点 `(mechOrigin)` | 对应版面旋转 (`layoutRotate`) |
|---|---|---|---|
| **`bottom-right`（右下）** | 刀头在右前角，向左进刀、向内走纸（滚筒刻字机默认） | `(width, 0)` | `90°` |
| **`bottom-left`（左下）** | 刀头在左前角，向右进刀、向内走纸（四轴/平板机默认） | `(0, 0)` | `0°` |
| **`top-right`（右上）** | 刀头在右后角，向左前方向进刀 | `(width, height)` | `180°` |
| **`top-left`（左上）** | 刀头在左后角，向右前方向进刀 | `(0, height)` | `270°` |

在前端界面右侧 **「设备连接 → ⚙ 设置 → 机器原点位置」** 下拉框中，可随时查看或切换当前机型的原点方位；画布上的 `机械 0,0`、红色 `原点 (0.0, 0.0)` 基准轴（箭头指向材料内部有效区）以及蓝色 `刀头` 准星会自动同步到对应角落。

### 2. 彻底消除「刻字前 Y 轴大幅空走」的三层坐标映射算法

在右下角原点（`bottom-right`，`layoutRotate = 90°`）的滚筒刻字机上，画布坐标 `(x, y)`（左下角为 `0,0`，`x` 向右 `0..W`，`y` 向上 `0..H`）到机器物理坐标 `(mx, my)` 的仿射映射为：

$$\text{mx} = y, \quad \text{my} = W - x$$

也就是说：**画布右下角 `(W, 0)` 对应机器物理原点 `(0, 0)`，而画布左下角 `(0, 0)` 对应机器 `my = W`（例如 600mm 机型上 `my = 600mm = 23622 步`）！**

此前版本在刻字前出现「Y 轴先空走 500~590mm」的根因正是前端排版与 CAM 默认把图形放在了画布左下角 `(10, 10)`。现已通过三层算法彻底解决：

1. **自动贴靠当前原点排版（前端导入/创建/属性层）**：
   - 导入 SVG / DXF / PLT 文件、添加「快速文字」或「图形」时，系统自动将图形贴靠到**当前原点内侧 10mm 处**（例如右下角原点机型上，图形右边缘位于 `W - 10`，下边缘位于 `10`，对应机器物理起点仅 `10mm × 10mm`）。
   - 左侧「对象属性」面板中的 `X / Y` 输入框直接显示并控制**图形距当前原点的边距**，并配有 **「🎯 贴靠当前原点 (留边10mm)」** 一键归位按钮。
2. **工作原点相对于机械原点偏移（`HpglBuilder._originShift`）**：
   - 当用户移动刀头并点击「设原点」建立自定义工作原点 `origin` 时，位移量严格按相对于机械原点 `mechOrigin = toUser(0, 0)` 计算（`shift = origin - mechOrigin`），而非相对于画布左下角 `(0, 0)` 计算，确保位于工作原点的图形始终精准映射为机器 `PU0,0;`。
3. **CAM 就近原点排序与闭合轮廓起刀角点旋转（`compileToolpath` & `rotateClosedSubpathsToNearest`）**：
   - `optimizeOrder` 的起始参考点从固定 `{x: 0, y: 0}` 改为当前生效原点（如右下角 `(W, 0)`），优先切割离原点最近的子路径。
   - 针对闭合多边形（如外框矩形 `<rect>` 默认以左端 `(minX, minY)` 为起点），新增 `rotateClosedSubpathsToNearest()` 在不改变顺/逆时针绕向和周长的前提下，将闭合环起点循环移位到**离当前原点最近的顶点**（如右下角顶点 `(maxX, minY)`），彻底避免刀头先横跨整幅矩形去左边起刀。

### 3. 「⬚ 走框预览（巡边确认范围）」功能

在真正落刀刻绘前，点击右侧输出区的 **「⬚ 走框预览（巡边确认范围）」** 按钮（调用 `POST /api/frame` 与 `buildFrameCommand()`）：

- **全程抬刀安全空走（绝不落刀）**：生成 `IN; PA; SP1; PU;` 初始化与强制抬刀指令，从待刻图形外接矩形中**离当前原点最近的角点**出发，使用 `PU x,y;` 依次走完外接矩形的四条边回到起点，最后发送 `PU0,0;` 回到对刀原点。指令流中**绝不包含任何 `PD` 落刀指令**，百分之百不会划伤材料。
- **真机巡边 + 画布高亮双反馈**：
  - 若设备已连接，立即作为高优先级任务下发给刻字机，用户可直接目视刀头在真实材料上划出的长宽范围，确认材料是否放正、尺寸是否超界。
  - 画布上同步以绿色虚线框高亮显示外框精确尺寸与距原点范围（例如 `走框范围 100.0×80.0mm (X:10~110, Y:10~90)`），并播放刀头巡边动画（未连接真机时也可在画布上预览范围）。

---

## 部署

把这个服务跑在一台小板子上（RK3399 级别，ARM64），放在刻字机旁边。
它几乎不挑环境：一台装了 Node.js 18+ 的 Linux，加一根 USB 转 RS-232 线（或直连 USB 线）就行。
**不需要 `npm install`、不需要构建**——部署就是拷文件。

### 你需要准备

- 一台跑 Linux 的板子（Armbian / Debian / Ubuntu，ARM64 或 x86 都行；RK3399 最合适，常驻 3-5W）。
- 一根 **USB 连接线** 或 **USB 转 RS-232** 线（±5V 电平）。
  ⚠️ 若走串口口，必须是 RS-232，**不是** USB-TTL（3.3V），电平不对会烧刻字机控制板。常见芯片：CH340、PL2303、FTDI、CP210x；力宇新款 USB 口直连识别为 GD32 CDC ACM（`/dev/ttyACM0`）。
- 刻字机通电，并用数据线连上板子。
- 同一局域网内任意手机/电脑/平板，用来打开网页界面。

### 第 1 步 — 让板子连上网

把 Armbian（或你用的发行版）刷到板子的 eMMC/SD，启动，用网线或 Wi-Fi 连到网络。
查到它的 IP（看路由器，或在板子上跑 `hostname -I`）。下文把它记作 `<板子IP>`。

### 第 2 步 — 装 Node.js 18+

登录板子（SSH），检查：

```bash
node -v     # 必须打印 v18.x 或更高
```

如果没装或版本太旧，装一下：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node -v     # 现在应该是 v20.x
```

第 4 步的一键安装脚本在缺 Node 时也会自动装，所以这一步可选——但先装好能少踩坑。

### 第 3 步 — 把工程弄到板子上

在板子上：

```bash
git clone https://github.com/dicsonpan/plotter-one.git
cd plotter-one
```

（或者从电脑用 `scp` / `rsync` 拷过去也行——因为没有构建步骤，两种方式都一样。）

### 第 4 步 — 跑安装脚本

```bash
sudo bash deploy/install.sh --port 8080
```

一条命令搞定所有事：

1. 缺 Node.js 18+ 就自动装。
2. 把工程拷到 `/opt/plotter-one`。
3. 建专用系统用户 `plotter` 并加入 `dialout` 组（串口访问权限）。
4. 装 systemd 服务：开机自启、崩溃自动重启。
5. 装 udev 规则，让串口可读写。
6. 放行防火墙端口。
7. 配 mDNS，能用 `hostname.local` 访问，免记 IP。

### 第 5 步 — 浏览器打开控制台

同一局域网内任意设备，打开：

```
http://<板子IP>:8080
```

如果局域网支持 mDNS，`http://armbian.local:8080` 也能用。应该能看到控制台界面。

### 第 6 步 — 连上刻字机

1. 把 USB 线插到板子和刻字机上。
2. 当仅检测到 1 个串口设备时，服务启动会自动连接，并每 3 秒巡检重连；若检测到多个串口设备，界面会自动展开端口列表提示你手动选择。
3. 验证是否连通：

   ```bash
   curl -s http://localhost:8080/api/state | grep -o '"connected":[a-z]*'
   # → "connected":true
   ```

#### 怎么找串口

插上线后：

```bash
dmesg | tail -20              # 看内核识别成 ttyUSB0 还是 ttyACM0
ls -l /dev/ttyUSB* /dev/ttyACM*
# 查芯片厂商
udevadm info -a -n /dev/ttyUSB0 | grep -E 'idVendor|idProduct'
```

#### 串口参数（力宇机器）

| 参数 | 值 |
|------|-----|
| 波特率 | 115200（默认，支持 9600~230400） |
| 数据位 | 8 |
| 停止位 | 1 |
| 校验 | 无 |
| 流控 | 无（传输不稳可试 RTS/CTS） |

#### 连不上怎么办

```bash
# 1. 权限问题（最常见）
ls -l /dev/ttyUSB0
# 应是 crw-rw---- 1 root dialout ...
sudo usermod -aG dialout plotter
sudo systemctl restart plotter-one

# 2. ModemManager 抢串口（Ubuntu/Debian 常见）
sudo systemctl stop ModemManager
sudo systemctl disable ModemManager

# 3. 被别的程序占用
sudo fuser -v /dev/ttyUSB0

# 4. 手动测串口通不通
sudo apt install minicom
sudo minicom -b 9600 -D /dev/ttyUSB0   # 回车看有没有回显
```

### 第 7 步 — 第一次刻（强烈建议先用「走框预览」）

1. **先走框预览**：导入图形或添加文字后，点击右侧 **「⬚ 走框预览（巡边确认范围）」**，刀头会在抬刀状态下沿图形外接矩形空走一圈并回到原点，直观确认刻字位置和大小。
2. **确认无误再开始刻绘**：点击「生成指令」→「开始刻绘」。

### 日常运维与升级

```bash
systemctl status plotter-one      # 看状态
systemctl restart plotter-one     # 改了配置后重启
journalctl -u plotter-one -f      # 跟日志
```

配置保存在 `/opt/plotter-one/data/config.json`，历史记录保存在 `/opt/plotter-one/data/history.json`。

升级命令：

```bash
cd plotter-one
git pull
sudo systemctl stop plotter-one
sudo rsync -av --exclude node_modules --exclude data/ ./ /opt/plotter-one/
sudo systemctl start plotter-one
```

卸载命令：

```bash
sudo bash deploy/uninstall.sh          # 保留配置
sudo bash deploy/uninstall.sh --purge   # 彻底清除
```

---

## 支持的机器预设

力宇 SC 系列（SC631-AU / SC631E / SC630 / SC801 / SC1261）及其他兼容 HP-GL / DMPL 的刻字机：

| 机型 ID | 名称 | 预设幅面 | 分辨率 (步/英寸) | 默认原点位置 (`originPosition`) | 说明 |
|---|---|---|---|---|---|
| **`liyue-sc631-au`** | **力宇 SC631-AU** | 600 × 710 mm | 1000 | `bottom-right`（右下） | 保守设定，见下方「⚠️ 幅面」 |
| `liyue-sc631e` | 力宇 SC631E / SC631-AU (630mm) | 630 × 710 mm | 1000 | `bottom-right`（右下） | 仅在铭牌确认为 630mm 时使用 |
| `liyue-sc630` | 力宇 SC630 / SC631E | 630 × 710 mm | 1000 | `bottom-right`（右下） | 标准 630mm 幅面 |
| `liyue-sc801` | 力宇 SC801 / SC801E | 800 × 880 mm | 1000 | `bottom-right`（右下） | 800mm 幅面 |
| `liyue-sc1261` | 力宇 SC1261 / SC1261E | 1260 × 1340 mm | 1000 | `bottom-right`（右下） | 1260mm 大幅面 |
| `generic-1016-600` | 通用 1016（600mm 刻绘宽） | 600 × 710 mm | 1016 | `bottom-right`（右下） | 皮卡/精卡/酷刻/图云等 1016 步/英寸机型 |
| `generic-hpgl-1016` | 通用 HPGL 刻字机 | 630 × 710 mm | 1016 | `bottom-right`（右下） | 标准 HPGL 分辨率（40 步/mm） |
| `generic-dmpl` | 通用 DMPL 割字机 | 630 × 710 mm | 1016 | `bottom-right`（右下） | 金谷田 / 赛博等国产 DMPL 语言板卡 |
| `liyue-4axis` | 力宇四轴 / 伺服刻字机（3D） | 800 × 880 mm | 4060 | `bottom-left`（左下） | 平板 3D 机型，支持 `FS` 刀压指令 |

**分辨率**：力宇标注 0.0254mm/step 即 1000 步/英寸。本服务在上位机通过 `toPlotterUnits()` 精确换算为机器脉冲整数步进，直发原生 HP-GL 坐标。
**注意：卷筒刻字机绝不能下发 `SC`（缩放）指令**——卷筒纸轴无物理上限（$P2_y = 0$），发 `SC` 会导致固件将缩放比例归零，使走纸完全失去响应。

### ⚠️ 幅面宽度为什么取 600 而不是 630

SC631-AU 的「最大刻绘宽度」在不同厂商资料里有 600 / 615 / 630 三种说法。
本项目**默认取最小值 600mm**：幅面设小只是排版受限，设大了是**刀走出材料、撞机甚至断刀**。若机身铭牌确认为 630mm，在界面「机器型号」里改选 `liyue-sc631e` 预设即可。

---

## 真机验证记录

本项目的坐标轴、原点与通信逻辑均**在力宇 SC631-AU 实机上反复调试验证**。

### 已确认的机器事实

| 项 | 实测结果 |
|---|---|
| 物理原点位置 | 正对机器正面时的**右下角**（`originPosition = 'bottom-right'`） |
| 步进分辨率 | 1000 步/英寸（0.0254mm/step），进口/皮卡系为 1016 步/英寸 |
| 串口 | `/dev/ttyACM0`，115200 8N1，无流控 |
| 初始坐标基准 | 以机身面板【原点】为 $(0,0)$，任务开头**绝不发 `!PG;`** |
| **版面朝向** | 右下角原点机型需顺时针旋转 90° 补偿（`layoutRotate = 90`） |

对应到标准配置：

```
originPosition = 'bottom-right' ← 原点在右下角（画布 (W, 0) 映射为机器 (0, 0)）
swapAxes       = false          ← 不交换轴（不镜像）
axisX          = 1              ← 正向
axisY          = 1              ← 正向
layoutRotate   = 90             ← 补偿版面朝向（顺时针 90°）
```

> 🔴 **`layoutRotate`（旋转）和 `swapAxes`（镜像）是两件完全不同的事**
>
> | 参数 | 管什么 | 填错的表现 |
> |---|---|---|
> | `swapAxes` | 图形是否**镜像**（行列式 = -1） | 左右/上下颠倒（文字反写） |
> | `axisX / axisY` | 每根轴**往哪边是正** | 单轴镜像 |
> | `layoutRotate` / `originPosition` | 整块版面**转多少度**（行列式 = +1） | 方向全对、不镜像，只是整版旋转了 90°/180°/270° |

### 实机确认的固件行为与安全护栏

| 行为 | 说明与本项目的处理 |
|---|---|
| **必须先发 `IN;`** | 冷启动后固件处于未初始化状态，没有 `IN;` 会**静默忽略所有运动指令**。所有任务、走框预览和手动指令开头均强制带 `IN;` |
| **机器零回执（单工链路）** | 力宇 GD32 CDC 固件对 `OI;`/`OA;`/`IN;` 全部无应答——纯单工。「完成」按运动学仿真推算，连接卡片与任务日志均明示「单向通信」 |
| **固件停摆时 `write()` 无限阻塞** | USB 端点停止 re-arm 后驱动会卡在 NAK 背压里。内置 **5 秒写入看门狗**，超时自动断开并报双语错误 |
| **从不发 `SC` 与 `LT;`** | 卷筒机发 `SC` 会导致缩放除零瘫痪；上位机直接换算整数脉冲，一条 `SC` 都不发 |
| **空移必须用 `PU x,y;`** | 部分国产固件将 `PA;` 仅作为模态指令，忽略 `PA x,y;` 的坐标参数；本项目空移统一用 `PU x,y;`，切割统一用 `PD x,y;`（对齐文泰 `WritePlt`） |
| **单行不超过 64 字节** | GD32 USB 全速 CDC OUT 缓冲为 64 字节，超长行自动拆分为等价短指令，杜绝跨包丢数据 |
| **绝不默认发 `!PG;` 或 `SP0;`** | `!PG;` 会冲毁对刀原点并撞限位；`SP0;` 会让部分固件脱机拒动。收尾与回原点统一使用 `PU0,0;` |

---

## 功能一览

### ⬚ 走框预览（巡边确认范围）
- **一键真机巡边**：在「开始刻绘」前点击 **「⬚ 走框预览（巡边确认范围）」**，刀头保持**抬刀状态（`PU`）**从离原点最近的角点出发，沿待刻图形外接矩形走一圈后回到原点 `(0, 0)`。
- **画布尺寸与范围标注**：画布同步显示绿色虚线外框、长宽尺寸（`W×H mm`）以及相对于当前原点的坐标跨度（`X: offsetX~reachX, Y: offsetY~reachY`），让用户对实际刻绘范围心中有数。

### 🎯 四方位机器原点与一键贴靠原点
- **支持切换原点方位**：内置右下（`bottom-right`）、左下（`bottom-left`）、右上（`top-right`）、左上（`top-left`）四种机器原点模式。
- **自动贴靠原点排版**：导入矢量图、生成快速文字或基础图形时，自动放置于当前原点内侧 10mm 处；属性面板支持 **「🎯 贴靠当前原点 (留边10mm)」** 一键对齐，彻底告别刻字前 Y 轴大幅空走。

### 🪄 图片矢量化与 AI 降噪平滑（内置免装工具）
- **告别外部软件**：无需 Illustrator / CorelDRAW / Inkscape，浏览器内一站式完成「图片上传 ➔ 降噪矢量化 ➔ 自动贴靠原点 ➔ 下发刻绘」。
- **专为 AI 生图与线稿去噪设计**：采用**双边保边滤波 + 孤岛面积过滤（Turdsize）**，从源头消灭散斑噪点，杜绝电机震颤与反复抬落刀。
- **单线中心线骨架（Centerline）与轮廓描边（Outline）双模式**：既支持提取 1px 单笔中心线（配骨架毛刺修剪 Spur Pruning），也支持闭合外轮廓描边。

### 📐 导入、编辑与 CAM 优化
- **全格式矢量导入**：支持 DXF / SVG / PLT / HP-GL，完整支持 SVG `<path>`、`<circle>`、`<rect>`、`<ellipse>`、`<line>`、`<polyline>`、`<polygon>` 及嵌套 `<g>` 矩阵变换。
- **编组与解组（Group / Ungroup）**：多选图层一键编组或解组，变换时子图元实时同步。
- **两级几何抽稀与除杂点（De-speckle）**：导入层自动剔除 `<1.0mm` 微小噪点浮岛；CAM 层采用 0.02mm 容差 RDP 抽稀与共线合并，将数十万点密集路径压缩 70%~95%。
- **闭合过切补偿（Overcut）**：闭合路径切回起点后顺延多切 `0.3mm`（对齐文泰 `SetCutterCloseAddDist`），防止起收刀处留连皮，方便排废。
- **历史任务归档与模板重刻**：每次刻绘自动保存图层、原点、机型、材料、速度、刀压与矢量缩略图，支持随时调出修改或一键重刻。

---

## 资源占用與精度

在 **RK3399 / Armbian（4GB + 15GB eMMC）** 上实测：
- **磁盘占用**：约 **450 KB**（零 npm 依赖，无需 `npm install`）
- **内存占用**：空闲常驻约 **43 MB**
- **CPU 占用**：空闲 **< 1%**，输出中约 **1~3%**，被动散热温度约 **45°C**
- **几何往返精度**：HP-GL 编译再解析回读的长度误差仅 **0.0115%**（800mm 幅面上约 0.08mm），比机器标称机械重复精度（0.127mm）高一个数量级。

---

## 国际化（中英双语）

界面支持中英双语，点击顶栏 `中 / EN` 按钮即时切换，首次访问按浏览器语言自动匹配并记忆在 `localStorage`。

```bash
node tools/i18n-check.js
```

体检脚本自动校验全部 **364 条**中英文词条是否齐全、占位符是否一致、HTML 与 JS 引用的 key 是否全部存在、以及代码中是否残留未翻译文案。

---

## 项目结构

```
plotter-one/
├── server/
│   ├── index.js              HTTP 路由 + WebSocket + /api/frame 走框预览接口
│   ├── selftest.js           286 项端到端自检（无需真机）
│   ├── geom/path.js          几何内核（路径/矩阵/抽稀/除杂点/最近邻排序）
│   ├── cam/
│   │   ├── toolpath.js       刀路计算（原点就近排序 + 闭合环起点旋转 + 幅面校核）
│   │   └── textToPath.js     内置单线字体转路径
│   ├── machine/
│   │   ├── hpgl.js           HP-GL / DMPL 生成 + 四方位原点 + 走框指令 + 机型预设
│   │   ├── transport.js      串口 / TCP / 虚拟机传输层（含 5s 写入看门狗）
│   │   ├── jobEngine.js      任务队列、分块流式下发与运动学双阶段进度跟踪
│   │   ├── manual.js         手动控制指令生成
│   │   └── calibrate.js      安全微动（诊断用）
│   ├── import/               DXF / SVG / HPGL 解析器
│   └── api/httpKit.js        HTTP 工具 + 最小 RFC6455 WebSocket 实现
├── web/                      前端（原生 ES module，零构建）
│   ├── index.html            主界面
│   ├── css/app.css           样式表
│   ├── js/app.js             主应用逻辑（含原点坐标换算、自动贴靠原点、走框预览）
│   ├── js/render.js          Canvas 渲染器（动态四角原点、刀头准星、走框高亮与动画）
│   ├── js/transform.js       图形几何变换
│   ├── js/vectorizer.js      内置 AI 降噪图片矢量化引擎
│   ├── js/i18n.js            中英双语词典（364 条）与切换逻辑
│   └── geom.js               几何内核副本（与 server/geom/path.js 同步）
├── tools/i18n-check.js       双语完整性体检脚本
├── deploy/                   安装 / 卸载 / 同步脚本
└── docs/
    └── 设计工作流.md
```

---

## 开发与自检

```bash
npm run selftest           # 运行全部 286 项自检，不需要接机器
node tools/i18n-check.js   # 运行双语词典体检（364 条）
npm start                  # 启动服务（默认 8080 端口）
npm start -- --port 9000   # 指定端口启动
```

**修改 `server/geom/path.js` 后请同步到前端 `web/geom.js`**：

```bash
./deploy/sync-geom.sh
```

---

## License

MIT
