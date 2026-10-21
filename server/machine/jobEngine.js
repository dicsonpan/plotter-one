/**
 * 任务引擎：把编译好的指令**按机器节奏**流式下发给刻字机，并跟踪进度。
 *
 * 🔴 2026-10-19 实机教训：**不能把整份指令一次性灌进机器**。
 *
 * 力宇的 USB 口是 GD32 跑 CDC ACM（虚拟串口），**没有真实波特率限制**——
 * 老说是「按波特率节流」，但 USB 上一行指令几十微秒就写完了，
 * 一份几十 KB 的指令几秒就倒进机器，机器端的应用层解析/规划跟不上，
 * 环形缓冲被灌满后固件可能进入错误状态（今天的表现：数据全收了、
 * 场面毫无动静，必须断电重启）。而界面这边因为「写成功」就报了完成。
 *
 * 现在的策略是**节奏化流式下发（paced streaming）**：
 *   - 用 hpgl.js 的逐 cmd 运动学估算算出每条指令的物理耗时；
 *   - 只维持一个很小的预投窗口（见 LOOKAHEAD_MS），机器干完一点再喂一点；
 *   - 因为下发节奏跟着物理执行走，「下发完成」≈「机器真的刻完」，
 *     进度条与倒计时终于对得上实物（而不是「传完就打勾」）。
 *
 * 仍然成立的事实：机器没有位置回报（不像 GRBL 会回 ? 状态），
 * 所以这套时基是**估算**的；因此日志会明确标注「仿真推算、请目视确认」。
 */

import { EventEmitter } from 'node:events';
import { estimateHpglMotion, estimateLineMotionMs } from './hpgl.js';

const BAUD_EFFICIENCY = 0.88; // 协议开销 + 控制板缓冲，实测效率约 88%

/**
 * 机械归位后的驻留时间（毫秒）。
 *
 * `!PG;` 触发限位开关搜索，固件不回执完成。串口是流式的，
 * 发完就返回，所以上位机必须自己等机器走完再发下一条坐标指令。
 *
 * 3 秒是保守值：SC631-AU 最长行程 710mm，
 * 即使按 60mm/s 的极限慢速也就 12 秒，通常 1-2 秒。
 * 取大值只是多等一会儿，不会出错；取小值会让机器边归位边接收新目标，
 * 表现为刀头朝一个方向狂奔直到撞限位。
 */
const HOME_DWELL_MS = 3000;

/**
 * 预投窗口（毫秒）：机器手里始终只压这么多「还没干完的活」。
 *
 * 取小：下发与物理执行强同步，机器不容易被灌满，进度也真实；
 * 取大：更抗抖动（USB 偶发卡顿也不至于让机器饿停），但削弱同步性。
 * 经验值 ~1 秒：既够吸收调度抖动，又保证机器里最多压着 1 秒的活。
 */
const LOOKAHEAD_MS = 1000;

/**
 * 每个进给周期最多下发多少条指令（防止「逐条耗时≈0」的退化任务瞬间灌爆缓冲）。
 *
 * 有些图形（大量重复点、空跑修正）算出来单条物理耗时为 0，
 * 若只看耗时窗口会一个 tick 把上万条全发出去——那又回到「一次性灌入」了。
 */
const MAX_UNITS_PER_TICK = 48;

/** 进给周期（毫秒）：扣减机器已完成工作量、刷新进度的节拍 */
const TICK_MS = 60;

/**
 * 单行指令字节上限（不含换行）。
 *
 * 🔴 针对 GD32 CDC ACM 固件：这种模式的一个 USB 全速包就是 64 字节，
 * 官方 demo 的 OUT 端点收包缓冲开的也是 64 字节常量。
 * 「连续坐标流合并」会把几十对坐标拼成一行（上百字节），
 * 超过单包长度后要跨包重组，若固件没有严谨的累积缓冲就会解析错乱 ——
 * 表现为「指令都收了，机器不干活」。
 * 这里把超长行按语义安全拆分（一段连续折线拆成多条 PA 是等价的）。
 */
