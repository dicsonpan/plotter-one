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

**[中文](README.md)**

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

For deployment to a board, see [docs/部署指南.md](docs/部署指南.md) — one command:

```bash
sudo ./deploy/install.sh
```

For how to design artwork, see [docs/设计工作流.md](docs/设计工作流.md).

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
- **Direct canvas editing**: drag to move, drag a corner to scale, drag the top handle to
  rotate (Shift locks ratio / snaps to 15°)
- **Precise numeric control**: X / Y / width / height / angle, with aspect lock,
  six-way alignment, flip, duplicate
- **Quick text**: a built-in single-stroke font (Stroker) designed for engraving — ordinary
  fonts turned into outlines blob together on 3mm acrylic, single-stroke letters stay legible
- 6 material presets (ivory board / PVC foam / acrylic / vinyl / KT board + foil / thin paper),
  each with its own speed and force

### Manual control

A pad mirroring the basic operations of Ucancam / 文泰:

- **Direction pad** (▲◀●▶▼), step 0.1 / 1 / 5 / 10 / 25 / 50 mm
  - press-and-hold to move continuously, Shift to reverse; arrow keys work on desktop
- **Pen up / pen down / home / set origin / feed / eject / pen-up-and-home**
- 200mm cap per move, so a slip of the hand cannot run away
- **Serial auto-reconnect**: reconnecting after a service restart, and recovering from a
  USB re-plug, with no need to press "Connect" by hand

All manual actions go through the job queue and **never bypass rate limiting or e-stop**.
Manual directions are sent in **canvas orientation** (pressing "right" moves the head
right), decoupled from the machine's internal axis numbering — so the operating intuition
stays correct even when the physical X/Y are transposed.

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
    ├── 设计工作流.md
    └── 部署指南.md
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

## Bugs that only real hardware reveals

A few bugs here cannot be found by reading the code. Recorded so others do not repeat them.

1. **Canvas X formula omitted the "viewport centre"** → the whole view was mirrored.
   ("SPARKMINDS" rendered as "SPAPXIWS", while a symmetric box showed nothing wrong.)

2. **`SerialTransport.write` written as `const { write } = await import('node:fs/promises')`**
   → `node:fs/promises` has no `write` export (only `open`), so this destructured to
   `undefined` and threw `write is not a function`. The connection had succeeded, so it
   presented as "shows connected, fails on the first cut" — very much like a connection
   problem. The self-test only covered the virtual plotter's `write`; the real serial path
   was never exercised.

3. **Axis direction must never be assumed** → crash-class bug. See the layout notes above.

4. **Mirroring cannot be done with reverse `SC`** (hit on real hardware, 2026-10-04)
   → presented as "press Home, Y spins wildly, X runs backwards", which looks like X/Y
   transposed, but was actually `SC23622,0,...` giving the firmware a **negative scale
   factor**. The HP-GL spec permits `Xmin > Xmax` for mirroring; the Liyue firmware does
   not. Correct approach: `SC` always ascending, mirroring done host-side in `toMachine()`.
   **Lesson**: when the machine goes wild, first suspect the parameters you sent, not
   transposed axes.

4b. **"Transposed" and "reversed" must be handled separately** (real hardware, 2026-10-04)
   → this machine has physical X/Y transposed (the gantry is firmware Y, the feed is
   firmware X), while "origin on the right-hand side" is a **direction** issue. The two are
   orthogonal and must be set separately. The easiest mistake: **you cannot carry
   `axisX/axisY` over unchanged after enabling the swap** — the same physical fact (gantry
   homes to the right) lands on the other axis afterwards. I made exactly this error:
   leaving `axisX=-1` in place when it should have been `axisY=-1`.
   → Re-derive which axis owns which direction whenever you change `swapAxes`.

4c. **The bed bound must be swapped too when axes are swapped**
   → before the swap, machine X travels 600mm; after, it travels 710mm. Hard-coding
   `preset.width` makes the machine scale coordinates against the wrong span — and because
   nothing crashes, it is extremely hard to notice. Always go through
   `machineSpanX` / `machineSpanY`.

5. **Omitting `IN;` disables the entire machine** (real hardware, 2026-10-04 — my fault)
   → while fixing axis direction I deleted `IN;` as "redundant state reset", and then no
   button did anything. The Liyue firmware ignores all motion commands when uninitialised.
   Serial writes succeed and the job shows "complete", but the machine does not move —
   identical to a dead serial port. The safe combination is: keep `IN;`; the only dangerous
   thing is reverse `SC`.
   **Lesson**: **the assertions themselves can be wrong.** The "must not contain IN" check
   was protecting this very bug, so deleting `IN;` still passed everything green.
   **Assertions passing ≠ the machine moving.**

6. **`PR;` + `PA dx,dy;` is an absolute move, not relative**
   → in HP-GL, `PR;` only switches mode; the following `PA x,y` means "switch back to
   absolute and move to (x,y)". The original manual jog was written as `PR;` + `PA197,0;`,
   which on a mirrored machine became a dash toward the origin. Relative moves must be
   written `PR dx,dy;`.

