# Engraving Machine Web Console

Move Windows-only engraving output software (Ucancam / UcanSign, 文泰刻绘) into a browser.
One board plugged in next to the machine; any device on the LAN opens it in a browser —
Windows, Mac, iPad, Android phone, even a bare thin client with nothing installed.

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
                   │ RS-232 9600 8N1
                   ▼
            engraving machine
```

**[中文](README.zh.md)**

---

## Why

| | Ucancam / UcanSign / 文泰 | This |
|---|---|---|
| Platform | Windows only | Any device, including phones |
| Install | Once per machine | Just open a browser |
| Serial driver | Must install drivers | Direct `/dev/ttyACM0`, no driver |
| Offline output | Needs a USB stick | Sent directly |
| Dependencies | Commercial software | **Zero runtime deps** (Node standard library only) |

Zero dependencies is deliberate: the serial port uses `stty` + file descriptors rather
than `serialport` (which ships C++ extensions that either lack ARM64 prebuilds or require
a cross-compiler). HTTP is `node:http`; the WebSocket is a minimal RFC6455 implementation.
**No `npm install` is needed on the board — deploying means copying files.**

---

## Quick start

```bash
# clone
git clone https://github.com/dicsonpan/plotter-one.git
cd plotter-one

# self-test (217 checks: geometry / protocol / state machine / axes / i18n — no machine needed)
npm run selftest

# i18n audit (verify every string has both zh and en)
node tools/i18n-check.js

# start
npm start
```

Open `http://localhost:8080`.