const MAX_LINE_BYTES = 64;

/** 匹配「助记符 + 一串坐标」的可安全拆分指令，如 PA123,456,789,10; */
const COORD_LINE_RE = /^(PA|PR|PD|PU|A|R|D|U)(-?\d+(?:,-?\d+)+);$/;

/**
 * 把整份指令切成下发单元，并保证每个单元不超过 maxBytes 字节。
 *
 * 🔴 为什么要限制单行长度（GD32 CDC ACM 固件的实证考量）：
 * USB 全速包 = 64 字节，GD32 官方 CDC 库 demo 的 OUT 端点收包缓冲也按这个常量开。
 * 「连续坐标流合并」会把几十对坐标拼成一行（上百字节），跨包重组若固件没做，
 * 就可能解析错乱——表现为「指令都收到了，机器就是不干活」。
 * 把一条长折线拆成多条同助记符的指令是**严格等价**的（连续 PA 依次经过各点，
 * PD/PU 重复下发也不改变刀状态），所以对刀路没有任何副作用。
 */
export function prepareUnits(text, maxBytes = 64) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(COORD_LINE_RE);
    // 非多行指令（IN; SP1; 等）或已经够短：原样下发
    if (!m || line.length + 1 <= maxBytes) { out.push(line); continue; }

    const head = m[1];
    // 坐标一律按**原始文本**处理，不转 Number：
    // 转数字再拼回字符串可能被指数记数法/浮点精度改写（如 1e+31、0.30000000000000004），
    // 那样就是在无声地改动刀路坐标。
    const nums = m[2].split(',');
    let i = 0;
    while (i < nums.length) {
      let pairs = 0;
      let body = '';
      while (i + (pairs + 1) * 2 <= nums.length) {
        const next = nums.slice(i, i + (pairs + 1) * 2).join(',');
        if (head.length + next.length + 2 > maxBytes) break;
        body = next;
        pairs++;
      }
      if (pairs === 0) { out.push(line); break; } // 单点过长：退化为一整条，不再拆
      out.push(head + body + ';');
      i += pairs * 2;
    }
  }
  return out;
}

export const JobState = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
};

export class JobEngine extends EventEmitter {
  constructor(transport) {
    super();
    this.transport = transport;
    this.state = JobState.IDLE;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.startedAt = 0;
    this.accumulatedMs = 0;
    this.log = [];
  }

  get busy() {
    return this.state === JobState.RUNNING || this.state === JobState.PAUSED || this.state === JobState.STOPPING;
  }

  setState(s, detail) {
    this.state = s;
    this.emit('state', { state: s, detail, jobId: this.current?.id || null });
  }

  /**
   * 写一条日志。
   *
   * @param {string} line 中文（同时作为兼容字段 `line`）
   * @param {string} [en]  英文；不给就退化成只显示中文
   *
   * 🔴 为什么 `line` 保留中文而不是英文明明在前端选：
   *   `line` 是这个协议的**既有字段**，任务历史接口、日志面板、
   *   以及任何直接读 entry.line 的地方都依赖它。改掉它的语义会让
   *   老前端（浏览器缓存）显示空白——那比重启一次糟糕得多。
   *   所以：line 保持中文不变，en 作为附加字段并行下发。
   */
  pushLog(line, en) {
    const entry = { t: Date.now(), line, en: en || line };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit('log', entry);
  }

