# Engraving Machine Web Console (SparkPlotter / plotter-one)

**[中文](README.zh.md)** | English

Move Windows-only engraving output software (Ucancam / UcanSign, 文泰刻绘) into a browser.
One low-power board plugged in next to the machine; any device on the LAN opens it in a browser — Windows, Mac, iPad, Android phone, even a bare thin client with nothing installed.

```
                 same LAN
   ┌────────┐  ┌────────┐  ┌────────┐
   │  PC    │  │ phone  │  │ tablet │     browser, no software to install
   └────┬───┘  └───┬────┘  └───┬────┘
        └──────────┴───────────┘
                   │ HTTP + WebSocket
                   ▼
        ┌──────────────────────┐
        │  RK3399 / any ARM64  │   3-5W idle
        │  Node.js, zero deps  │
        └──────────┬───────────┘
                   │ USB / RS-232 115200 8N1
                   ▼
            engraving machine
```

---

## Why

| | Ucancam / UcanSign / 文泰 | This (SparkPlotter) |
|---|---|---|
| Platform | Windows only | Any device (PC, Mac, phone, tablet browser) |
| Install | Once per machine | Zero install, zero frontend build |
| Serial driver | Must install drivers | Direct `/dev/ttyACM0` or `/dev/ttyUSB0`, driverless |
| Origin model | Fixed or opaque | **4-Corner Machine Origin (`originPosition`) + Auto Snap-to-Origin** |
| Area verification | Blind cutting risks running off material | **Built-in "⬚ Frame Check" traces bounds with blade up before cutting** |
| Offline output | Needs a USB stick | Direct LAN streaming + 1-click job history re-cut |
| Dependencies | Commercial software | **Zero runtime deps** (Node.js standard library only) |

Zero dependencies is deliberate: the serial port uses `stty` + file descriptors rather than `serialport` (which ships C++ extensions that either lack ARM64 prebuilds or require a cross-compiler). HTTP is `node:http`; WebSocket is a minimal RFC6455 implementation. **No `npm install` is needed on the board — deploying means copying files.**

---

## Quick start

```bash
# clone
git clone https://github.com/dicsonpan/plotter-one.git
cd plotter-one

# self-test (329 checks, incl. byte-exact regression snapshots for Liyu output and the SparkPlotter-GZ protocol)
npm run selftest

# i18n audit (verify all 364 strings have both zh and en)
node tools/i18n-check.js

# start
npm start
```

Open `http://localhost:8080`.

