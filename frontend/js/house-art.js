/* DeepFish 渔屋场景渲染器（设计稿 v1 · 场景化内景）。
   480×240 像素画，与 harbor-art.js 同结构：状态由 harbor.js 传入，这里只负责画。*/
(function () {
  'use strict';
  const W = 480, H = 240;

  // ---------- 辅助函数 ----------
  const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgbHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  function mix(a, b, t) { const A = hexRgb(a), B = hexRgb(b); return rgbHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function G(ctx, P) {
    const col = k => (typeof P[k] === 'string' ? P[k] : k);
    const g = {
      P, ctx, col,
      r(x, y, w, h, k) { ctx.fillStyle = col(k); ctx.fillRect(x, y, w, h); },
      a(alpha, fn) { const o = ctx.globalAlpha; ctx.globalAlpha = o * alpha; fn(); ctx.globalAlpha = o; },
    };
    return g;
  }

  // ---------- 调色板（沿用 harbor-art 的四时段，调整室内光照） ----------
  const PAL = {
    dawn: { wall: '#5a3b28', wallHi: '#7c5438', wallDk: '#382418', floor: '#46302a', floorHi: '#5e4234',
      sky: '#d27f86', star: '#ffe6a0', light: '#ffd08a', stone: '#4a4272', stoneHi: '#6d5b8e', ink: '#16121f',
      fire: .5, ambient: .3 },
    day: { wall: '#6e5640', wallHi: '#8e7456', wallDk: '#4a3628', floor: '#58443a', floorHi: '#6e5848',
      sky: '#8cc8f0', star: '#fff8d0', light: '#a8d4f0', stone: '#5a88ae', stoneHi: '#7ea6c8', ink: '#1c1c26',
      fire: 0, ambient: 1 },
    dusk: { wall: '#5a3b28', wallHi: '#7c5438', wallDk: '#382418', floor: '#46302a', floorHi: '#5e4234',
      sky: '#c65a52', star: '#ffb25e', light: '#ffcc6a', stone: '#402c4e', stoneHi: '#5c3c62', ink: '#130d18',
      fire: .8, ambient: .2 },
    night: { wall: '#3a2418', wallHi: '#5a3b28', wallDk: '#241810', floor: '#2e1e18', floorHi: '#3e2a20',
      sky: '#0d1d42', star: '#dfeaff', light: '#ffd466', stone: '#0d1f38', stoneHi: '#12284a', ink: '#060a14',
      fire: 1, ambient: 0 },
  };

  // ---------- 物件热区表（与 harbor-art.PLACES 同结构） ----------
  const PLACES = {
    yard: { name: '晒场', icon: '☀️', hot: [18, 60, 84, 96], draw: drawYard },
    breeding: { name: '繁育', icon: '🧬', hot: [110, 112, 64, 56], draw: drawBreeding },
    pet: { name: '宠物', icon: '🐶', hot: [190, 56, 100, 128], draw: drawFireplace },
    role: { name: '角色', icon: '🧍', hot: [310, 62, 54, 118], draw: drawMirror },
    rod: { name: '钓竿', icon: '🎣', hot: [380, 36, 84, 118], draw: drawRodRack },
  };
  const DRAW_ORDER = ['yard', 'breeding', 'pet', 'role', 'rod'];

  // ---------- 物件绘制函数 ----------
  function drawYard(g, st, t) {
    const P = g.P;
    // 窗（晒场）
    g.r(24, 66, 60, 50, P.wallDk); g.r(28, 70, 52, 42, P.sky);
    // 窗外星星（夜晚 / 清晨）
    for (let i = 0; i < 9; i++) {
      const x = 30 + (i * 23) % 48, y = 72 + (i * 13) % 30;
      if (i % 3 === Math.floor(t * 2) % 3) g.r(x, y, 1, 1, P.star);
      else g.r(x, y, 1, 1, mix(P.star, P.sky, .5));
    }
    g.r(53, 70, 2, 42, P.wallDk); g.r(28, 90, 52, 2, P.wallDk);
    // 晒鱼架
    g.r(22, 118, 66, 4, P.wallHi);
    for (let i = 0; i < 6; i++) { g.r(28 + i * 9, 122, 1, 4, P.ink); g.r(26 + i * 9, 126, 5, 10, '#c8a060'); }
    // 满仓闪光
    if (st.houseFull && Math.floor(t * 2) % 2) g.r(80, 120, 3, 3, '#ffd23e');
  }
  function drawBreeding(g, st, t) {
    const P = g.P;
    // 桌 + 孵化箱
    g.r(112, 150, 60, 4, P.wallHi); g.r(116, 154, 3, 26, P.wallDk); g.r(166, 154, 3, 26, P.wallDk);
    g.r(122, 120, 40, 30, '#2c4f74'); g.r(124, 122, 36, 26, '#173a64');
    // 水泡动画（与炉火同步 t * 1.8）
    for (let i = 0; i < 4; i++) {
      const yy = 146 - ((t * 3.6 + i * 7) % 24);
      g.r(130 + i * 8, yy, 2, 2, '#9cc0e8');
    }
    // 鱼在水里游动（与炉火同步）
    const fishX = Math.round(134 + Math.sin(t * .9) * 8), fishY = Math.round(134 + Math.sin(t * 1.8) * 2);
    g.r(fishX - 1, fishY, 1, 1, '#e0906a'); g.r(fishX, fishY - 1, 3, 3, '#e0906a'); g.r(fishX + 3, fishY, 1, 1, '#e0906a');
    g.r(fishX + 1, fishY, 1, 1, '#c8764a'); g.r(fishX + 1, fishY + 1, 1, 1, '#000');
  }
  function drawFireplace(g, st, t) {
    const P = g.P, f = .6 + .4 * Math.sin(t * 1.8);
    // 壁炉
    g.r(200, 70, 80, 106, P.stone);
    for (let y = 72; y < 176; y += 6) g.r(200, y, 80, 1, P.stoneHi);
    g.r(214, 110, 52, 50, P.ink);
    // 炉火（按调色板的 fire 强度）
    const fireAlpha = P.fire;
    if (fireAlpha > 0) {
      g.a(fireAlpha, () => {
        g.r(222, 140 - f * 10, 36, 20 + f * 10, '#a8401c');
        g.r(230, 146 - f * 8, 20, 14 + f * 8, '#ff9a3c');
        g.r(236, 150, 8, 10, '#ffe08a');
      });
    }
    g.r(196, 64, 88, 6, P.wallHi);
    // 炉火光晕
    if (fireAlpha > .05) {
      const gx = 240, gy = 150, gr = g.ctx.createRadialGradient(gx, gy, 4, gx, gy, 90 + f * 8);
      gr.addColorStop(0, 'rgba(255,154,60,' + (.32 * f * fireAlpha).toFixed(3) + ')');
      gr.addColorStop(.5, 'rgba(255,138,60,' + (.12 * f * fireAlpha).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(255,138,60,0)');
      g.ctx.save(); g.ctx.globalCompositeOperation = 'lighter'; g.ctx.fillStyle = gr; g.ctx.fillRect(gx - 100, gy - 100, 200, 200); g.ctx.restore();
    }
    // 狗窝
    g.r(206, 168, 68, 10, '#8a3a3a'); g.r(208, 166, 64, 2, '#b85a5a');
    // 驻守宠物（简化：默认狗，尾巴摆动）
    g.r(226, 160, 18, 7, '#d9a441'); g.r(242, 156, 6, 6, '#d9a441'); g.r(246, 158, 1, 1, P.ink);
    g.r(224, 162 - Math.floor(t * 1.8 * 2) % 2, 3, 1, '#d9a441');
  }
  function drawMirror(g, st, t) {
    const P = g.P;
    const mx = 336, my = 118, mrx = 22, mry = 50;
    // 椭圆木框
    for (let y = -mry - 3; y <= mry + 3; y++) {
      const hw = Math.round((mrx + 3) * Math.sqrt(Math.max(0, 1 - (y / (mry + 3)) ** 2)));
      g.r(mx - hw, my + y, hw * 2, 1, P.wallHi);
    }
    for (let y = -mry - 1; y <= mry + 1; y++) {
      const hw = Math.round((mrx + 1) * Math.sqrt(Math.max(0, 1 - (y / (mry + 1)) ** 2)));
      g.r(mx - hw, my + y, hw * 2, 1, P.wallDk);
    }
    // 镜面底色
    for (let y = -mry; y <= mry; y++) {
      const hw = Math.round(mrx * Math.sqrt(Math.max(0, 1 - (y / mry) ** 2)));
      g.r(mx - hw, my + y, hw * 2, 1, y < 0 ? '#2e4260' : '#26384f');
    }
    g.r(mx - 3, my - mry - 6, 6, 3, '#e8b83a'); // 顶部金饰
    g.r(mx - 14, my + mry + 2, 2, 8, P.wallDk); g.r(mx + 12, my + mry + 2, 2, 8, P.wallDk);
    g.r(mx - 16, my + mry + 8, 32, 2, P.wallHi);
    // 镜面斜线反光（柔和版）
    const inMirror = (x, y) => ((x - mx) / (mrx - 2)) ** 2 + ((y - my) / (mry - 2)) ** 2 <= 1;
    [[-30, .14, 14], [-26, .09, 8], [-12, .1, 10]].forEach(([off, a, len]) => {
      g.a(a, () => {
        for (let k = -len; k <= len; k++) {
          const x = mx + off + k, y = my - k;
          if (inMirror(x, y)) g.r(x, y, 1, 1, '#dfeaff');
        }
      });
    });
    // 高光带扫过
    const sh = Math.round(((t * 6) % 120) - 30);
    g.a(.22, () => {
      for (let k = 0; k < 5; k++) {
        const y = my - mry + sh + k * 3;
        const hw = Math.round(mrx * Math.sqrt(Math.max(0, 1 - ((y - my) / mry) ** 2)));
        if (hw > 0) g.r(mx - hw + 3 + k, y, Math.max(1, hw - 6), 2, '#dfeaff');
      }
    });
    g.r(mx - 14, my - 32, 2, 10, 'rgba(223,234,255,.4)');
    g.r(mx - 12, my - 36, 1, 4, 'rgba(223,234,255,.35)');
  }
  function drawRodRack(g, st, t) {
    const P = g.P;
    // 钓竿架：上下木横档
    g.r(382, 56, 80, 5, P.wallHi); g.r(382, 56, 80, 1, '#a06c4a'); g.r(382, 61, 80, 1, P.wallDk);
    g.r(382, 146, 80, 5, P.wallHi); g.r(382, 146, 80, 1, '#a06c4a'); g.r(382, 151, 80, 1, P.wallDk);
    [384, 458].forEach(x => { g.r(x, 54, 2, 100, P.wallDk); g.r(x, 52, 2, 2, P.ink); });
    // 四根钓竿
    const RODS = [['#ffd23e', '#8a5a34'], ['#38bdf8', '#2c4f74'], ['#c084fc', '#5a3a78'], ['#cbd5e1', '#46425a']];
    RODS.forEach(([k, grip], i) => {
      const x = 394 + i * 18;
      g.r(x - 2, 60, 6, 2, P.wallDk); g.r(x - 2, 144, 6, 2, P.wallDk);
      g.r(x + 1, 40, 1, 22, k);
      g.r(x, 62, 2, 54, k); g.r(x + 1, 62, 1, 54, 'rgba(255,255,255,.25)');
      [72, 88, 104].forEach(y => { g.r(x - 1, y, 4, 1, '#cfd6e0'); g.r(x - 1, y + 1, 1, 1, '#cfd6e0'); });
      g.r(x - 1, 116, 4, 2, '#e8b83a');
      g.r(x - 1, 118, 4, 26, grip);
      for (let y = 120; y < 142; y += 3) g.r(x - 1, y, 4, 1, P.ink);
      g.r(x - 1, 142, 4, 2, P.wallDk);
      g.r(x + 2, 122, 5, 5, '#8a97a8'); g.r(x + 3, 123, 3, 3, '#46425a'); g.r(x + 6, 124, 2, 1, P.ink);
      const sw = Math.round(Math.sin(t * .8 + i) * 1.5);
      for (let y = 41; y < 58; y++) g.r(x + 2 + Math.round(sw * (y - 41) / 17), y, 1, 1, 'rgba(223,234,255,.5)');
      g.r(x + 1 + sw, 57, 3, 2, '#d04040'); g.r(x + 1 + sw, 59, 3, 1, '#f4f4f4');
    });
  }

  // ---------- 状态映射（从 Engine.state 提取渔屋需要的数据） ----------
  function houseState(st) {
    const h = st.house || {};
    return {
      houseFull: (+h.capacityHours || 0) > 0 && (+h.hours || 0) >= (+h.capacityHours || 0),
      // breeding / pet 状态预留，后续从服务端读取
    };
  }

  // ---------- 主渲染：基础层 + 物件层 ----------
  function makeLayers(P, st) {
    const base = canvas(W, H), bc = base.getContext('2d'), g = G(bc, P);
    // 墙面木板
    for (let x = 0; x < W; x += 6) { g.r(x, 0, 5, 180, P.wall); g.r(x + 5, 0, 1, 180, P.wallDk); }
    g.r(0, 30, W, 3, P.wallDk); g.r(0, 176, W, 4, P.wallDk);
    // 地板
    for (let y = 180; y < H; y += 6) { g.r(0, y, W, 5, P.floor); g.r(0, y + 5, W, 1, P.wallDk); }
    // 油灯光晕（环境光按调色板）
    if (P.ambient < .9) {
      g.a(.3 * (1 - P.ambient), () => { g.r(400, 20, 30, 20, P.light); });
      g.r(412, 30, 6, 8, P.light);
    }
    return { base };
  }
  function drawFrame(ctx, L, P, st, t, hover) {
    ctx.drawImage(L.base, 0, 0);
    const g = G(ctx, P);
    DRAW_ORDER.forEach(id => { PLACES[id].draw(g, st, t); });
    // 悬停描边
    if (hover && PLACES[hover]) {
      const [x, y, w, h] = PLACES[hover].hot;
      ctx.strokeStyle = '#ffd23e'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
    }
  }

  window.HouseArt = { W, H, PAL, PLACES, DRAW_ORDER, houseState, makeLayers, drawFrame };
})();