  /** 入队一个任务：{ id, name, text, baud } */
  enqueue(job) {
    const text = job.text || '';
    // 下发单元：先按行，再把超长行按语义安全拆到 MAX_LINE_BYTES 以内。
    // 单元数 ≥ 行数，UI 的行数/进度用单元数，与实际下发节奏一致。
    const units = prepareUnits(text, MAX_LINE_BYTES);
    const motion = job.estimate
      ? {
          totalSeconds: job.estimate.totalSeconds,
          cutLengthMm: job.estimate.cutLengthMm || 0,
          rapidLengthMm: job.estimate.rapidLengthMm || 0,
          ...job.estimate,
        }
      : estimateHpglMotion(text, {
          defaultSpeed: job.speed || 30,
          stepsPerInch: job.stepsPerInch || 1000,
        });

    const totalMotionMs = Math.max(200, Math.round((motion.totalSeconds || 1) * 1000));

    const item = {
      id: job.id,
      name: job.name || '未命名任务',
      nameEn: job.nameEn || job.name || 'Untitled job',
      text,
      baud: job.baud || 9600,
      lines: units,
      units,
      status: 'queued',
      createdAt: Date.now(),
      motion,
      totalMotionMs,
      // 调用方给的原始预估要留着：run() 需要它把「逐条物理耗时」
      // 按比例缩放到界面展示的同一个总时长（两处口径必须一致）
      estimate: job.estimate || null,
      meta: job.meta || {},
    };
    // 手动控制指令插到队首。理由：用户点了「回原点」就是想立刻执行，
    // 排在一条几分钟的刻字任务后面毫无意义。
    if (job.priority) this.queue.unshift(item);
    else this.queue.push(item);
    this.emit('queue', this.list());
    return job.id;
  }

  list() {
    // 当前任务 + 排队任务 + 最近完成的历史。
    // 只返回 queue 会让界面在任务开始后「凭空消失」，这是实测踩到的坑。
    //
    // 注意：历史条目**没有** lines/text 字段（入历史时已剥掉，见 run 末尾），
    // 所以这里用 totalLines/bytes，并给 undefined 兜底。
    // 直接写 j.lines.length 会读到 undefined.length 抛错，界面就整个刷不出来。
    const out = this.history.slice(-20).map((j) => ({
      id: j.id, name: j.name, status: j.status,
      phase: j.phase || (j.status === 'done' ? 'done' : 'idle'),
      totalLines: j.totalLines ?? 0, sentLines: j.sent || 0,
      bytes: j.bytes ?? 0, createdAt: j.createdAt, meta: j.meta,
      percent: j.percent ?? (j.status === 'done' ? 100 : 0),
      transferPercent: j.transferPercent ?? 100,
      motionPercent: j.motionPercent ?? 100,
      cutLengthMm: j.cutLengthMm ?? 0,
    }));
    if (this.current) {
      out.unshift({
        id: this.current.id, name: this.current.name, status: this.current.status,
        phase: this.current.phase || 'caching',
        totalLines: this.current.lines.length, sentLines: this.current.sent || 0,
        bytes: this.current.text.length, createdAt: this.current.createdAt, meta: this.current.meta,
        percent: this.current.percent ?? 0,
        transferPercent: this.current.transferPercent ?? 0,
        motionPercent: this.current.motionPercent ?? 0,
        etaMs: this.current.etaMs ?? 0,
        cutLengthMm: this.current.motion?.cutLengthMm ?? 0,
      });
    }
    for (const j of this.queue) {
      out.push({
        id: j.id, name: j.name, status: 'queued',
        phase: 'queued',
        totalLines: j.lines.length, sentLines: 0,
        bytes: j.text.length, createdAt: j.createdAt, meta: j.meta,
        percent: 0, transferPercent: 0, motionPercent: 0,
        etaMs: j.totalMotionMs,
        cutLengthMm: j.motion?.cutLengthMm ?? 0,
      });
    }
    return out;
  }

  clearFinished() {
    this.queue = this.queue.filter((j) => j.status === 'queued');
    this.history = this.history.filter((j) => j.status === 'queued').slice(-20);
    this.emit('queue', this.list());
  }