To run it on a board next to the engraver, see **[Deployment](#deployment)** below — it is one command (`sudo bash deploy/install.sh --port 8080`). 8080 is only the default; a board install will often bind **port 80** instead so you can reach it as bare `http://<board-ip>/` (that needs `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the unit — see `docs/`).

For how to design artwork, see [docs/设计工作流.md](docs/设计工作流.md).

---

## Core Architecture: Machine Origin Positions, Coordinate Mapping & Frame Check

### 1. Machine Origin Position (`originPosition`)

Different vinyl cutters and flatbed engravers place their physical `(0, 0)` origin at different corners of the working area:
- **Roll-fed vinyl cutters (Liyue SC series, Generic 1016, Pcut, Jinka, domestic DMPL boards)**: Standing in front of the machine, the cutting carriage parks at the **front-right (`bottom-right`)** corner. During cutting, the carriage moves left across the media width while the roller feeds material in and out.
- **Flatbed / 4-axis engravers or custom machines**: The origin may be at **`bottom-left`**, **`top-right`**, or **`top-left`**.

Every machine preset in `MACHINE_PRESETS` (`server/machine/hpgl.js`) includes an `originPosition` property paired with `layoutRotate`:

| `originPosition` | Physical Meaning | Canvas Mechanical Origin (`mechOrigin`) | `layoutRotate` |
|---|---|---|---|
| **`bottom-right`** | Head at front-right, cuts left & feeds inward (default for roll-fed cutters) | `(width, 0)` | `90°` |
| **`bottom-left`** | Head at front-left, cuts right & feeds inward (default for 4-axis/flatbed) | `(0, 0)` | `0°` |
| **`top-right`** | Head at back-right | `(width, height)` | `180°` |
| **`top-left`** | Head at back-left | `(0, height)` | `270°` |

You can view or switch the active origin position anytime under **Device → ⚙ Settings → Origin position**. The canvas automatically moves the `Machine 0,0` marker, red `Origin (0.0, 0.0)` datum axes (pointing inward into the material), and blue `Knife` crosshair to the corresponding corner.

### 2. Eliminating Pre-Cut Y-Axis Travel (Three-Layer Fix)

On a `bottom-right` roll-fed cutter (`layoutRotate = 90°`), canvas coordinates `(x, y)` (where `(0, 0)` is Bottom-Left, `x` runs `0..W` left-to-right, `y` runs `0..H` bottom-to-top) map to physical machine coordinates `(mx, my)` via:

$$\text{mx} = y, \quad \text{my} = W - x$$

This means **Canvas Bottom-Right `(W, 0)` maps to Machine `(0, 0)`**, whereas **Canvas Bottom-Left `(0, 0)` maps to `my = W`** (e.g. `600mm = 23,622 steps` on a 600mm cutter!).

Previously, imported files and text were placed near Canvas Bottom-Left `(10, 10)`, forcing the Y-axis to travel 560–590mm across the entire width before cutting. This is now solved across three layers:

1. **Automatic Origin-Relative Placement & Snap-to-Origin (`snapLayersToOrigin`)**:
   - Imported SVG/DXF/PLT files, Quick Text, and Shapes are automatically placed **10mm inside the active origin corner** (e.g., `maxX = W - 10, minY = 10` for `bottom-right`, resulting in just `10mm × 10mm` of initial travel).
   - The `X / Y` inputs in the Properties panel display and control the item's distance from the active origin, accompanied by a one-click **"🎯 Snap to Origin (10mm margin)"** button.
2. **Mechanical-Origin-Relative Work Origin Shift (`HpglBuilder._originShift`)**:
   - When a custom work origin (`userOrigin`) is set via "Set Origin", `HpglBuilder.build()` computes the shift relative to `mechOrigin = toUser(0, 0)` (`shift = origin - mechOrigin`) rather than `(0, 0)`, ensuring a point at `userOrigin` always maps strictly to `PU0,0;`.
3. **Origin-Aware CAM Ordering & Closed-Loop Start Vertex Rotation (`rotateClosedSubpathsToNearest`)**:
   - `optimizeOrder` starts from the active origin corner (`(W, 0)` for `bottom-right`) rather than `(0, 0)`.
   - For closed polygon loops (such as `<rect>` borders whose default first vertex is `(minX, minY)` on the far left), `rotateClosedSubpathsToNearest()` cyclically shifts the starting vertex to the corner **nearest to the active origin** (preserving winding direction and perimeter), eliminating unnecessary cross-shape rapid travel.

### 3. "⬚ Frame Check (Trace Bounds)" (`POST /api/frame` & `buildFrameCommand`)

Before starting an actual cut, click **"⬚ Frame Check (Trace Bounds)"** in the Output section:
- **100% Blade-Up Bounding Box Trace**: Emits `IN; PA; SP1; PU;` and traces the 4 corners of the artwork's outer bounding box using `PU x,y;` starting from the corner nearest to the origin, then returns to `PU0,0;`. It **never emits a single `PD` command**, so the blade remains safely lifted the entire time.
- **Physical + Canvas Visual Feedback**:
  - When connected to the plotter, it immediately runs as a priority job so you can watch the blade tip trace the exact cutting rectangle on the physical material.
  - Simultaneously, the canvas highlights the dashed green framing rectangle with exact dimensions and origin offset range (e.g., `Frame Range 100.0×80.0mm (X:10~110, Y:10~90)`) and animates the toolhead trace.

---

## Deployment

Run this service on a small board (RK3399-class, ARM64) that sits next to the engraver.
It asks for almost nothing: a Linux box with Node.js 18+, plus a USB cable or USB-to-RS-232 cable.
There is **no `npm install` and no build step** — deploying means copying files.

### What you need

- A board running Linux (Armbian / Debian / Ubuntu). ARM64 or x86 both work; an RK3399 is the sweet spot at 3-5W idle.
- A **USB cable** (for direct USB CDC-ACM `/dev/ttyACM0`) or **USB-to-RS-232** cable (±5V signal level, CH340 / PL2303 / FTDI / CP210x).
- The engraver powered on and linked to the board with that cable.
- Any phone / PC / tablet on the same LAN to open the web UI.

### Step 1 — Get the board on the network

Flash Armbian (or your distro) onto the board's eMMC/SD card, boot it, and connect it to your network over Ethernet or Wi-Fi. Find its IP address (`hostname -I`).

### Step 2 — Install Node.js 18+

```bash
node -v     # must print v18.x or newer
```

### Step 3 — Copy the project & run the installer

```bash
git clone https://github.com/dicsonpan/plotter-one.git
cd plotter-one
sudo bash deploy/install.sh --port 8080
```

### Step 4 — Open the console & run a Frame Check

Open `http://<board-ip>:8080` in any browser on the LAN, import or add a test shape, and click **"⬚ Frame Check (Trace Bounds)"** to verify the physical area on your machine before cutting.

---

## Supported machines

| Preset ID | Model | Preset bed | Resolution (steps/in) | Default `originPosition` | Notes |
|---|---|---|---|---|---|
| **`liyue-sc631-au`** | **Liyue SC631-AU** | 600 × 710 mm | 1000 | `bottom-right` | Conservative default |
| `liyue-sc631e` | Liyue SC631E / SC631-AU (630mm) | 630 × 710 mm | 1000 | `bottom-right` | Use after confirming 630mm nameplate |
| `liyue-sc630` | Liyue SC630 / SC631E | 630 × 710 mm | 1000 | `bottom-right` | Standard 630mm width |
| `liyue-sc801` | Liyue SC801 / SC801E | 800 × 880 mm | 1000 | `bottom-right` | 800mm plot width |
| `liyue-sc1261` | Liyue SC1261 / SC1261E | 1260 × 1340 mm | 1000 | `bottom-right` | 1260mm plot width |
| `generic-1016-600` | Generic 1016 (600mm) | 600 × 710 mm | 1016 | `bottom-right` | 1016 steps/inch (40 steps/mm) |
| `generic-hpgl-1016` | Generic HPGL engraver | 630 × 710 mm | 1016 | `bottom-right` | Standard HPGL resolution |
| `generic-dmpl` | Generic DMPL cutter | 630 × 710 mm | 1016 | `bottom-right` | Domestic DMPL boards |
| `liyue-4axis` | Liyue 4-axis / servo (3D) | 800 × 880 mm | 4060 | `bottom-left` | 3D flatbed, supports `FS` force |
| **`sparkplotter-gz`** | **SparkPlotter-GZ (600mm)** | 600 × 710 mm | 1016 | `bottom-right` | Private `skm` text protocol, 9600 baud, one-way link (no replies) |

### Dialect architecture

Geometry (`HpglBuilder`) is shared by every machine; only the **wire protocol** differs.
`server/machine/dialects.js` is a registry of adapters (`hpgl` / `hpgl3d` / `dmpl` / `skm`)
that own initialization, move/draw bytes, serialization, job-end markers and link semantics.
To add a machine: add a preset if it speaks an existing dialect, otherwise add one adapter.
`npm run selftest` holds byte-exact golden snapshots of all legacy Liyu/DMPL output.

**SparkPlotter-GZ (`skm`) still needs on-site calibration** (as of 2026-11-12): the 710mm feed
length is provisional, axis directions / layout rotation are uncalibrated, and the `F{x}` value
in the job-end marker `U F{x} @ ` is assumed to be the last point's feed-axis coordinate.
Run a **Frame Check** before cutting anything large. This protocol has no relative-move or
set-origin command, so manual-control coordinates are accumulated in server memory and reset
on restart or machine switch.

---

## Project structure

```
plotter-one/
├── server/
│   ├── index.js              HTTP routes + WebSocket + POST /api/frame
│   ├── selftest.js           329 end-to-end self-checks (incl. byte-exact Liyu regression, no hardware)
│   ├── geom/path.js          geometry kernel (paths / matrices / RDP / de-speckle / ordering)
│   ├── cam/
│   │   ├── toolpath.js       toolpath engine (origin-aware ordering + closed-loop vertex rotation)
│   │   └── textToPath.js     single-stroke font → paths
│   ├── machine/
│   │   ├── hpgl.js           geometry layer: transforms / primitives / frame check + presets
│   │   ├── dialects.js       protocol layer: dialect registry (HP-GL / 3D / DMPL / skm)
│   │   ├── transport.js      serial / TCP / virtual plotter (with 5s write watchdog)
│   │   ├── jobEngine.js      job queue + chunked streaming + kinematic progress tracking
│   │   ├── manual.js         manual control commands
│   │   └── calibrate.js      safe micro-move helper (diagnostics)
│   ├── import/               DXF / SVG / HPGL parsers
│   └── api/httpKit.js        HTTP helpers + minimal RFC6455 WebSocket implementation
├── web/                      front end (native ES modules, zero build)
│   ├── index.html            main UI
│   ├── css/app.css           stylesheet
│   ├── js/app.js             main logic (origin-relative coords, auto-snap, frame check)
│   ├── js/render.js          Canvas renderer (dynamic origin corner, knife crosshair, frame box)
│   ├── js/transform.js       geometry transforms
│   ├── js/vectorizer.js      built-in AI-denoise bitmap vectorizer
│   ├── js/i18n.js            bilingual dictionary (364 keys) + language switcher
│   └── geom.js               geometry kernel copy (synced from server/geom/path.js)
├── tools/i18n-check.js       i18n audit script
├── deploy/                   install / uninstall / sync scripts
└── docs/
    └── 设计工作流.md
```

---

## Development

```bash
npm run selftest         # 329 self-checks, no machine required
node tools/i18n-check.js # i18n audit (364 keys)
npm start                # default port 8080
npm start -- --port 9000
```

**After editing `server/geom/path.js`, sync it to the web side**:

```bash
./deploy/sync-geom.sh
```

---

## License

MIT