To run it on a board next to the engraver, see **[Deployment](#deployment)** below — it is one command (`sudo bash deploy/install.sh --port 8080`).

For how to design artwork, see [docs/设计工作流.md](docs/设计工作流.md).

---

## Deployment

Run this service on a small board (RK3399-class, ARM64) that sits next to the engraver.
It asks for almost nothing: a Linux box with Node.js 18+, plus a USB-to-RS-232 cable.
There is **no `npm install` and no build step** — deploying means copying files.

### What you need

- A board running Linux (Armbian / Debian / Ubuntu). ARM64 or x86 both work; an RK3399 is the sweet spot at 3-5W idle.
- A **USB-to-RS-232** cable (±5V signal level).
  ⚠️ It must be RS-232, **not** USB-TTL (3.3V). The wrong level can damage the engraver's control board.
  Common chips: CH340, PL2303, FTDI, CP210x.
- The engraver powered on and linked to the board with that cable.
- Any phone / PC / tablet on the same LAN to open the web UI.

### Step 1 — Get the board on the network

Flash Armbian (or your distro) onto the board's eMMC/SD card, boot it, and connect it to your
network over Ethernet or Wi-Fi. Find its IP address (check your router, or run `hostname -I`
on the board). We'll call it `<board-ip>` below.

### Step 2 — Install Node.js 18+

Log into the board over SSH and check:

```bash
node -v     # must print v18.x or newer
```

If it prints nothing or an old version, install it:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node -v     # should now be v20.x
```

The installer in Step 4 also installs Node for you if it is missing, so this step is optional —
but doing it explicitly means fewer surprises.

### Step 3 — Copy the project onto the board

On the board:

```bash
git clone https://github.com/dicsonpan/plotter-one.git
cd plotter-one
```

(Or copy the folder over with `scp` from your computer — either works, because there is no build.)

### Step 4 — Run the installer

```bash
sudo bash deploy/install.sh --port 8080
```

One command does everything:

1. Installs Node.js 18+ if missing.
2. Copies the project to `/opt/plotter-one`.
3. Creates a dedicated `plotter` system user and adds it to the `dialout` group (serial-port access).
4. Installs a systemd service that starts on boot and auto-restarts if it crashes.
5. Installs udev rules so the serial port is readable/writable.
6. Opens the firewall port.
7. Sets up mDNS so you can reach it as `hostname.local` instead of memorising an IP.

### Step 5 — Open the console in a browser

On any device in the same LAN, open:

```
http://<board-ip>:8080
```

If mDNS works on your network, `http://armbian.local:8080` also works. You should see the console.

### Step 6 — Connect the engraver

1. Plug the USB-RS-232 cable into the board and the engraver.
2. In the UI's **Device** section, pick the serial port — usually `/dev/ttyUSB0` or `/dev/ttyACM0`.
3. The service auto-connects on boot and retries every 3 seconds, so you normally don't need to click anything.
4. Verify it is live:

   ```bash
   curl -s http://localhost:8080/api/state | grep -o '"connected":[a-z]*'
   # → "connected":true
   ```

#### How to find the serial port

After plugging in the cable:

```bash
dmesg | tail -20              # did the kernel see it as ttyUSB0 / ttyACM0?
ls -l /dev/ttyUSB* /dev/ttyACM*
# check the chip vendor
udevadm info -a -n /dev/ttyUSB0 | grep -E 'idVendor|idProduct'
```

Pick whatever appears in the dropdown in the UI.

#### Serial parameters (Liyue machines)

| Parameter | Value |
|-----------|-------|
| Baud rate | 9600 |
| Data bits | 8 |
| Stop bits | 1 |
| Parity    | none |
| Flow ctrl | none (try RTS/CTS if transfer is unstable) |

These are the UI defaults.

#### If the device won't connect

```bash
# 1. Permission problem (most common)
ls -l /dev/ttyUSB0
# should be crw-rw---- 1 root dialout ...
sudo usermod -aG dialout plotter
sudo systemctl restart plotter-one

# 2. ModemManager is grabbing the port (common on Ubuntu/Debian)
sudo systemctl stop ModemManager
sudo systemctl disable ModemManager

# 3. Another program is holding the port
sudo fuser -v /dev/ttyUSB0

# 4. Test the port by hand
sudo apt install minicom
sudo minicom -b 9600 -D /dev/ttyUSB0   # press Enter, see if it echoes
```

#### RS-232 cable notes

- **Length**: beyond ~10-15 m data starts dropping. If the engraver is far, extend the USB side or use an RS-232 repeater.
- **Crossover vs straight**: RS-232 is crossover (DTE-DCE). If unsure, try swapping TX/RX once.
- **Ground**: must be common; a floating ground causes garbage or lost data.
- **Shielding**: use a shielded cable to reduce motor interference.

### Step 7 — Your first cut (do this safely)

1. **Dry run first**: with no material on the bed, build a small 50mm square and send it; watch the tool-path direction.
2. Axis direction and layout rotation are already confirmed on real hardware and locked into the machine presets — don't change them in daily use (wrong values mirror or topple the whole design).
3. Only load material after the direction looks correct.

### Making the LAN friendlier

**Fixed IP** — edit `/etc/network/interfaces`:

```
auto eth0
iface eth0 inet static
    address 192.168.1.100
    netmask 255.255.255.0
    gateway 192.168.1.1
```

**mDNS (no IP to remember)** — the installer already sets up avahi, so `http://armbian.local:8080`
works. On a phone, an mDNS browser (Bonjour on iOS, a similar tool on Android) resolves it.

**Add to home screen** — open the console in the phone browser → Share → "Add to Home Screen".
It then opens full-screen from the desktop icon, like a native app.

### Daily operations

```bash
systemctl status plotter-one      # is it running?
systemctl restart plotter-one     # restart after a config change
journalctl -u plotter-one -f      # follow the logs
```

Config lives at `/opt/plotter-one/data/config.json`; restart the service after editing it.

### Upgrade

```bash
cd plotter-one
git pull
sudo systemctl stop plotter-one
sudo rsync -av --exclude node_modules --exclude data/ ./ /opt/plotter-one/
sudo systemctl start plotter-one
```

### Uninstall

```bash
sudo bash deploy/uninstall.sh          # keep your config
sudo bash deploy/uninstall.sh --purge   # remove everything
```

---

## Supported machines

Liyue SC series (SC631-AU / SC631E / SC801 / SC1261) and other HP-GL compatible engravers.

| Model | Preset bed | Notes |
|---|---|---|
| **Liyue SC631-AU** | 600 × 710 mm | Conservative default, see "⚠️ Bed width" below |
| Liyue SC631E | 630 × 710 mm | Use only after confirming a 630mm nameplate |
| Liyue SC801 / SC801E | 800 × 880 mm | |
| Liyue SC1261 / SC1261E | 1260 × 1340 mm | |
| Generic HPGL | 630 × 710 mm | 1016 units/inch |
| Liyue 4-axis / servo (3D) | 800 × 880 mm | |

**Resolution**: Liyue specs 0.0254mm/step, i.e. 1000 steps/inch. This service converts
precisely to integer machine pulses via `toPlotterUnits()` and emits native HP-GL coordinates.

> ⚠️ **Never send `SC` (scale) to a roll-feed engraver.** The roll has no fixed physical
> Y limit ($P2_y = 0$); sending `SC` makes the firmware compute a Y scale factor of zero,
> which kills the feed axis entirely and corrupts X motion as well.

### ⚠️ Why the bed width is 600 and not 630

Vendors list the SC631-AU "max plot width" as 600, 615, or 630 mm depending on the source.
This project **defaults to the smallest value, 600mm**: a too-small bed only constrains
layout, a too-large one sends the tool off the material into the machine — or breaks the blade.

If your nameplate confirms 630mm, just switch to the SC631E preset in the UI.

### ⚠️ Axis directions and the origin datum

**The engraver is based on the origin the operator sets on the material:**
1. The operator nudges the tip to a material corner with the panel's direction keys.
2. They press the panel's **Origin** button; that physical position becomes local $(0, 0)$.
3. Jobs start from $(0, 0)$ and cut forward. A job **never sends `!PG;` mechanical homing
   at the start** — that would destroy the operator's datum and slam into the rail limit.

Standard axis assignment:
- **X (first HP-GL parameter)**: gantry (left-right across the 600mm bed)
- **Y (second parameter)**: media roller (material feed, 710mm of travel)

These are **not adjustable from the UI**. They are machine hardware properties confirmed on
a real SC631-AU and pinned in `machine/hpgl.js`. See "Verified hardware facts" below.

---

## Verified hardware facts

The axis logic in this project was **iteratively debugged on a real SC631-AU**.

| Item | Measured |
|---|---|
| Motor assignment | Standard: gantry rail = `X`, media roller = `Y` |
| Step resolution | 1000 steps/inch (0.0254mm/step) |
| Serial port | `/dev/ttyACM0`, 9600 8N1, no flow control |
| Origin datum | Panel **Origin** button is $(0,0)$; no `!PG;` at job start |
| **Layout orientation** | **The whole design comes out rotated 90° CCW** (directions correct, not mirrored — purely toppled) |

The corresponding configuration:

```
swapAxes     = false    ← do not swap axes
axisX        =  1       ← gantry positive
axisY        =  1       ← media roller positive
layoutRotate = 90       ← compensates layout orientation (90° clockwise)
```

#### What `layoutRotate` is, and why it is a separate parameter

**Real-machine finding, 2026-10-05**: with "SparkMinds" laid out horizontally on the canvas,
the engraved output came out **rotated 90° counter-clockwise** — the directions were correct
(no mirroring), the whole layout was simply lying on its side. The compensation is therefore
**90° clockwise**.

Physical cause: the machine's feed axis (710mm) and gantry axis (600mm) are transposed in
the firmware, while the operator describes the layout standing in front of the machine in
terms of "left/right" and "in/out". The two reference frames differ by one 90° rotation, and
the net effect is that the whole layout lies down.

> 🔴 **It is a completely different thing from `swapAxes` — do not tune one for the other**
>
> | Parameter | Controls | Symptom when wrong |
> |---|---|---|
> | `swapAxes` | Whether the graphic is **mirrored** | Left-right flipped (obvious at a glance) |
> | `axisX/axisY` | Which way is **positive** on each axis | Single-axis mirror |
> | `layoutRotate` | How far the **whole layout is rotated** | Layout toppled 90°/180° |
>
> Historically, treating the first two as "layout orientation" was the root cause of
> repeated misdiagnosis in this project. The three dimensions are orthogonal and combine
> freely; rotation only accepts multiples of 90° (normalised at the entry point, so 37°
> collapses to 0°).

### Confirmed firmware behaviours

These were all learned the hard way; recorded here so nobody repeats the experiments.

| Behaviour | Explanation |
|---|---|
| **`IN;` must be sent first** | After cold start the firmware is uninitialised and **silently ignores all motion commands** without `IN;`. Serial writes succeed and the job shows "complete", but the machine does not move — indistinguishable from a dead serial port |
| **Reverse `SC` is not supported** | `SC23622,0,...` (Xmin > Xmax) makes the firmware compute a **negative scale factor**, sending the whole machine into a runaway (Y spinning, X fleeing). `SC` must always be in ascending order |
| **`!PG;` gives no completion signal** | Mechanical homing has no done signal and the serial stream does not wait. The host must wait itself (~3s), or the new coordinates take effect mid-homing |
| **Manual operations must lift the pen unconditionally** | The software's notion of pen state can diverge from the machine's (after an aborted job or a reconnect). Safety operations must send `PU;` regardless |

### Safety design

Deliberately biased towards "wait longer rather than crash":

- **No homing at job start**: the first `PA` is absolute positioning, and where the head sits
  before cutting is unknown. Jumping from an unknown position to the start of the artwork
  drives straight into the limit switch.
- **Rate limiting + e-stop**: all manual actions go through the job queue and never bypass
  rate limiting; e-stop sends only `PU;` and **no motion command at all**
- **`SC` always ascending**: a wrong direction setting can at worst mirror the graphic, it
  can never drive the firmware into a negative scale
- **200mm cap per manual move**, so a slip of the hand cannot run away
- **Relative moves for diagnostics**: 5mm, pen up, out and back — safe even when not homed
- **Pen lifted on exit**: a service restart or crash does not leave the head pressing on
  the control board

### Serial auto-reconnect

The service **reconnects the serial port automatically** on startup and retries every 3
seconds, so a USB re-plug that changes the device node (`ttyACM0` → `ttyACM1`) recovers on
its own.

> Without this layer, every service restart left the machine "disconnected" and greyed out
> every manual button — which reads as a broken machine. That is the single most
> misdiagnosed failure mode in this project.

---

## Features

### Import and edit

- **Import DXF / SVG / HP-GL**, or paste HP-GL commands directly
- **Full SVG Primitives & Matrix Cascade**: Full support for `<path>`, `<circle>`, `<rect>`, `<ellipse>`, `<line>`, `<polyline>`, and `<polygon>`, along with nested `<g>` group handling and matrix transform cascades. Fixes missing circle and rectangle geometries when importing multi-element SVGs.
- **Group & Ungroup**:
  - Complex multi-element vector imports are organized as groups by default to keep the layer tree neat.
  - Supports one-click Ungroup for selected layers to split them into independent editable vector paths.
  - Supports multi-selection (Shift / Cmd click) and one-click Grouping.
  - While grouped, translation, scaling, and rotation transformations recursively synchronize all child geometries, ensuring children preserve their relative positions upon ungrouping.
- **Direct canvas editing**: drag to move, drag a corner to scale, drag the top handle to rotate (Shift locks ratio / snaps to 15°)
- **Dynamic Work Origin & Knife Crosshair**:
  - **Live Knife Position Tracking**: Real-time crosshair (⌖) and coordinate display on canvas and control panel tracking the physical blade tip position.
  - **Custom Work Origin (Set Origin / Reset Origin)**: Jog the blade to any target starting position and click "Set Origin" to establish a local working coordinate frame with prominent red origin dot and axis markers; easily reset back to machine zero.
  - **Relative Origin CAM Compilation**: CAM toolpath generation automatically offsets coordinates relative to the active work origin, guaranteeing absolute cutting alignment with canvas layouts.
- **Precise numeric control**: X / Y / width / height / angle, with aspect lock, six-way alignment, flip, duplicate
- **Quick text**: a built-in single-stroke font (Stroker) designed for engraving — ordinary fonts turned into outlines blob together on 3mm acrylic, single-stroke letters stay legible
- 6 material presets (ivory board / PVC foam / acrylic / vinyl / KT board + foil / thin paper), each with its own speed and force

### Device Connection and Manual Control

A pad mirroring the basic operations of Ucancam / 文泰:

- **Minimalist Collapsible Device Card**: Designed for transparent operation by default, showing only current status and machine name, with advanced serial port parameters collapsible on demand.
- **True Connection Health Check & Auto Reconnect**:
  - 1.5s periodic health heartbeat and proactive disconnection handling on read/write errors. Turning off or unplugging the engraver immediately sets the UI status to disconnected, eliminating misleading "connected" indicators.
  - Silent background auto-detection and self-healing reconnection upon power-on or USB re-plug.
- **Direction pad** (▲◀●▶▼), step 0.1 / 1 / 5 / 10 / 25 / 50 mm
  - press-and-hold to move continuously, Shift to reverse; arrow keys work on desktop
- **Pen up / pen down / home / set origin / reset origin / feed / eject / pen-up-and-home**
- 200mm cap per move, so a slip of the hand cannot run away

### Output control

- Job queue with live per-line progress
- Pause / resume / stop / e-stop
- Live toolpath preview during output

---

## Resource usage

Measured on an **RK3399 / Armbian (4GB RAM + 15GB eMMC)** — real numbers, not estimates.

### Disk

| Item | Measured |
|---|---|
| Total deployment | **400 KB** |
| ├ `server/` | 232 KB |
| ├ `web/` | 152 KB |
| ├ `data/` (config) | 8 KB |
| └ `package.json` | 4 KB |
| Dependencies | **0** (no npm deps, no `npm install`) |

400KB is a direct consequence of the "copy and run" design: no `serialport` (C++ extensions),
serial via `stty` + file descriptors, HTTP via `node:http`, hand-rolled minimal WebSocket.

`data/config.json` grows slowly as settings are saved, but it only holds config — order of
magnitude, kilobytes.

### Memory

| State | Measured RSS |
|---|---|
| Idle resident | **~43 MB** |
| Single job peak | Scales with artwork complexity, see below |

43MB is mostly the Node runtime itself (V8 heap + internals), **not this project's data**.

Per-job overhead depends on complexity. Measured (5000 segments, 76KB of commands):

```
command text          75 KB
lines array overhead  ~450 KB   ← one string per line; JS string objects carry overhead
```

**Optimisation already in place**: job history keeps 50 entries. The early implementation
retained the full `text` + `lines` for each, which meant tens of MB resident, growing
monotonically over days. History entries now drop the heavy fields and keep only
name/status/progress/byte count; the UI is unaffected.

### CPU

| State | Measured |
|---|---|
| Idle | **< 1%** (load average ~0.05) |
| Outputting | ~1-3% |

**The tiny CPU footprint is dictated by the serial baud rate**: 9600 baud = 960 bytes/second
ceiling. Shipping 76KB of commands takes 91 seconds of transfer alone; the machine moves far
slower than the data. The CPU was never the bottleneck — the mechanics are.

> This is also why `jobEngine` throttles by byte count and feeds line by line:
> not to save CPU, but to avoid **overrunning the controller's data buffer**.

### Temperature and stability

Measured CPU temperature **45°C** idle. The RK3399 is passively cooled, so this is very safe.
The service runs with `Restart=always`; measured `NRestarts=0` over extended operation.

### In one sentence

An RK3399 needs 400KB of disk, 43MB of RAM and <1% CPU to run this.
**The bottleneck is 100% the engraving mechanics**, not this service.

---

## Accuracy

The self-test includes an HPGL compile-then-reparse round-trip consistency check:

| Metric | Measured | Meaning |
|---|---|---|
| Length error | 0.0115% | ≈ 0.08mm across an 800mm bed |
| Bounding box error | 0.0003% | |

Against Liyue's quoted 0.127mm repeatability, **the command generation error is an order of
magnitude below the machine's own precision** — the mechanics are the limit, not the software.

---

## Internationalisation

The UI ships in Chinese and English. Switch with the `中 / EN` button in the top bar, or let
it follow the browser language on first visit. The choice is remembered in `localStorage`.

How it is put together:

| Source | Mechanism |
|---|---|
| Static HTML | `data-i18n="key"`, plus `data-i18n-attr="placeholder:key,title:key"` for attributes |
| Dynamic JS | `t('key', { vars })` |
| Server messages | Both languages are sent; the client picks (`{zh, en}` for warnings, `{note, noteEn}` for metadata) |

Three deliberate design decisions:

1. **No i18n library.** The front end is native ES modules with zero build. A library that
   needs `npm install` would break the "copy files to deploy" property.
2. **A missing key renders as the key itself**, not as blank. A blank looks like a broken UI;
   `some.missing.key` is visible at a glance. Silently failing is the dangerous mode.
3. **Existing API fields keep their Chinese meaning.** `error` still holds Chinese and `en`
   is added alongside as `errorEn`; `pushLog(line, en)` still records Chinese in `line`.
   Changing the meaning of an established field would blank out any older cached client.

```bash
node tools/i18n-check.js
```

This audits that every key exists in both languages, that placeholders match on both sides,
that HTML and JS reference only real keys, and that no untranslated Chinese string remains
in user-facing code. The risky failure mode it guards against is a key that was never
translated: the UI quietly keeps Chinese while every other check stays green.

The self-test also asserts that every machine preset, material preset, CAM warning and
manual-control note carries both languages.

---

## Project structure

```
plotter-one/
├── server/
│   ├── index.js              HTTP routes + WebSocket
│   ├── selftest.js           217 self-checks
│   ├── geom/path.js          geometry kernel (paths / matrices / transforms)
│   ├── cam/
│   │   ├── toolpath.js       toolpath generation (arcs preserved, not flattened)
│   │   └── textToPath.js     single-stroke font → paths
│   ├── machine/
│   │   ├── hpgl.js           HP-GL generation + machine presets
│   │   ├── transport.js      serial / TCP / virtual plotter
│   │   ├── jobEngine.js      job queue + rate limiting
│   │   ├── manual.js         manual control commands
│   │   └── calibrate.js      safe micro-move helper (diagnostics)
│   ├── import/               DXF / SVG / HPGL parsers
│   └── api/httpKit.js        HTTP helpers + WebSocket implementation
├── web/                      front end (native ES modules, no build)
│   ├── js/i18n.js            bilingual dictionary + switcher
│   ├── js/transform.js       geometry transforms
│   ├── js/render.js          canvas rendering
│   └── geom.js               geometry kernel copy (synced from server)
├── tools/i18n-check.js       i18n audit
├── deploy/                   install / uninstall / sync scripts
└── docs/
    └── 设计工作流.md
```

`web/geom.js` is a copy of `server/geom/path.js`, kept in sync by `deploy/sync-geom.sh`.
**Sharing one geometry kernel is mandatory** — otherwise you get "on screen here, engraved
over there".

---

## Development

```bash
npm run selftest         # 217 self-checks, no machine required
node tools/i18n-check.js # i18n audit
npm start                # default port 8080
npm start -- --port 9000
```

**After editing `server/geom/path.js`, sync it to the web side**:

```bash
./deploy/sync-geom.sh
```

Self-test coverage: geometry invariants, HPGL round-trip consistency, job engine state
machine, mirrored-axis generation, machine bed sizes, serial write paths, bilingual messages.

---

## License

MIT
