/**
 * 图片矢量化与 AI 降噪平滑引擎 (Image to Vector Converter with AI Denoising)
 * 专门针对 AI 生成图像 (Midjourney / Stable Diffusion / DALL-E) 及线稿、手绘图
 * 在写字机/绘图仪 (Pen Plotter / Vinyl Cutter) 上的应用场景设计。
 *
 * 核心特性：
 * 1. 栅格预处理：双边保边滤波 (Bilateral Filter) + Otsu 自动阈值 + 连通域孤岛面积过滤 (Turdsize)
 * 2. 矢量提取：单线中心线骨架 (Zhang-Suen Thinning + Spur Pruning) 与 轮廓描边 (Marching Squares)
 * 3. 几何后处理：RDP 折线抽稀 + Chaikin 曲线细分平滑 + 微短路径过滤
 */

import { t } from './i18n.js';

export class Vectorizer {
  constructor(options = {}) {
    this.onImport = options.onImport || null;
    this.toast = options.toast || console.log;

    this.state = {
      image: null,
      fileName: 'image.png',
      width: 0,
      height: 0,
      activeTab: 'vector', // 'vector' | 'binary' | 'overlay' | 'original'
      
      // 参数
      preset: 'ai',
      mode: 'centerline', // 'centerline' | 'outline'
      bilateralRadius: 2,
      minIslandArea: 25,
      threshold: 140,
      autoOtsu: true,
      invert: false,
      spurThreshold: 6,
      rdpEpsilon: 1.2,
      chaikinIter: 2,
      minPathLength: 12,

      // 产物
      paths: [],
      svgString: '',
      binaryGrid: null,
      stats: { paths: 0, nodes: 0, lengthMm: 0, timeMs: 0 },
      isProcessing: false,
    };

    this.dom = {};
  }

  init() {
    this.cacheDom();
    this.bindEvents();
  }

  cacheDom() {
    const $ = (id) => document.getElementById(id);
    this.dom = {
      modal: $('vectorizeModal'),
      btnClose: $('btnCloseVectorizer'),
      dropzone: $('vecDropzone'),
      dropHint: $('vecDropHint'),
      viewContainer: $('vecViewContainer'),
      fileInput: $('vecFileInput'),
      btnSelectFile: $('btnSelectVecFile'),
      btnLoadDemo: $('btnVecLoadDemo'),
      btnChangeImg: $('btnVecChangeImg'),
      sourceCanvas: $('vecSourceCanvas'),
      binaryCanvas: $('vecBinaryCanvas'),
      svgWrap: $('vecSvgWrap'),
      statusTag: $('vecStatusTag'),

      tabs: document.querySelectorAll('.vec-tab'),
      presets: document.querySelectorAll('.vec-preset-btn'),
      modeCards: {
        centerline: $('modeCenterlineCard'),
        outline: $('modeOutlineCard'),
      },

      // Sliders & inputs
      bilateral: $('vecBilateral'),
      valBilateral: $('valBilateral'),
      island: $('vecIsland'),
      valIsland: $('valIsland'),
      threshold: $('vecThreshold'),
      valThreshold: $('valThreshold'),
      btnAutoOtsu: $('btnAutoOtsu'),
      invert: $('vecInvert'),
      spur: $('vecSpur'),
      valSpur: $('valSpur'),
      rowSpur: $('rowSpurPrune'),
      simplify: $('vecSimplify'),
      valSimplify: $('valSimplify'),
      smooth: $('vecSmooth'),
      valSmooth: $('valSmooth'),
      minPath: $('vecMinPath'),
      valMinPath: $('valMinPath'),

      // Stats
      statPaths: $('vecStatPaths'),
      statNodes: $('vecStatNodes'),
      statLen: $('vecStatLen'),
      statTime: $('vecStatTime'),

      // Footer
      btnReset: $('btnVecReset'),
      btnDownload: $('btnVecDownloadSvg'),
      btnApply: $('btnVecApply'),
    };
  }