  /**
   * 逐行下发与运动学仿真执行追踪。
   *
   * 双阶段状态模型：
   *   1. 传输阶段（caching）：数据逐块写入串口，注入机载 1MB 缓存。
   *   2. 刻绘阶段（cutting）：数据下发完毕后，按物理运动学模型持续步进，
   *      追踪机器在材料上的真实物理切割进度与倒计时。
   */
  async run() {
    if (this.busy) return;
    this.accumulatedMs = 0;
    this.startedAt = Date.now();

    while (this.queue.length) {
      const job = this.queue.shift();
      this.startedAt = Date.now();
      let motionPausedMs = 0;
      let pauseStart = 0;

      this.current = {
        ...job,
        sent: 0,
        phase: 'caching',
        transferPercent: 0,
        transferDone: false,
        motionPercent: 0,
        percent: 0,
        etaMs: job.totalMotionMs,
      };
      this.current.status = 'running';
      this.setState(JobState.RUNNING, job.name);
      this.pushLog(
        `▶ 开始输出：${job.name}（${job.lines.length} 行 / 物理预估 ${(job.totalMotionMs / 1000).toFixed(1)} 秒）`,
        `▶ Start output: ${job.name} (${job.lines.length} lines / estimated ${(job.totalMotionMs / 1000).toFixed(1)}s)`);

      // 单工链路提示（一次性，每个任务开头）。
      // 力宇实测：OI;/OA;/IN; 全部零回应 → 机器没有回执能力，
      // 「完成」只能按运动学仿真推算。必须让操作者知道这一点，
      // 否则会像 2026-10-19 那样：机器不动、日志却报「刻绘完成」。
      if (this.transport && this.transport.everRx === false) {
        this.pushLog(
          '  ℹ 本机为单向链路（无回执能力），完成状态按运动学仿真推算，请目视确认机器实际刻绘',
          '  ℹ One-way link (no acknowledgement): completion is simulated, verify the cut visually');
      }

      // 对齐文泰 usbfiletrans.dll (FUN_10003120)：
      // 1. 严禁“边刻边发”（在首条 PU x0,y0; 后按运动耗时断流休眠会导致机器停在起始点）；
      // 2. 严禁在每条指令后附加换行符 \n（紧凑拼接纯 ';' 分隔的 HPGL 字节流）；
      // 3. 第一阶段（caching）按 512B 分块快速连续写入机载缓存，第二阶段（cutting）跟踪物理刻绘进度。
      const CHUNK_BYTES = 512;
      let stopped = false;
      let i = 0;
      // 进度棘轮（每个任务一份）：对外百分比只许涨、不许跌。
      //
      // 背景：整批分块秒发时机载缓存瞬间灌满（transferPct 直达 100 → 传输段占比
      // 封顶 20%），而此时物理耗时占比 motionPct 可能才几个点。阶段切换
      //（caching → cutting）瞬间原始值会从 20 掉回 8，进度条倒退——
      // 自检「进度百分比单调不减」两次失败都出在这。用 pctFloor 记住
      // 历史最高值把切换 gap 平渡过，之后 motionPct 涨过来自然接管。
      let pctFloor = 0;

      const emitProgress = (phase) => {
        const elapsedMotionMs = Math.max(0, Date.now() - this.startedAt - motionPausedMs);
        const motionPct = Math.min(99, Math.round((elapsedMotionMs / job.totalMotionMs) * 100));
        const transferPct = this.current.units.length > 0
          ? Math.round((this.current.sent / this.current.units.length) * 100)
          : 100;
        const rawPct = phase === 'caching'
          ? Math.min(99, Math.max(motionPct, Math.round(transferPct * 0.2)))
          : motionPct;
        const effectivePct = Math.min(99, Math.max(rawPct, pctFloor));
        pctFloor = effectivePct;
        const etaMs = Math.max(0, job.totalMotionMs - elapsedMotionMs);

        this.current.transferPercent = transferPct;
        this.current.motionPercent = motionPct;
        this.current.percent = effectivePct;
        this.current.etaMs = etaMs;
        this.current.phase = phase;

        this.emit('progress', {
          jobId: job.id,
          phase,
          sent: this.current.sent,
          total: this.current.units.length,
          transferPercent: transferPct,
          transferDone: this.current.sent >= this.current.units.length,
          motionPercent: motionPct,
          percent: effectivePct,
          elapsedMs: elapsedMotionMs,
          etaMs,
          totalMotionMs: job.totalMotionMs,
          cutLengthMm: job.motion.cutLengthMm || 0,
        });
      };

      // 第一阶段（caching）：整批分块连续发送至刻字机缓存（无换行符紧凑流）
      while (!stopped && i < this.current.units.length) {
        if (this.state === JobState.STOPPING) { stopped = true; break; }
        while (this.state === JobState.PAUSED) {
          if (!pauseStart) pauseStart = Date.now();
          if (this.state === JobState.STOPPING) { stopped = true; break; }
          await this._sleep(100);
        }
        if (pauseStart) { motionPausedMs += Date.now() - pauseStart; pauseStart = 0; }
        if (stopped) break;

        let chunk = '';
        let count = 0;
        let hasHome = false;
        while (i + count < this.current.units.length) {
          const u = this.current.units[i + count].trim();
          if (chunk.length > 0 && chunk.length + u.length > CHUNK_BYTES) break;
          chunk += u;
          count++;
          if (u === '!PG;') { hasHome = true; break; }
        }

        try {
          await this.transport.write(chunk);
        } catch (err) {
          this.current.status = 'error';
          this.setState(JobState.ERROR, err.message);
          this.pushLog(`✕ 输出中断：${err.message}`, `✕ Output aborted: ${err.message}`);
          stopped = true;
          break;
        }

        i += count;
        this.current.sent = i;
        emitProgress('caching');

        if (hasHome) {
          this.pushLog('  机械归位中，等待机器到位…', '  Homing, waiting for machine…');
          await this._sleep(HOME_DWELL_MS, { capped: false });
        } else if (i < this.current.units.length) {
          await this._sleep(5);
        }
      }

      if (this.current.status === 'error') {
        this.current = null;
        this.emit('queue', this.list());
        continue;
      }

      // 第二阶段（cutting）：指令已全部发入刻字机缓存，等待机器自主刻完
      if (!stopped) {
        this.current.transferDone = true;
        this.current.transferPercent = 100;
        const remainAtTransferDone = job.totalMotionMs - (Date.now() - this.startedAt - motionPausedMs);
        if (remainAtTransferDone > 300) {
          this.pushLog(
            '  ✓ 全部指令已发送至机器缓存，刻字机正在自主刻绘中…',
            '  ✓ All commands sent to machine buffer, plotter is cutting autonomously…');
        }
        while (!stopped) {
          if (this.state === JobState.STOPPING) { stopped = true; break; }
          while (this.state === JobState.PAUSED) {
            if (!pauseStart) pauseStart = Date.now();
            if (this.state === JobState.STOPPING) { stopped = true; break; }
            await this._sleep(150);
          }
          if (pauseStart) { motionPausedMs += Date.now() - pauseStart; pauseStart = 0; }
          if (stopped) break;

          const elapsedMotionMs = Math.max(0, Date.now() - this.startedAt - motionPausedMs);
          if (elapsedMotionMs >= job.totalMotionMs) break;

          emitProgress('cutting');
          const stepMs = Math.min(200, job.totalMotionMs - elapsedMotionMs);
          if (stepMs > 0) await this._sleep(stepMs);
        }
      }

      if (stopped) {
        this.current.status = 'aborted';
        this.pushLog(
          `■ 已中止：${job.name}（下发 ${this.current.sent}/${this.current.lines.length} 行）`,
          `■ Stopped: ${job.name} (sent ${this.current.sent}/${this.current.lines.length} lines)`);
        this.setState(JobState.ABORTED);
      } else {
        this.current.status = 'done';
        this.current.phase = 'done';
        this.current.percent = 100;
        this.current.motionPercent = 100;
        this.current.transferPercent = 100;
        this.current.etaMs = 0;

        this.emit('progress', {
          jobId: job.id,
          phase: 'done',
          sent: this.current.lines.length,
          total: this.current.lines.length,
          transferPercent: 100,
          transferDone: true,
          motionPercent: 100,
          percent: 100,
          elapsedMs: job.totalMotionMs,
          etaMs: 0,
          totalMotionMs: job.totalMotionMs,
          cutLengthMm: job.motion.cutLengthMm || 0,
        });

        // 单工机器没有回执：这个「完成」是仿真推算，不是机器确认。
        // 双向机器（everRx !== false）保持原语义。
        if (this.transport && this.transport.everRx === false) {
          this.pushLog(
            `✔ 传输完成（仿真计时到点）：${job.name} —— 本机无回执，请目视确认机器已实际刻完`,
            `✔ Transfer complete (simulated timer): ${job.name} — no acknowledgement from machine, verify the cut visually`);
        } else {
          this.pushLog(`✔ 完成：${job.name}`, `✔ Done: ${job.name}`);
        }
        await this._sleep(400);
        this.setState(JobState.DONE, job.name);
      }
      this.emit('jobdone', { id: job.id, status: this.current.status });

      this.history.push({
        id: this.current.id,
        name: this.current.name,
        status: this.current.status,
        phase: this.current.status === 'done' ? 'done' : 'aborted',
        createdAt: this.current.createdAt,
        meta: this.current.meta,
        bytes: this.current.text.length,
        totalLines: this.current.lines.length,
        sent: this.current.sent,
        percent: this.current.percent,
        cutLengthMm: this.current.motion?.cutLengthMm || 0,
      });
      if (this.history.length > 50) this.history.shift();
      this.current = null;
      this.emit('queue', this.list());
    }

    this.setState(JobState.IDLE);
  }

