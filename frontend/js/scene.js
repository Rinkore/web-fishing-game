/*
 * 网页钓鱼小游戏 - 渔场实况场景层（PxScene）
 * 零依赖 Canvas 渲染器：为钓鱼页 .px-scene 绘制代码生成的像素风场景 ——
 * 天空渐变 / 星空 / 月亮(太阳·极光) / 多层山脊视差 / 岸线树影 / 水面倒影(正弦波纹) / 氛围粒子。
 * 低分辨率离屏缓冲 + image-rendering:pixelated 放大，天然像素画质感；
 * 换渔场只换调色板与地形种子，正式美术图就绪后可整体替换本层而不动游戏逻辑。
 */
window.PxScene = (function () {
  'use strict';

  // ---------- 工具 ----------
  function mulberry32(seed) {           // 地形生成要稳定：同一渔场每次进入长得一样
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------- 各渔场调色板 ----------
  // waterline：水面线（从顶部算起的高度比例），与 .px-scene-water 的 62% 水位一致
  const WATERLINE = 0.38;
  const PALETTES = {
    // 静水湖：紫调黄昏 + 雪山 + 秋色树（对标 Cast n Chill 氛围）
    stillwater: {
      img: 'assets/scene/stillwater.png', imgLine: 0.62,   // 手绘底图；imgLine = 图中水线高度占比
      sky: ['#1c1836', '#3a2c5c', '#7a5588', '#c98a94'],
      stars: { n: 42, color: '#e9defc' },
      moon: { x: 0.76, y: 0.13, r: 6, color: '#f2e8fa', glow: '#b49ae0' },
      ridges: [
        { base: 0.30, amp: 0.11, color: '#5d4c7d', snow: '#c3b3e0', depth: 0.15, seed: 101 },
        { base: 0.35, amp: 0.075, color: '#443a60', snow: '#7d6ea3', depth: 0.32, seed: 202 },
      ],
      shore: { color: '#2f2747', depth: 0.6 },
      trees: { kind: 'broad', n: 26, colors: ['#b85c4a', '#c9863d', '#93505f', '#77813f'], depth: 0.6, seed: 303 },
      water: { top: '#4a3a78', bottom: '#161233', streak: '#d8c2ff', amp: 1.0, speed: 1.0 },
      particle: 'sparkle',
    },
    // 急流峡谷：清晨青绿 + 针叶林 + 水雾
    rapids: {
      sky: ['#a8d4e2', '#cfe8e4', '#e9f2df', '#f6ecd8'],
      stars: null,
      moon: { x: 0.2, y: 0.12, r: 5, color: '#fff6da', glow: '#ffe9b0' },   // 早上的太阳
      ridges: [
        { base: 0.26, amp: 0.10, color: '#6f9a8c', snow: null, depth: 0.15, seed: 404 },
        { base: 0.33, amp: 0.08, color: '#43706b', snow: '#cfe4da', depth: 0.32, seed: 505 },
      ],
      shore: { color: '#2c4f49', depth: 0.6 },
      trees: { kind: 'conifer', n: 30, colors: ['#2f5d46', '#3c7050', '#265040'], depth: 0.6, seed: 606 },
      water: { top: '#3f7f8c', bottom: '#14384a', streak: '#cfeee8', amp: 2.2, speed: 2.4 },
      particle: 'spray',
    },
    // 落日海滩：橙粉落日 + 棕榈剪影 + 金色飘萤
    sunset: {
      sky: ['#4a2c62', '#a04a68', '#e8765a', '#ffc46b'],
      stars: { n: 16, color: '#ffd9c9' },
      moon: { x: 0.5, y: 0.30, r: 9, color: '#ffd97a', glow: '#ffab5e' },   // 贴近海平面的落日
      ridges: [
        { base: 0.33, amp: 0.045, color: '#5a2f55', snow: null, depth: 0.15, seed: 707 },
      ],
      shore: { color: '#38203f', depth: 0.6 },
      trees: { kind: 'palm', n: 7, colors: ['#2e1b38'], depth: 0.6, seed: 808 },
      water: { top: '#c46a5e', bottom: '#3a2050', streak: '#ffd88f', amp: 1.2, speed: 1.2 },
      particle: 'mote',
    },
    // 霜月冰湖：深夜 + 满月 + 极光 + 落雪
    frostmoon: {
      sky: ['#060f24', '#0d2140', '#1b3a5c', '#2c5578'],
      stars: { n: 60, color: '#dceaff' },
      moon: { x: 0.68, y: 0.14, r: 8, color: '#eef6ff', glow: '#9ec8f0' },
      aurora: { color: '#6fe3b0', color2: '#6fb8e3' },
      ridges: [
        { base: 0.30, amp: 0.09, color: '#29435f', snow: '#a9c2da', depth: 0.15, seed: 909 },
        { base: 0.355, amp: 0.05, color: '#1d3349', snow: '#5f7d9c', depth: 0.32, seed: 1010 },
      ],
      shore: { color: '#16283c', depth: 0.6 },
      trees: { kind: 'conifer-snow', n: 24, colors: ['#22415c', '#2b4f6e'], depth: 0.6, seed: 1111 },
      water: { top: '#1d3a5c', bottom: '#081426', streak: '#a8d4f0', amp: 0.8, speed: 0.8 },
      particle: 'snow',
    },
    // 远洋：深夜深海 + 密星 + 荧光浮游（v0.19.0 出海；临时海域 sea:* 也映射到这份配色）
    ocean: {
      sky: ['#04091c', '#0a1830', '#12294a', '#1c3d63'],
      stars: { n: 70, color: '#cfe4ff' },
      moon: { x: 0.32, y: 0.16, r: 7, color: '#e8f2ff', glow: '#8fb8e8' },
      ridges: [
        { base: 0.28, amp: 0.05, color: '#0e2440', snow: null, depth: 0.15, seed: 1212 },
        { base: 0.33, amp: 0.03, color: '#0a1c33', snow: null, depth: 0.32, seed: 1313 },
      ],
      shore: { color: '#061225', depth: 0.6 },
      trees: { kind: 'none', n: 0, colors: [], depth: 0, seed: 1414 },
      water: { top: '#0f2f52', bottom: '#030b1a', streak: '#9fd8ff', amp: 1.6, speed: 1.6 },
      particle: 'sparkle',
    },
  };
  const FALLBACK = 'stillwater';

  // ---------- 场景构建（每个 渔场×尺寸 缓存一份） ----------
  function buildScene(pid, W, H) {
    const P = PALETTES[pid] || PALETTES[FALLBACK];
    const wl = Math.round(H * WATERLINE);
    const sc = { P: P, wl: wl, ridges: [], trees: [], stars: [], particles: [] };

    P.ridges.forEach(function (r) {
      const rnd = mulberry32(r.seed);
      const pts = [];
      const step = 8;                                  // 山脊顶点横向间距（缓冲像素）
      for (let x = -step * 2; x <= W + step * 2; x += step) {
        const peak = Math.sin(x * 0.045 + r.seed) * 0.5 + Math.sin(x * 0.013 + r.seed * 2) * 0.5;
        const y = H * r.base - (peak * 0.5 + 0.5) * H * r.amp - rnd() * H * r.amp * 0.4;
        pts.push([x, y]);
      }
      sc.ridges.push({ pts: pts, color: r.color, snow: r.snow, depth: r.depth });
    });

    const trnd = mulberry32(P.trees.seed);
    for (let i = 0; i < P.trees.n; i++) {
      sc.trees.push({
        x: trnd() * (W + 24) - 12,
        h: 6 + trnd() * 10,
        w: 4 + trnd() * 4,
        c: P.trees.colors[(trnd() * P.trees.colors.length) | 0],
      });
    }

    if (P.stars) {
      const srnd = mulberry32(9000 + P.stars.n);
      for (let i = 0; i < P.stars.n; i++) {
        sc.stars.push({
          x: srnd() * W, y: srnd() * wl * 0.8,
          s: srnd() < 0.2 ? 2 : 1,                     // 少量大星
          ph: srnd() * Math.PI * 2, sp: 0.6 + srnd() * 1.6,
        });
      }
    }

    const prnd = mulberry32(5000 + pid.length * 7);
    const pn = P.particle === 'snow' ? 46 : P.particle === 'spray' ? 34 : 26;
    for (let i = 0; i < pn; i++) {
      sc.particles.push({
        x: prnd() * W, y: prnd() * H,
        vx: 0, vy: 0, ph: prnd() * Math.PI * 2,
        sp: 0.4 + prnd() * 0.8, s: prnd() < 0.3 ? 2 : 1,
      });
    }
    return sc;
  }

  // ---------- 粒子行为 ----------
  function stepParticle(p, type, W, H, wl, dt, t) {
    if (type === 'snow') {
      p.y += (6 + p.sp * 8) * dt; p.x += Math.sin(t * 0.8 + p.ph) * 4 * dt;
      if (p.y > H) { p.y = -2; p.x = Math.random() * W; }
    } else if (type === 'sparkle') {
      // 漂浮微光：缓慢漂移，明灭由相位决定（draw 里算 alpha）
      p.x += Math.sin(t * 0.3 + p.ph) * 2.2 * dt; p.y += Math.cos(t * 0.23 + p.ph) * 1.6 * dt;
      if (p.x < -3) p.x = W + 2; if (p.x > W + 3) p.x = -2;
      if (p.y < -3) p.y = H + 2; if (p.y > H + 3) p.y = -2;
    } else if (type === 'mote') {
      // 金色飘萤：自水面向上缓升、左右摇曳
      p.y -= (3 + p.sp * 4) * dt; p.x += Math.sin(t * 1.1 + p.ph) * 5 * dt;
      if (p.y < H * 0.25) { p.y = wl + Math.random() * (H - wl) * 0.6; p.x = Math.random() * W; }
    } else if (type === 'spray') {
      // 水雾：从水面线附近喷起再落下
      p.vy += 30 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.y > wl + 3 || p.vy === 0) {
        p.x = Math.random() * W; p.y = wl - 1;
        p.vy = -(8 + Math.random() * 16); p.vx = (Math.random() - 0.5) * 8;
      }
    }
  }

  // ---------- 挂载与渲染 ----------
  function mount(el, groundId) {
    if (!el) return;
    // jsdom（测试环境）没有 Canvas：getContext 会抛 jsdomError，整层直接不挂
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return;
    let inst = el.__pxscene;
    if (!inst) {
      const cv = document.createElement('canvas');
      cv.className = 'px-scene-canvas';
      el.insertBefore(cv, el.firstChild);
      el.classList.add('px-scene-hd');
      const ctx = cv.getContext && cv.getContext('2d');
      if (!ctx) { inst = el.__pxscene = { dead: true }; return; }   // jsdom 等无 Canvas 环境：静默停用
      inst = el.__pxscene = {
        cv: cv, ctx: ctx,
        world: document.createElement('canvas'), wctx: null,
        pid: null, sc: null, ox: 0, tox: 0, t: 0, last: 0, raf: 0,
        pointer: false, sizeDirty: true, visible: true,
      };
      inst.wctx = inst.world.getContext('2d');
      if (!inst.wctx) { inst.dead = true; return; }
      el.addEventListener('pointermove', function (ev) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) { inst.tox = ((ev.clientX - r.left) / r.width - 0.5) * 2; inst.pointer = true; }
      });
      el.addEventListener('pointerleave', function () { inst.pointer = false; });
    }
    if (inst.dead) return;
    if (!inst.observing) {
      inst.observing = true;
      inst.sizeDirty = true;
      if (typeof ResizeObserver !== 'undefined') {
        inst.ro = new ResizeObserver(function () { inst.sizeDirty = true; });
        inst.ro.observe(el);
      }
      if (typeof IntersectionObserver !== 'undefined') {
        inst.io = new IntersectionObserver(function (entries) {
          inst.visible = entries[entries.length - 1].isIntersecting;
        });
        inst.io.observe(el);
      }
    }
    setGround(inst, groundId);
    if (!inst.raf) { inst.last = performance.now(); inst.raf = requestAnimationFrame(function f(now) { frame(el, inst, now); }); }
  }

  function setGround(inst, groundId) {
    if (inst.dead) return;
    // v0.19.0：临时海域（sea:* 前缀）与远洋共用深海配色
    let pid = FALLBACK;
    if (groundId) pid = groundId.indexOf('sea:') === 0 ? 'ocean' : (PALETTES[groundId] ? groundId : FALLBACK);
    if (inst.pid === pid) return;
    inst.pid = pid;
    resize(inst);
    loadImageFor(inst);
  }

  // 手绘场景底图（assets/scene/<渔场>.png）：有图就用图替代程序化山水，
  // 水面倒影 / 波纹 / 粒子 / 视差继续实时演算；图加载失败自动回退程序化场景
  function loadImageFor(inst) {
    const P = PALETTES[inst.pid] || PALETTES[FALLBACK];
    inst.img = null;
    if (!P.img || typeof Image === 'undefined') return;
    const im = new Image();
    const rec = { ready: false, pid: inst.pid, el: im };
    im.onload = function () { rec.ready = true; };
    im.onerror = function () { if (inst.img === rec) inst.img = null; };
    im.src = P.img;
    inst.img = rec;
  }

  function update(el, groundId) {
    if (!el || !el.__pxscene) { mount(el, groundId); return; }
    setGround(el.__pxscene, groundId);
  }

  function resize(inst) {
    const box = inst.cv.parentNode.getBoundingClientRect();
    inst.sizeDirty = false;
    const H = 144;                                       // 缓冲高度：像素颗粒度的来源
    const W = clamp(Math.round(H * (box.width / Math.max(box.height, 1))), 180, 560);
    // 比较最终缓冲尺寸：达到上下限后不能按未截断的宽高比反复重建。
    if (inst.sc && inst.cv.width === W && inst.cv.height === H && inst.scenePid === inst.pid) return;
    if (inst.cv.width !== W || inst.cv.height !== H) {
      inst.cv.width = W; inst.cv.height = H;
      inst.world.width = W; inst.world.height = H;
    }
    inst.scenePid = inst.pid;
    inst.sc = buildScene(inst.pid || FALLBACK, W, H);
    const P = inst.sc.P, wl = inst.sc.wl;
    inst.skyGradient = inst.wctx.createLinearGradient(0, 0, 0, wl);
    P.sky.forEach(function (c, i) { inst.skyGradient.addColorStop(i / (P.sky.length - 1), c); });
    inst.waterGradients = [1, 0.5].map(function (k) {
      const grad = inst.ctx.createLinearGradient(0, wl, 0, H);
      grad.addColorStop(0, rgba(P.water.top, 0.45 * k));
      grad.addColorStop(1, rgba(P.water.bottom, 0.82 * k));
      return grad;
    });
  }

  function frame(el, inst, now) {
    if (!el.isConnected) {
      inst.raf = 0;
      if (inst.ro) inst.ro.disconnect();
      if (inst.io) inst.io.disconnect();
      inst.observing = false;
      inst.visible = true;
      return;
    }
    inst.raf = requestAnimationFrame(function f(n) { frame(el, inst, n); });
    // 不可见时只保留生命周期检查，停止绘图与粒子计算。
    if (document.hidden || !inst.visible) { inst.last = now; return; }
    const motion = window.PlayerSettings ? window.PlayerSettings.motion() : 'full';
    const imageReady = !!(inst.img && inst.img.ready);
    // Static mode redraws only for size, ground, image or preference changes.
    if (motion === 'off' && inst.staticDrawn && !inst.sizeDirty && inst.motion === motion && inst.drawPid === inst.pid && inst.imageReady === imageReady) {
      inst.last = now; return;
    }
    if (motion === 'reduced' && inst.motion === motion && !inst.sizeDirty && now - (inst.drawTime || 0) < 1000 / 20) return;
    inst.drawTime = now; inst.motion = motion; inst.drawPid = inst.pid; inst.imageReady = imageReady; inst.staticDrawn = true;
    const dt = motion === 'off' ? 0 : clamp((now - inst.last) / 1000, 0, 0.05);
    inst.last = now; inst.t += dt;
    const t = motion === 'off' ? 0 : inst.t;

    // 尺寸跟随面板（布局变化 / 首次挂载时 box 为 0 的补偿）
    if (inst.sizeDirty || !inst.ro) resize(inst);
    const W = inst.cv.width, H = inst.cv.height, sc = inst.sc, P = sc.P, wl = sc.wl;

    // 视差：指针优先，无指针时缓慢自动漂移
    if (!inst.pointer) inst.tox = Math.sin(t * 0.07) * 0.35;
    inst.ox += (inst.tox - inst.ox) * Math.min(1, dt * 3);
    if (motion !== 'full') inst.ox = 0;
    const ox = inst.ox;

    const g = inst.wctx;                                  // 世界（水面以上）画进离屏
    g.clearRect(0, 0, W, H);

    // 手绘底图就绪 → 用图（上部 imgLine 区域 = 天空+山+岸，水线对齐 wl），程序化山水全部跳过
    const imgRec = inst.img;
    const imgOk = !!(imgRec && imgRec.ready && imgRec.pid === inst.pid);
    if (imgOk) {
      const im = imgRec.el;
      const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
      const srcH = ih * (P.imgLine || 0.6);
      const scale = Math.max(W / iw, wl / srcH);
      const dw = iw * scale, dh = srcH * scale;
      const dx = (W - dw) / 2 + ox * 6;                   // 整层小幅视差漂移
      const dy = wl - dh;                                 // 图片水线对齐画布水线
      g.drawImage(im, 0, 0, iw, srcH, dx, dy, dw, dh);
    }
    if (!imgOk) {
    // 天空
    g.fillStyle = inst.skyGradient; g.fillRect(0, 0, W, wl + 1);

    // 星星（明灭）
    if (sc.stars.length) {
      sc.stars.forEach(function (s) {
        const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
        g.fillStyle = rgba(P.stars.color, a.toFixed(2));
        g.fillRect(Math.round(s.x), Math.round(s.y), s.s, s.s);
        if (s.s === 2) {                                 // 大星加十字星芒
          g.fillStyle = rgba(P.stars.color, (a * 0.5).toFixed(2));
          g.fillRect(Math.round(s.x) - 1, Math.round(s.y), 1, 1);
          g.fillRect(Math.round(s.x) + 2, Math.round(s.y), 1, 1);
          g.fillRect(Math.round(s.x), Math.round(s.y) - 1, 1, 1);
          g.fillRect(Math.round(s.x), Math.round(s.y) + 2, 1, 1);
        }
      });
    }

    // 极光（霜月冰湖）：两条正弦光带，加色叠加
    if (P.aurora) {
      g.save(); g.globalCompositeOperation = 'lighter';
      for (let band = 0; band < 2; band++) {
        const col = band === 0 ? P.aurora.color : P.aurora.color2;
        const base = H * (0.10 + band * 0.07);
        for (let x = 0; x < W; x += 3) {
          const y = base + Math.sin(x * 0.03 + t * (0.5 + band * 0.2) + band * 2) * H * 0.035
            + Math.sin(x * 0.011 - t * 0.3) * H * 0.02;
          const a = 0.05 + 0.05 * Math.sin(x * 0.05 + t + band);
          const lg = g.createLinearGradient(0, y - 10, 0, y + 12);
          lg.addColorStop(0, rgba(col, 0));
          lg.addColorStop(0.5, rgba(col, a.toFixed(3)));
          lg.addColorStop(1, rgba(col, 0));
          g.fillStyle = lg; g.fillRect(x, y - 10, 3, 22);
        }
      }
      g.restore();
    }

    // 月亮 / 太阳
    if (P.moon) {
      const mx = P.moon.x * W + ox * 4, my = P.moon.y * H, mr = P.moon.r;
      const glow = g.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 5);
      glow.addColorStop(0, rgba(P.moon.glow, 0.5)); glow.addColorStop(1, rgba(P.moon.glow, 0));
      g.fillStyle = glow; g.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10);
      g.fillStyle = P.moon.color;
      g.beginPath(); g.arc(mx, my, mr, 0, Math.PI * 2); g.fill();
      if (P.particle === 'snow') {                        // 月面陨坑，仅满月
        g.fillStyle = rgba('#b8cfe4', 0.7);
        g.fillRect(mx - 2, my - 1, 2, 2); g.fillRect(mx + 1, my + 2, 3, 2); g.fillRect(mx - 4, my + 3, 2, 1);
      }
    }

    // 山脊（远→近，视差随深度增大）
    sc.ridges.forEach(function (r, ri) {
      const off = ox * 10 * r.depth;
      g.fillStyle = r.color;
      g.beginPath();
      g.moveTo(r.pts[0][0] + off, wl + 1);
      r.pts.forEach(function (p) { g.lineTo(p[0] + off, p[1]); });
      g.lineTo(r.pts[r.pts.length - 1][0] + off, wl + 1);
      g.closePath(); g.fill();
      if (r.snow) {                                      // 雪顶：沿山脊线描浅色（远山厚、近山薄）
        g.strokeStyle = r.snow; g.lineWidth = ri === 0 ? 2 : 1; g.beginPath();
        r.pts.forEach(function (p, i) { if (i === 0) g.moveTo(p[0] + off, p[1]); else g.lineTo(p[0] + off, p[1]); });
        g.stroke(); g.lineWidth = 1;
      }
    });

    // 岸线 + 树线（最前景，视差最大）
    const soff = ox * 10 * P.shore.depth;
    g.fillStyle = P.shore.color;
    g.fillRect(-4 + soff, wl - 3, W + 8, 5);
    sc.trees.forEach(function (tr) {
      const x = Math.round(tr.x + soff), base = wl - 2, h = Math.round(tr.h), w = Math.round(tr.w);
      g.fillStyle = tr.c;
      if (P.trees.kind === 'broad') {                    // 阔叶：三层圆墩
        g.fillRect(x - w / 2, base - h * 0.4, w, h * 0.4);
        g.fillRect(x - w / 2 - 1, base - h * 0.7, w + 2, Math.ceil(h * 0.35));
        g.fillRect(x - w / 2 + 1, base - h, w - 2, Math.ceil(h * 0.35));
      } else if (P.trees.kind === 'palm') {              // 棕榈：斜干 + 放射叶
        g.fillRect(x, base - h, 2, h);
        for (let k = -2; k <= 2; k++) g.fillRect(x + k * 3, base - h - Math.abs(k) + 1, 4, 2);
      } else {                                           // 针叶（可带雪顶）
        for (let lv = 0; lv < 3; lv++) {
          const lw = w - lv * (w / 3), ly = base - (h / 3) * (lv + 1);
          g.fillRect(Math.round(x - lw / 2), Math.round(ly), Math.round(lw), Math.ceil(h / 3));
        }
        if (P.trees.kind === 'conifer-snow') { g.fillStyle = '#b8cfe0'; g.fillRect(Math.round(x), Math.round(base - h), 1, 1); }
      }
    });
    }                                                          // end if (!imgOk)

    // ---- 主画布：世界 + 水面倒影 + 粒子 ----
    const c = inst.ctx;
    c.imageSmoothingEnabled = false;
    c.drawImage(inst.world, 0, 0);

    // 倒影：逐行翻转采样 + 正弦横向扰动，越深越模糊越暗。
    // 压缩比 = 水上高度 / 水下高度：整段天空山色铺满整根水柱（此前底部约 1/5 采样出界只剩罩层，
    // 鱼游进去像游到了背景外）；倒影在深处自然被罩层压暗，近水线处最清晰
    const amp = P.water.amp, spd = P.water.speed;
    const squish = (wl / (H - wl)) * 0.98;
    for (let y = wl; y < H; y++) {
      const d = (y - wl) / (H - wl);                     // 0 水面线 → 1 底部
      const src = wl - (y - wl) * squish;
      if (src < 0) break;
      const shift = Math.sin(y * 0.55 + t * 2.2 * spd) * amp * (0.5 + d * 2)
        + Math.sin(y * 0.17 - t * 1.3 * spd) * amp * 0.6;
      c.drawImage(inst.world, 0, src, W, 1, shift, y, W, 1);
    }
    // 水色罩层：让倒影沉入各渔场自己的水色（手绘底图时罩层减淡，保留图里的倒影色彩）
    c.fillStyle = inst.waterGradients[imgOk ? 1 : 0]; c.fillRect(0, wl, W, H - wl);
    // 水面高光碎波：几条流动的亮线
    for (let i = 0; i < 5; i++) {
      const yy = wl + 2 + ((i * 7 + t * 3 * spd) % (H - wl - 3));
      const len = W * (0.12 + 0.1 * Math.sin(t + i * 2));
      const xx = (Math.sin(t * 0.4 + i * 1.7) * 0.5 + 0.5) * (W - len);
      c.fillStyle = rgba(P.water.streak, (0.16 - i * 0.02).toFixed(2));
      c.fillRect(xx, yy, len, 1);
    }

    // 粒子（倒影之上，不入水）
    if (motion === 'full') sc.particles.forEach(function (p) {
      stepParticle(p, P.particle, W, H, wl, dt, t);
      let col = '#ffffff', a = 1;
      if (P.particle === 'snow') { col = '#e8f2fc'; a = 0.5 + 0.5 * p.sp / 1.2; }
      else if (P.particle === 'sparkle') { col = '#efe4ff'; a = Math.max(0, Math.sin(t * 1.4 * p.sp + p.ph)); }
      else if (P.particle === 'mote') { col = '#ffd88f'; a = 0.3 + 0.7 * Math.max(0, Math.sin(t * p.sp + p.ph)); }
      else if (P.particle === 'spray') { col = '#dff4f2'; a = clamp(1 - (p.y - wl + 20) / -24, 0.15, 0.8); }
      c.fillStyle = rgba(col, clamp(a, 0, 1).toFixed(2));
      c.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
      if (P.particle === 'sparkle' && p.s === 2 && a > 0.7) {   // 亮星芒
        c.fillRect(Math.round(p.x) - 1, Math.round(p.y), 1, 1);
        c.fillRect(Math.round(p.x) + 2, Math.round(p.y), 1, 1);
      }
    });

    // 水面线压一道亮色，天地分界更利落（手绘底图时减弱，免得变成一条白杠）
    c.fillStyle = rgba(P.water.streak, imgOk ? 0.10 : 0.28);
    c.fillRect(0, wl, W, 1);
  }

  return { mount: mount, update: update };
})();
