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

  pushLog(line) {
    const entry = { t: Date.now(), line };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit('log', entry);
  }

  /** 入队一个任务：{ id, name, text, baud } */
  enqueue(job) {
    const item = {
      id: job.id,
      name: job.name || '未命名任务',
      text: job.text,
      baud: job.baud || 9600,
      lines: job.text.split('\n').filter(Boolean),
      status: 'queued',
      createdAt: Date.now(),
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
      totalLines: j.totalLines ?? 0, sentLines: j.sent || 0,
      bytes: j.bytes ?? 0, createdAt: j.createdAt, meta: j.meta,
    }));
    if (this.current) {
      out.unshift({
        id: this.current.id, name: this.current.name, status: this.current.status,
        totalLines: this.current.lines.length, sentLines: this.current.sent || 0,
        bytes: this.current.text.length, createdAt: this.current.createdAt, meta: this.current.meta,
      });
    }
    for (const j of this.queue) {
      out.push({
        id: j.id, name: j.name, status: 'queued',
        totalLines: j.lines.length, sentLines: 0,
        bytes: j.text.length, createdAt: j.createdAt, meta: j.meta,
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
   * 逐行下发。每次只发一行并等一个「字节时间」，控制板不会被数据冲垮。
   * 这是老机器（缓存 4-8KB）唯一可靠的下发节奏。
   */
  async run() {
    if (this.busy) return;
    this.accumulatedMs = 0;
    this.startedAt = Date.now();

    while (this.queue.length) {
      const job = this.queue.shift();
      this.current = { ...job, sent: 0 };
      this.current.status = 'running';
      this.setState(JobState.RUNNING, job.name);
      this.pushLog(`▶ 开始输出：${job.name}（${job.lines.length} 行 / ${job.text.length} 字节）`);

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
          await this._sleep(200);
          if (this.state === JobState.STOPPING) { stopped = true; break; }
        }
        if (stopped) break;

        const line = this.current.lines[i];
        try {
          await this.transport.write(line + '\n');
        } catch (err) {
          this.current.status = 'error';
          this.setState(JobState.ERROR, err.message);
          this.pushLog(`✕ 输出中断：${err.message}`);
          return;
        }
        this.current.sent = i + 1;

        /**
         * 机械归位后必须等机器真的停下，再发下一条坐标指令。
         *
         * 归位（`!PG;`）是纯机械动作，固件收到后开始跑限位开关搜索，
         * **不会**回执完成。紧接着发 `PA x,y` 的话，新目标会在归位途中就生效——
         * 机器可能边归位边往新位置走，表现为「刀一直往一个方向狂奔直到卡死」。
         *
         * 串口本身是流式的，发完就返回，没有「等机器执行完」的语义，
         * 所以这个停顿只能由上位机在这里插入。
         *
         * 用注释行做锚点，避免在 hpgl.js 里凭空发明固件延时指令
         * （没有资料佐证力宇支持 `PG1;` 之类，发出去只会被当未知指令丢掉）。
         */
        if (line.trim() === '!PG;') {
          this.pushLog('  机械归位中，等待机器到位…');
          await this._sleep(HOME_DWELL_MS, { capped: false });
        }

        const pct = Math.round((this.current.sent / this.current.lines.length) * 100);
        this.emit('progress', {
          jobId: job.id,
          sent: this.current.sent,
          total: this.current.lines.length,
          percent: pct,
          elapsedMs: Date.now() - this.startedAt,
          etaMs: this._estimateEta(i, this.current.lines.length, perLineMs),
        });

        // 喂字节延时。控制板 UST 接收完才算真的走完这一步
        const lineMs = ((line.length + 1) / (job.baud / 10)) * 1000 / BAUD_EFFICIENCY;
        if (lineMs > 0) await this._sleep(lineMs);
      }

      if (stopped) {
        this.current.status = 'aborted';
        this.pushLog(`■ 已中止：${job.name}（下发 ${this.current.sent}/${this.current.lines.length} 行）`);
        this.setState(JobState.ABORTED);
      } else {
        this.current.status = 'done';
        this.pushLog(`✔ 完成：${job.name}`);
        // 机器走完最后一段 + 回位
        await this._sleep(800);
        this.setState(JobState.DONE, job.name);
      }
      this.emit('jobdone', { id: job.id, status: this.current.status });

      /**
       * 入历史前剥掉重字段。
       *
       * `this.current` 里带着完整的 `text`（几十 KB）和 `lines` 数组
       * （每行一个字符串，5000 行能到 400KB+）。历史保留 50 条，
       * 照原样留着就是几十 MB 常驻——服务跑几天内存只涨不降。
       *
       * 历史只用于界面展示（名字、状态、进度、字节数），
       * 指令全文没有展示价值，所以只留字节数与行数。
       */
      this.history.push({
        id: this.current.id,
        name: this.current.name,
        status: this.current.status,
        createdAt: this.current.createdAt,
        meta: this.current.meta,
        bytes: this.current.text.length,
        totalLines: this.current.lines.length,
        sent: this.current.sent,
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
      this.pushLog('⏸ 已暂停');
    }
  }

  resume() {
    if (this.state === JobState.PAUSED) {
      this.startedAt = Date.now() - this.accumulatedMs;
      this.setState(JobState.RUNNING);
      this.pushLog('▶ 已继续');
    }
  }

  /** 软停止：跑完当前行就停。刀仍处于抬起状态（指令流里每行前都有 PU） */
  stop() {
    if (this.busy) {
      this.setState(JobState.STOPPING);
      this.pushLog('■ 请求停止…');
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
    this.pushLog('⛔ 急停（已抬刀，未发送任何移动指令）');
    if (this.transport.open) {
      this.transport.write('PU;\n').catch(() => {});
    }
  }
}