7. **`PA0,0;` really does move to (0,0)** → to just "switch back to absolute mode", write
   `PA;` (no coordinates). The original code sent `PU;PA0,0;` on every direction-key press,
   so the head was yanked back to the origin every time. The same mistake in **e-stop** is
   worse: it meant commanding the machine to move during an emergency stop. E-stop now
   sends only `PU;`.

8. **Pen-down test must not use `lineTo(2,0)`** → that is an **absolute** move to (2,0).
   With the pen down it drives diagonally across the work and scores a line through the
   finished piece. The test press must be a relative 2mm move.

9. **Feed must travel along the feed axis**, which is not "X" by default → the original
   `feed` was `moveTo(d, 0)` (an absolute move to (d,0)), so "feed 50mm" actually moved the
   head sideways. Which axis feeds is hardware-determined; feeding goes through
   `relative(0, d)` and lets `toMachineDelta` do the conversion — never hard-code
   "feed = absolute coordinate on some axis" at the command level.

10. **Reflection flips arc winding** → X mirror `x → w-x` and axis swap `x,y→y,x` are both
    reflections (det = -1), turning a counter-clockwise arc in user coordinates into a
    clockwise one — but HP-GL's `AA` only goes counter-clockwise. Conversion: a clockwise
    `s` sweep ≡ a counter-clockwise `(360-s)` sweep. **The start angle must be mirrored
    too** (X mirror: a0 → 180-a0), or the firmware draws a straight line from the current
    position to the computed arc start, cutting a line that was never in the design. In the
    implementation the start angle is back-solved from the current position and the mapped
    centre rather than computed by hand. A full 360° must not be converted to 0 (that
    degenerates to a zero-length arc). An even number of reflections (swap + single-axis
    flip = 180° rotation) preserves winding — use the `isReflection` getter rather than
    counting by hand at each site.

11. **Diagnostics must use relative moves** → the original routine moved to the material
    centre with `PA cx,cy` first; on a machine that was not homed, or with wrong coordinates,
    that single command was a sprint across the entire workbench. Relative moves are
    anchored to the current position regardless of homing state, so they are **safe to test
    before homing**.

12. **`/api/compile` once failed to pass the axis config through** → the on-screen axis
    controls had no effect on the output at all, so changing them looked like a no-op and
    invited misdiagnosis of the machine itself. Every generation entry point now goes
    through a single config function.

13. **Do not use `PA0,0` for homing** → once `SC` is in effect, `PA0,0` only returns to P1,
    which sits at the right end when X is reversed. Liyue's mechanical home is `!PG;`.

14. **`reverseSubpath` flattened arcs** → a single `AA` ballooned into hundreds of `PA`, and
    the discretisation error shortened rounded rectangles by 8% (seen as "cut short").

15. **Static asset caching** → changed code still ran the old logic in the browser, making
    "I changed the code and nothing happened" very hard to debug. Now uses ETag +
    `no-cache` conditional requests.

16. **Module scripts run before DOMContentLoaded** → `getBoundingClientRect()` returns 0
    and the canvas size cannot be computed.

17. **Single-stroke font metrics** → glyphs actually occupy 4×6 font units, not 6×8.
    Scaling by the wrong size made text 40% too short and a line 80mm wide.

18. **A stale `config.json` silently overrides presets** → a preset default was changed, but
    the board's `data/config.json` still held a value saved by an earlier calibration, which
    takes priority. The new preset was silently ignored — "changed the code, no effect" —
    and the first instinct is to suspect the machine or firmware. The UI no longer exposes
    these settings, and `config` is no longer consulted for them.

19. **Layout rotation, mirror, and axis direction are three different things** → this is the
    one that cost the most time. Symptoms looked identical ("the output is wrong") but the
    causes and fixes were unrelated, and tuning the wrong one made things worse. See the
    table above.

20. **Never infer state by comparing button text** → the pause handler read
    `$('btnPause').textContent === '暂停'`. After internationalisation that test is always
    false in the English UI and the pause button silently stops working. Button labels
    change with the language; the predicate must read `state.jobState`.

21. **A local variable can shadow the module-level `t`** → the translation lookup is `t`,
    but `logLine` already had `const t = <timestamp>`. After shadowing, `logLine` can no
    longer reach the lookup function — and it **throws no error**, it just fails to
    translate that one string. The same happened with `const t = $('connType').value` in the
    connection-type handler. This class of bug is *introduced by the change you are making*,
    not pre-existing, which is exactly why it is easy to miss.

22. **`duplicateLayer` in `transform.js` should not append its own "copy" suffix** → the
    layer name is shown to the user, so it is a language concern. Hard-coding it leaks
    Chinese into the English UI. It now only duplicates; the caller names the result in the
    current language.

23. **JS-generated `<option>` elements are invisible to `data-i18n`** → the "no serial port
    found" placeholder is written by `scanPorts()` and carries no `data-i18n` attribute, so
    switching language left it stranded in the previous language while the rest of the UI
    translated. Fixed by tagging the placeholder with `data-i18n`. Real port names
    (`/dev/ttyACM0`) have no prose and need no translation.

---

## License

MIT
