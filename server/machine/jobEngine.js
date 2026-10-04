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
    const out = this.history.slice(-20).map((j) => ({
      id: j.id, name: j.name, status: j.status,
      totalLines: j.lines.length, sentLines: j.sent || 0,
      bytes: j.text.length, createdAt: j.createdAt, meta: j.meta,
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
      this.history.push(this.current);
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

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.min(ms, 200)));
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

  /** 急停：立刻断流并抬刀 */
  emergencyStop() {
    this.queue = [];
    this.setState(JobState.STOPPING);
    this.pushLog('⛔ 急停');
    if (this.transport.open) {
      this.transport.write('PU;PA0,0;\n').catch(() => {});
    }
  }
}