  bindEvents() {
    const d = this.dom;
    if (!d.modal) return;

    d.btnClose?.addEventListener('click', () => this.close());
    d.modal.addEventListener('click', (e) => {
      if (e.target === d.modal) this.close();
    });

    // File selection & drop
    d.btnSelectFile?.addEventListener('click', () => d.fileInput.click());
    d.btnChangeImg?.addEventListener('click', () => d.fileInput.click());
    d.fileInput?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) this.loadFile(f);
      e.target.value = '';
    });

    d.dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      d.dropzone.classList.add('dragover');
    });
    d.dropzone?.addEventListener('dragleave', () => d.dropzone.classList.remove('dragover'));
    d.dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      d.dropzone.classList.remove('dragover');
      const f = e.dataTransfer.files?.[0];
      if (f && f.type.startsWith('image/')) this.loadFile(f);
    });

    d.btnLoadDemo?.addEventListener('click', () => this.loadDemoLineart());

    // Tabs
    d.tabs?.forEach((tab) => {
      tab.addEventListener('click', () => {
        d.tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        this.state.activeTab = tab.dataset.tab;
        this.updateViewMode();
      });
    });

    // Presets
    d.presets?.forEach((btn) => {
      btn.addEventListener('click', () => {
        d.presets.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.applyPreset(btn.dataset.preset);
      });
    });

    // Tracing mode
    document.querySelectorAll('input[name="vecMode"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        this.state.mode = e.target.value;
        d.modeCards.centerline?.classList.toggle('active', this.state.mode === 'centerline');
        d.modeCards.outline?.classList.toggle('active', this.state.mode === 'outline');
        if (d.rowSpur) {
          d.rowSpur.style.display = this.state.mode === 'centerline' ? 'block' : 'none';
        }
        this.triggerProcess();
      });
    });

    // Sliders
    const bindSlider = (input, display, key, suffix = '') => {
      input?.addEventListener('input', () => {
        const val = parseFloat(input.value);
        this.state[key] = val;
        if (display) display.textContent = val + suffix;
        this.triggerProcess();
      });
    };

    bindSlider(d.bilateral, d.valBilateral, 'bilateralRadius');
    bindSlider(d.island, d.valIsland, 'minIslandArea', ' px²');
    bindSlider(d.threshold, d.valThreshold, 'threshold');
    bindSlider(d.spur, d.valSpur, 'spurThreshold', ' px');
    bindSlider(d.simplify, d.valSimplify, 'rdpEpsilon', ' px');
    bindSlider(d.smooth, d.valSmooth, 'chaikinIter');
    bindSlider(d.minPath, d.valMinPath, 'minPathLength', ' px');

    d.btnAutoOtsu?.addEventListener('click', () => {
      this.computeAndApplyOtsu();
      this.triggerProcess();
    });

    d.invert?.addEventListener('change', (e) => {
      this.state.invert = e.target.checked;
      this.triggerProcess();
    });

    d.btnReset?.addEventListener('click', () => this.resetParams());

    d.btnDownload?.addEventListener('click', () => this.downloadSvg());

    d.btnApply?.addEventListener('click', () => this.applyToCanvas());
  }

  open() {
    if (this.dom.modal) this.dom.modal.style.display = 'grid';
    if (!this.state.image) {
      this.loadDemoLineart();
    }
  }

  close() {
    if (this.dom.modal) this.dom.modal.style.display = 'none';
  }

  applyPreset(name) {
    this.state.preset = name;
    switch (name) {
      case 'none':
        this.state.bilateralRadius = 0;
        this.state.minIslandArea = 0;
        this.state.spurThreshold = 0;
        this.state.rdpEpsilon = 0.6;
        this.state.chaikinIter = 0;
        break;
      case 'light':
        this.state.bilateralRadius = 1;
        this.state.minIslandArea = 8;
        this.state.spurThreshold = 3;
        this.state.rdpEpsilon = 0.8;
        this.state.chaikinIter = 1;
        break;
      case 'ai': // 默认 AI 噪点优化
        this.state.bilateralRadius = 2;
        this.state.minIslandArea = 25;
        this.state.spurThreshold = 6;
        this.state.rdpEpsilon = 1.2;
        this.state.chaikinIter = 2;
        break;
      case 'heavy':
        this.state.bilateralRadius = 4;
        this.state.minIslandArea = 60;
        this.state.spurThreshold = 10;
        this.state.rdpEpsilon = 2.0;
        this.state.chaikinIter = 3;
        break;
    }
    this.syncControls();
    this.triggerProcess();
  }

  syncControls() {
    const d = this.dom;
    if (d.bilateral) d.bilateral.value = this.state.bilateralRadius;
    if (d.valBilateral) d.valBilateral.textContent = this.state.bilateralRadius;

    if (d.island) d.island.value = this.state.minIslandArea;
    if (d.valIsland) d.valIsland.textContent = this.state.minIslandArea + ' px²';

    if (d.threshold) d.threshold.value = this.state.threshold;
    if (d.valThreshold) d.valThreshold.textContent = this.state.threshold;

    if (d.spur) d.spur.value = this.state.spurThreshold;
    if (d.valSpur) d.valSpur.textContent = this.state.spurThreshold + ' px';

    if (d.simplify) d.simplify.value = this.state.rdpEpsilon;
    if (d.valSimplify) d.valSimplify.textContent = this.state.rdpEpsilon + ' px';

    if (d.smooth) d.smooth.value = this.state.chaikinIter;
    if (d.valSmooth) d.valSmooth.textContent = this.state.chaikinIter;

    if (d.minPath) d.minPath.value = this.state.minPathLength;
    if (d.valMinPath) d.valMinPath.textContent = this.state.minPathLength + ' px';
  }

  resetParams() {
    this.applyPreset('ai');
  }

  loadFile(file) {
    this.state.fileName = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        this.setImage(img, file.name);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  /** 载入内置的 AI 风格线稿测试样本（模拟带噪点与扩散微毛刺的机械写字机测试图） */
  loadDemoLineart() {
    const w = 500, h = 500;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');

    // 白色背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 绘制一个可爱的 AI 生图风格绘图仪吉祥物 (SparkMinds Plotter Mascot)
    // 头部外框
    ctx.beginPath();
    ctx.arc(250, 200, 110, 0, Math.PI * 2);
    ctx.stroke();

    // 眼睛
    ctx.beginPath();
    ctx.arc(205, 185, 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(295, 185, 20, 0, Math.PI * 2);
    ctx.stroke();

    // 眼珠
    ctx.fillStyle = '#111111';
    ctx.beginPath();
    ctx.arc(205, 185, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(295, 185, 8, 0, Math.PI * 2);
    ctx.fill();

    // 微笑
    ctx.beginPath();
    ctx.arc(250, 215, 45, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();

    // 身体 / 底座
    ctx.beginPath();
    ctx.moveTo(160, 310);
    ctx.lineTo(340, 310);
    ctx.lineTo(380, 420);
    ctx.lineTo(120, 420);
    ctx.closePath();
    ctx.stroke();

    // 刻字机横梁与笔架
    ctx.beginPath();
    ctx.moveTo(80, 360);
    ctx.lineTo(420, 360);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(250, 330);
    ctx.lineTo(250, 390);
    ctx.stroke();

    // 文字 SparkPlotter
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Plotter-One', 250, 470);

    // 模拟真实的 AI 生图高频散斑噪点 (Diffusion Grain / Islands)
    // 用于演示双边滤波与连通域面积过滤的强大降噪威力
    ctx.fillStyle = '#2b2b2b';
    const rand = (seed) => {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 220; i++) {
      const rx = rand(i * 3 + 1) * w;
      const ry = rand(i * 7 + 2) * h;
      const r = rand(i * 11 + 3) * 2.5 + 0.5;
      ctx.beginPath();
      ctx.arc(rx, ry, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const img = new Image();
    img.onload = () => this.setImage(img, 'AI-Sample-Lineart.png');
    img.src = c.toDataURL('image/png');
  }

  setImage(img, name) {
    this.state.image = img;
    this.state.fileName = name;

    // 限制处理尺寸至合适分辨率（如最大边 800px），保证在网页端毫秒级实时交互且细节充足
    const maxDim = 800;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }
    this.state.width = w;
    this.state.height = h;

    // 绘制原图到 Canvas
    const sc = this.dom.sourceCanvas;
    sc.width = w;
    sc.height = h;
    const ctx = sc.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    if (this.dom.dropHint) this.dom.dropHint.style.display = 'none';
    if (this.dom.viewContainer) this.dom.viewContainer.style.display = 'flex';

    this.computeAndApplyOtsu();
    this.triggerProcess();
  }

  computeAndApplyOtsu() {
    if (!this.dom.sourceCanvas) return;
    const ctx = this.dom.sourceCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, this.state.width, this.state.height);
    const data = imgData.data;

    // 统计灰度直方图
    const hist = new Int32Array(256);
    const total = this.state.width * this.state.height;
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      hist[gray]++;
    }

    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];

    let sumB = 0;
    let wB = 0;
    let maxVariance = 0;
    let bestThresh = 128;

    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;

      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;

      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVariance) {
        maxVariance = between;
        bestThresh = t;
      }
    }

    // 适度向暗部微调，使线稿更清晰
    this.state.threshold = Math.max(30, Math.min(230, bestThresh));
    if (this.dom.threshold) this.dom.threshold.value = this.state.threshold;
    if (this.dom.valThreshold) this.dom.valThreshold.textContent = this.state.threshold;
  }

  triggerProcess() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.process(), 50);
  }

  process() {
    if (!this.state.image || this.state.isProcessing) return;
    this.state.isProcessing = true;
    if (this.dom.statusTag) {
      this.dom.statusTag.textContent = t('vectorizer.statusProcessing') || '处理中…';
      this.dom.statusTag.classList.remove('highlight');
    }

    const startTime = performance.now();
    const w = this.state.width;
    const h = this.state.height;
    const ctx = this.dom.sourceCanvas.getContext('2d');
    const srcData = ctx.getImageData(0, 0, w, h);

    // 1. 灰度提取与反转
    const gray = new Uint8Array(w * h);
    const d = srcData.data;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }

    // 2. 双边保边滤波 (Bilateral Filter Approximation)
    // 抹平 AI 扩散微纹理，保留关键边缘梯度
    let smoothedGray = gray;
    if (this.state.bilateralRadius > 0) {
      smoothedGray = this.applyBilateral(gray, w, h, this.state.bilateralRadius);
    }

    // 3. 二值化 (Thresholding)
    // 1 代表前景(线/色块)，0 代表背景
    const thresh = this.state.threshold;
    const invert = this.state.invert;
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      const isDark = smoothedGray[i] < thresh;
      binary[i] = invert ? (isDark ? 0 : 1) : (isDark ? 1 : 0);
    }

    // 4. 连通域孤岛碎斑剔除 (Connected Component Area Filter / Turdsize)
    let cleanedBinary = binary;
    if (this.state.minIslandArea > 0) {
      cleanedBinary = this.filterIslands(binary, w, h, this.state.minIslandArea);
    }
    this.state.binaryGrid = cleanedBinary;

    // 5. 渲染二值图到 Canvas 供预览
    this.renderBinaryCanvas(cleanedBinary, w, h);

    // 6. 核心矢量化抽取 (Tracing)
    let rawPaths = [];
    if (this.state.mode === 'centerline') {
      // 单线骨架提取
      const skeleton = this.zhangSuenThinning(cleanedBinary, w, h);
      rawPaths = this.traceSkeleton(skeleton, w, h, {
        spurThreshold: this.state.spurThreshold,
      });
    } else {
      // 轮廓描边提取
      rawPaths = this.traceOutline(cleanedBinary, w, h);
    }

    // 7. 几何后处理：RDP 抽稀 + Chaikin 曲线平滑 + 过滤微短路径
    const finalPaths = [];
    let totalNodes = 0;
    let totalLenPx = 0;

    for (const poly of rawPaths) {
      if (poly.length < 2) continue;
      // RDP 折线化抽稀
      const simplified = this.rdpSimplify(poly, this.state.rdpEpsilon);
      // Chaikin 曲线平滑
      const smoothed = this.chaikinSmooth(simplified, this.state.chaikinIter);

      let len = 0;
      for (let i = 0; i < smoothed.length - 1; i++) {
        len += Math.hypot(smoothed[i + 1].x - smoothed[i].x, smoothed[i + 1].y - smoothed[i].y);
      }

      if (len >= this.state.minPathLength) {
        finalPaths.push(smoothed);
        totalNodes += smoothed.length;
        totalLenPx += len;
      }
    }

    this.state.paths = finalPaths;

    // 8. 生成标准 SVG 并渲染
    this.state.svgString = this.generateSvg(finalPaths, w, h);
    this.renderSvgPreview(this.state.svgString);

    const elapsed = performance.now() - startTime;
    // 假设 96 DPI 下换算为物理毫米 (1px ≈ 0.264583 mm)
    const lenMm = totalLenPx * 0.264583;

    this.state.stats = {
      paths: finalPaths.length,
      nodes: totalNodes,
      lengthMm: Math.round(lenMm),
      timeMs: Math.round(elapsed),
    };

    this.updateStatsDisplay();
    this.updateViewMode();

    this.state.isProcessing = false;
    if (this.dom.statusTag) {
      this.dom.statusTag.textContent = t('vectorizer.statusReady') || '就绪';
      this.dom.statusTag.classList.add('highlight');
    }
  }

  // ------------------------------------------------------------- 图像与滤波算法
  /** 双边保边滤波近似实现 */
  applyBilateral(gray, w, h, r) {
    const out = new Uint8Array(w * h);
    const rangeSigma = 32;
    const inv2RangeSigma2 = 1 / (2 * rangeSigma * rangeSigma);

    // 空间核权重缓存
    const spatialWeights = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= r * r) {
          spatialWeights.push({ dx, dy, w: Math.exp(-dist2 / (2 * r * r)) });
        }
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const centerIdx = y * w + x;
        const centerVal = gray[centerIdx];
        let sum = 0;
        let sumW = 0;

        for (let k = 0; k < spatialWeights.length; k++) {
          const sw = spatialWeights[k];
          const nx = x + sw.dx;
          const ny = y + sw.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

          const nVal = gray[ny * w + nx];
          const diff = nVal - centerVal;
          const rangeW = Math.exp(-diff * diff * inv2RangeSigma2);
          const weight = sw.w * rangeW;

          sum += nVal * weight;
          sumW += weight;
        }
        out[centerIdx] = Math.round(sum / sumW);
      }
    }
    return out;
  }

  /** 连通域面积过滤（孤岛去除） */
  filterIslands(binary, w, h, minArea) {
    const visited = new Uint8Array(w * h);
    const out = new Uint8Array(binary);
    const queue = new Int32Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const startIdx = y * w + x;
        if (!out[startIdx] || visited[startIdx]) continue;

        let qHead = 0;
        let qTail = 0;
        queue[qTail++] = startIdx;
        visited[startIdx] = 1;

        while (qHead < qTail) {
          const curr = queue[qHead++];
          const cy = Math.floor(curr / w);
          const cx = curr % w;

          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < 0 || nx >= w) continue;
              const nidx = ny * w + nx;
              if (out[nidx] && !visited[nidx]) {
                visited[nidx] = 1;
                queue[qTail++] = nidx;
              }
            }
          }
        }

        if (qTail < minArea) {
          for (let i = 0; i < qTail; i++) {
            out[queue[i]] = 0;
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------- 骨架与单线提取
  /** Zhang-Suen 快速细化算法 */
  zhangSuenThinning(binary, w, h) {
    const grid = new Uint8Array(binary);
    let changed = true;
    const toDelete = [];

    while (changed) {
      changed = false;

      // 子迭代 1
      toDelete.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = y * w + x;
          if (!grid[idx]) continue;

          const p2 = grid[(y - 1) * w + x];
          const p3 = grid[(y - 1) * w + (x + 1)];
          const p4 = grid[y * w + (x + 1)];
          const p5 = grid[(y + 1) * w + (x + 1)];
          const p6 = grid[(y + 1) * w + x];
          const p7 = grid[(y + 1) * w + (x - 1)];
          const p8 = grid[y * w + (x - 1)];
          const p9 = grid[(y - 1) * w + (x - 1)];

          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;

          const p = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let i = 0; i < 8; i++) {
            if (p[i] === 0 && p[i + 1] === 1) a++;
          }
          if (a !== 1) continue;

          if (p2 * p4 * p6 !== 0) continue;
          if (p4 * p6 * p8 !== 0) continue;

          toDelete.push(idx);
        }
      }
      if (toDelete.length > 0) {
        changed = true;
        for (let i = 0; i < toDelete.length; i++) grid[toDelete[i]] = 0;
      }

      // 子迭代 2
      toDelete.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = y * w + x;
          if (!grid[idx]) continue;

          const p2 = grid[(y - 1) * w + x];
          const p3 = grid[(y - 1) * w + (x + 1)];
          const p4 = grid[y * w + (x + 1)];
          const p5 = grid[(y + 1) * w + (x + 1)];
          const p6 = grid[(y + 1) * w + x];
          const p7 = grid[(y + 1) * w + (x - 1)];
          const p8 = grid[y * w + (x - 1)];
          const p9 = grid[(y - 1) * w + (x - 1)];

          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;

          const p = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let i = 0; i < 8; i++) {
            if (p[i] === 0 && p[i + 1] === 1) a++;
          }
          if (a !== 1) continue;

          if (p2 * p4 * p8 !== 0) continue;
          if (p2 * p6 * p8 !== 0) continue;

          toDelete.push(idx);
        }
      }
      if (toDelete.length > 0) {
        changed = true;
        for (let i = 0; i < toDelete.length; i++) grid[toDelete[i]] = 0;
      }
    }

    return grid;
  }

  /** 骨架路径拓扑遍历与毛刺修剪 (Spur Pruning) */
  traceSkeleton(skeleton, w, h, opts = {}) {
    const spurThreshold = opts.spurThreshold || 0;
    const grid = new Uint8Array(skeleton);

    const neighbors = [
      [-1, -1], [0, -1], [1, -1],
      [-1,  0],          [1,  0],
      [-1,  1], [0,  1], [1,  1]
    ];

    const getNeighbors = (x, y) => {
      const res = [];
      for (let i = 0; i < 8; i++) {
        const nx = x + neighbors[i][0];
        const ny = y + neighbors[i][1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && grid[ny * w + nx]) {
          res.push({ x: nx, y: ny, idx: ny * w + nx });
        }
      }
      return res;
    };

    // 毛刺修剪 (Spur Pruning)
    if (spurThreshold > 0) {
      let pruned = true;
      let maxPasses = 4;
      while (pruned && maxPasses-- > 0) {
        pruned = false;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            if (!grid[idx]) continue;
            const nbs = getNeighbors(x, y);
            if (nbs.length === 1) {
              const branch = [{ x, y, idx }];
              let curr = nbs[0];
              let prevIdx = idx;
              while (true) {
                branch.push(curr);
                const nextNbs = getNeighbors(curr.x, curr.y).filter(n => n.idx !== prevIdx);
                if (nextNbs.length === 1) {
                  prevIdx = curr.idx;
                  curr = nextNbs[0];
                } else {
                  break;
                }
              }
              if (branch.length <= spurThreshold) {
                for (const pt of branch) {
                  const deg = getNeighbors(pt.x, pt.y).length;
                  if (deg <= 2) {
                    grid[pt.idx] = 0;
                    pruned = true;
                  }
                }
              }
            }
          }
        }
      }
    }

    const visited = new Uint8Array(w * h);
    const paths = [];

    const traceFrom = (startX, startY) => {
      const path = [{ x: startX, y: startY }];
      visited[startY * w + startX] = 1;
      let currX = startX;
      let currY = startY;

      while (true) {
        const nbs = getNeighbors(currX, currY).filter(n => !visited[n.idx]);
        if (nbs.length === 0) break;
        const next = nbs[0];
        visited[next.idx] = 1;
        path.push({ x: next.x, y: next.y });
        currX = next.x;
        currY = next.y;
      }
      return path;
    };

    // 端点优先
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (grid[idx] && !visited[idx]) {
          if (getNeighbors(x, y).length === 1) {
            const p = traceFrom(x, y);
            if (p.length >= 2) paths.push(p);
          }
        }
      }
    }

    // 交叉点
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (grid[idx] && !visited[idx]) {
          if (getNeighbors(x, y).length > 2) {
            const p = traceFrom(x, y);
            if (p.length >= 2) paths.push(p);
          }
        }
      }
    }

    // 剩余闭合回路
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (grid[idx] && !visited[idx]) {
          const p = traceFrom(x, y);
          if (p.length >= 2) paths.push(p);
        }
      }
    }

    return paths;
  }

  // ------------------------------------------------------------- 轮廓描边 (Outline)
  traceOutline(binary, w, h) {
    const segments = [];
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const tl = binary[y * w + x];
        const tr = binary[y * w + (x + 1)];
        const br = binary[(y + 1) * w + (x + 1)];
        const bl = binary[(y + 1) * w + x];

        const state = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
        if (state === 0 || state === 15) continue;

        const top = { x: x + 0.5, y };
        const right = { x: x + 1, y: y + 0.5 };
        const bottom = { x: x + 0.5, y: y + 1 };
        const left = { x, y: y + 0.5 };

        switch (state) {
          case 1: case 14: segments.push([left, bottom]); break;
          case 2: case 13: segments.push([bottom, right]); break;
          case 3: case 12: segments.push([left, right]); break;
          case 4: case 11: segments.push([top, right]); break;
          case 5: segments.push([left, top], [bottom, right]); break;
          case 6: case 9: segments.push([top, bottom]); break;
          case 7: case 8: segments.push([left, top]); break;
          case 10: segments.push([top, right], [left, bottom]); break;
        }
      }
    }

    const key = pt => `${Math.round(pt.x * 10)},${Math.round(pt.y * 10)}`;
    const adj = new Map();
    for (let i = 0; i < segments.length; i++) {
      const [p1, p2] = segments[i];
      const k1 = key(p1), k2 = key(p2);
      if (!adj.has(k1)) adj.set(k1, []);
      if (!adj.has(k2)) adj.set(k2, []);
      adj.get(k1).push({ pt: p2, key: k2, segIdx: i });
      adj.get(k2).push({ pt: p1, key: k1, segIdx: i });
    }

    const usedSegs = new Uint8Array(segments.length);
    const polylines = [];

    for (let i = 0; i < segments.length; i++) {
      if (usedSegs[i]) continue;
      usedSegs[i] = 1;
      const poly = [segments[i][0], segments[i][1]];

      let extended = true;
      while (extended) {
        extended = false;
        const last = poly[poly.length - 1];
        const nbs = adj.get(key(last)) || [];
        for (const edge of nbs) {
          if (!usedSegs[edge.segIdx]) {
            usedSegs[edge.segIdx] = 1;
            poly.push(edge.pt);
            extended = true;
            break;
          }
        }
      }
      if (poly.length >= 3) polylines.push(poly);
    }

    return polylines;
  }

  // ------------------------------------------------------------- 几何平滑与抽稀
  rdpSimplify(points, epsilon) {
    if (points.length <= 2 || epsilon <= 0) return points;
    let dmax = 0;
    let index = 0;
    const p1 = points[0];
    const p2 = points[points.length - 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lenSq = dx * dx + dy * dy;

    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      let d;
      if (lenSq === 0) {
        d = Math.hypot(p.x - p1.x, p.y - p1.y);
      } else {
        const t = Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / lenSq));
        const projX = p1.x + t * dx;
        const projY = p1.y + t * dy;
        d = Math.hypot(p.x - projX, p.y - projY);
      }
      if (d > dmax) {
        dmax = d;
        index = i;
      }
    }

    if (dmax > epsilon) {
      const rec1 = this.rdpSimplify(points.slice(0, index + 1), epsilon);
      const rec2 = this.rdpSimplify(points.slice(index), epsilon);
      return rec1.slice(0, rec1.length - 1).concat(rec2);
    }
    return [p1, p2];
  }

  chaikinSmooth(points, iterations = 1) {
    if (points.length <= 2 || iterations <= 0) return points;
    let cur = points;
    for (let it = 0; it < iterations; it++) {
      const smoothed = [cur[0]];
      for (let i = 0; i < cur.length - 1; i++) {
        const p0 = cur[i];
        const p1 = cur[i + 1];
        smoothed.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
        smoothed.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
      smoothed.push(cur[cur.length - 1]);
      cur = smoothed;
    }
    return cur;
  }

  // ------------------------------------------------------------- SVG 生成与预览
  generateSvg(paths, w, h) {
    let dStr = '';
    for (const path of paths) {
      if (!path.length) continue;
      dStr += `M ${path[0].x.toFixed(2)} ${path[0].y.toFixed(2)} `;
      for (let i = 1; i < path.length; i++) {
        dStr += `L ${path[i].x.toFixed(2)} ${path[i].y.toFixed(2)} `;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n` +
           `  <path d="${dStr.trim()}" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />\n` +
           `</svg>`;
  }

  renderBinaryCanvas(binary, w, h) {
    const bc = this.dom.binaryCanvas;
    if (!bc) return;
    bc.width = w;
    bc.height = h;
    const ctx = bc.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const d = imgData.data;

    for (let i = 0; i < binary.length; i++) {
      const val = binary[i] ? 20 : 255; // 黑色线，白色底
      const idx = i * 4;
      d[idx] = val;
      d[idx + 1] = val;
      d[idx + 2] = val;
      d[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  renderSvgPreview(svgStr) {
    if (!this.dom.svgWrap) return;
    this.dom.svgWrap.innerHTML = svgStr;
  }

  updateViewMode() {
    const tab = this.state.activeTab;
    const { sourceCanvas, binaryCanvas, svgWrap } = this.dom;
    if (!sourceCanvas || !binaryCanvas || !svgWrap) return;

    sourceCanvas.style.display = (tab === 'original' || tab === 'overlay') ? 'block' : 'none';
    sourceCanvas.style.opacity = tab === 'overlay' ? '0.35' : '1.0';

    binaryCanvas.style.display = tab === 'binary' ? 'block' : 'none';
    binaryCanvas.style.opacity = '1.0';

    svgWrap.style.display = (tab === 'vector' || tab === 'overlay') ? 'block' : 'none';
  }

  updateStatsDisplay() {
    const s = this.state.stats;
    const d = this.dom;
    if (d.statPaths) d.statPaths.textContent = s.paths;
    if (d.statNodes) d.statNodes.textContent = s.nodes;
    if (d.statLen) d.statLen.textContent = s.lengthMm + ' mm';
    if (d.statTime) d.statTime.textContent = s.timeMs + ' ms';
  }

  downloadSvg() {
    if (!this.state.svgString) {
      this.toast(t('vectorizer.toastNoImage') || '请先上传并处理图片', 'err');
      return;
    }
    const blob = new Blob([this.state.svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (this.state.fileName || 'vectorized').replace(/\.[^.]+$/, '') + '.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async applyToCanvas() {
    if (!this.state.svgString || !this.state.paths.length) {
      this.toast(t('vectorizer.toastNoImage') || '没有可导入的矢量路径', 'err');
      return;
    }
    const svgName = (this.state.fileName || 'vectorized').replace(/\.[^.]+$/, '') + '.svg';
    if (this.onImport) {
      this.close();
      await this.onImport(this.state.svgString, svgName);
    }
  }
}
