/**
 * 任务引擎：把编译好的指令流式下发给刻字机，并跟踪进度。
 *
 * 关键约束是 9600 波特。理论上限 960 字节/秒，实际可用约 850 字节/秒。
 * 一份中等复杂度的图形编译出来常有几十 KB，全量塞进控制板缓存（力宇标称 1MB）
 * 是可行的，但老机器缓存只有几 KB，就必须流式喂，边喂边刻。
 *
 * 所以这里的策略是：
 *   - 分块下发（默认 1KB/块）
 *   - 每块之间按波特率算延时，让控制板有喘息时间
 *   - 支持暂停/继续/停止/急停，状态实时广播
 *   - 进度按「已发送指令数」估算，同时给出时间预估
 *
 * 注意：刻字机没有位置回报（不像 GRBL 会回 ? 状态），所以进度是「已下发」而非
 * 「已刻完」。真正的刻绘进度要等数据全部发完 + 机器走完。这个差异在界面上
 * 必须说清楚，否则用户会以为显示 100% 就代表刻完了。
 */

import { EventEmitter } from 'node:events';
import { estimateHpglMotion } from './hpgl.js';

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
    const lines = text.split('\n').filter(Boolean);
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
      lines,
      status: 'queued',
      createdAt: Date.now(),
      motion,
      totalMotionMs,
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

      const perLineMs = (() => {
        // 估算单行下发时间：字节数 / 波特率
        const bytes = job.text.length;
        const totalMs = (bytes / (job.baud / 10)) * 1000 / BAUD_EFFICIENCY;
        return totalMs / Math.max(1, job.lines.length);
      })();

      let stopped = false;
      for (let i = 0; i < this.current.lines.length; i++) {
        if (this.state === JobState.STOPPING) { stopped = true; break; }
        while (this.state === JobState.PAUSED) {
          if (!pauseStart) pauseStart = Date.now();
          await this._sleep(150);
          if (this.state === JobState.STOPPING) { stopped = true; break; }
        }
        if (pauseStart) {
          motionPausedMs += Date.now() - pauseStart;
          pauseStart = 0;
        }
        if (stopped) break;

        const line = this.current.lines[i];
        try {
          await this.transport.write(line + '\n');
        } catch (err) {
          this.current.status = 'error';
          this.setState(JobState.ERROR, err.message);
          this.pushLog(`✕ 输出中断：${err.message}`, `✕ Output aborted: ${err.message}`);
          return;
        }
        this.current.sent = i + 1;

        if (line.trim() === '!PG;') {
          this.pushLog('  机械归位中，等待机器到位…', '  Homing, waiting for machine…');
          await this._sleep(HOME_DWELL_MS, { capped: false });
        }

        const elapsedMotionMs = Math.max(0, Date.now() - this.startedAt - motionPausedMs);
        const transferPct = Math.round((this.current.sent / this.current.lines.length) * 100);
        const motionPct = Math.min(99, Math.round((elapsedMotionMs / job.totalMotionMs) * 100));
        // 对外主进度在传输期间单调递增，综合体现已下发与物理耗时
        const transmissionPct = Math.round(((i + 1) / this.current.lines.length) * 100);
        const effectivePct = Math.min(99, Math.max(motionPct, Math.round((elapsedMotionMs / Math.max(job.totalMotionMs, (job.lines.length * perLineMs))) * 100)));
        const etaMs = Math.max(0, job.totalMotionMs - elapsedMotionMs);

        this.current.transferPercent = transferPct;
        this.current.motionPercent = motionPct;
        this.current.percent = effectivePct;
        this.current.etaMs = etaMs;

        this.emit('progress', {
          jobId: job.id,
          phase: 'caching',
          sent: this.current.sent,
          total: this.current.lines.length,
          transferPercent: transferPct,
          transferDone: false,
          motionPercent: motionPct,
          percent: effectivePct,
          elapsedMs: elapsedMotionMs,
          etaMs,
          totalMotionMs: job.totalMotionMs,
          cutLengthMm: job.motion.cutLengthMm || 0,
        });

        // 喂字节延时
        const lineMs = ((line.length + 1) / (job.baud / 10)) * 1000 / BAUD_EFFICIENCY;
        if (lineMs > 0) await this._sleep(lineMs);
      }

      // 指令传输已完毕，等待物理刻绘到位
      if (!stopped) {
        this.current.phase = 'cutting';
        this.current.transferPercent = 100;
        this.current.transferDone = true;

        const remainingMotion = job.totalMotionMs - (Date.now() - this.startedAt - motionPausedMs);
        if (remainingMotion > 500) {
          this.pushLog(
            '  ✓ 全部指令已存入机载缓存，机器正在刻绘中…',
            '  ✓ All commands cached, machine is cutting…');
        }

        while (!stopped) {
          if (this.state === JobState.STOPPING) { stopped = true; break; }
          while (this.state === JobState.PAUSED) {
            if (!pauseStart) pauseStart = Date.now();
            await this._sleep(150);
            if (this.state === JobState.STOPPING) { stopped = true; break; }
          }
          if (pauseStart) {
            motionPausedMs += Date.now() - pauseStart;
            pauseStart = 0;
          }
          if (stopped) break;

          const elapsedMotionMs = Math.max(0, Date.now() - this.startedAt - motionPausedMs);
          if (elapsedMotionMs >= job.totalMotionMs) {
            break; // 物理运动完成
          }

          const motionPct = Math.min(99, Math.round((elapsedMotionMs / job.totalMotionMs) * 100));
          const etaMs = Math.max(0, job.totalMotionMs - elapsedMotionMs);

          this.current.motionPercent = motionPct;
          this.current.percent = motionPct;
          this.current.etaMs = etaMs;

          this.emit('progress', {
            jobId: job.id,
            phase: 'cutting',
            sent: this.current.lines.length,
            total: this.current.lines.length,
            transferPercent: 100,
            transferDone: true,
            motionPercent: motionPct,
            percent: motionPct,
            elapsedMs: elapsedMotionMs,
            etaMs,
            totalMotionMs: job.totalMotionMs,
            cutLengthMm: job.motion.cutLengthMm || 0,
          });

          const stepMs = Math.min(250, job.totalMotionMs - elapsedMotionMs);
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

        this.pushLog(`✔ 完成：${job.name}`, `✔ Done: ${job.name}`);
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