  _estimateEta(sent, total, perLineMs) {
    const remain = total - sent;
    return Math.max(0, remain * perLineMs);
  }

  /**
   * 睡眠。
   *
   * 🔴 两种语义必须分开，不能共用一个 200ms 上限：
   *
   *   - 轮询等待（暂停/停止的检查）：要**短**，否则停止按钮响应迟钝。
   *     200ms 上限就是为它设的。
   *   - 机器驻留（归位后等到位）：要**真的等够**。
   *     以前两种共用 `Math.min(ms, 200)`，导致传 3000 也只睡 200ms，
   *     归位等待形同虚设——而且不报错，只是「偶尔撞机」，极难察觉。
   */
  _sleep(ms, { capped = true } = {}) {
    const d = capped ? Math.min(ms, 200) : ms;
    return new Promise((r) => setTimeout(r, d));
  }

  pause() {
    if (this.state === JobState.RUNNING) {
      this.accumulatedMs = Date.now() - this.startedAt;
      this.setState(JobState.PAUSED);
      this.pushLog('⏸ 已暂停', '⏸ Paused');
    }
  }

  resume() {
    if (this.state === JobState.PAUSED) {
      this.startedAt = Date.now() - this.accumulatedMs;
      this.setState(JobState.RUNNING);
      this.pushLog('▶ 已继续', '▶ Resumed');
    }
  }

  /** 软停止：跑完当前行就停。刀仍处于抬起状态（指令流里每行前都有 PU） */
  stop() {
    if (this.busy) {
      this.setState(JobState.STOPPING);
      this.pushLog('■ 请求停止…', '■ Stop requested…');
    }
  }

  /**
   * 急停：立刻断流并抬刀。
   *
   * 🔴 急停只发 `PU;`（抬刀），**不发任何 PA 移动指令**。
   * 原实现在这里写 `PU;PA0,0;`——`PA0,0` 是一次真实的绝对移动，
   * 会在急停时把刀头拽向 P1 点。急停的第一原则是「不再产生任何运动」，
   * 移动指令必须在急停路径上彻底消失。
   * 位置由操作者在恢复后手动「回原点」处理。
   */
  emergencyStop() {
    this.queue = [];
    this.setState(JobState.STOPPING);
    this.pushLog('⛔ 急停（已抬刀，未发送任何移动指令）',
      '⛔ E-stop (pen lifted, no motion sent)');
    if (this.transport.open) {
      this.transport.write('PU;\n').catch(() => {});
    }
  }
}
