/* DeepFish 渔屋内景渲染器 · 独立场景（与港湾同级）
   480×240 像素画，参考 harbor-art.js 的绘制质量：精致木纹、砖块、光影、动画。*/
(function () {
  'use strict';
  const W = 480, H = 240, GROUND = 180;

  // ---------- 辅助函数 ----------
  const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgbHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  function mix(a, b, t) { const A = hexRgb(a), B = hexRgb(b); return rgbHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function grain(x, y, salt) {
    let n = Math.imul(x + salt * 17, 374761393) + Math.imul(y - salt * 29, 668265263);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  }
  function G(ctx, P) {
    const col = k => (typeof P[k] === 'string' ? P[k] : k);
    const g = {
      P, ctx, col,
      r(x, y, w, h, k) { ctx.fillStyle = col(k); ctx.fillRect(x, y, w, h); },
      a(alpha, fn) { const o = ctx.globalAlpha; ctx.globalAlpha = o * alpha; fn(); ctx.globalAlpha = o; },
      line(x0, y0, x1, y1, k) {
        ctx.fillStyle = col(k);
        const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let e = dx + dy;
        for (;;) {
          ctx.fillRect(x0, y0, 1, 1);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * e;
          if (e2 >= dy) { e += dy; x0 += sx; }
          if (e2 <= dx) { e += dx; y0 += sy; }
        }
      },
      spr(x, y, rows, map) {
        rows.forEach((row, j) => {
          for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            if (ch !== '.') { ctx.fillStyle = col(map[ch]); ctx.fillRect(x + i, y + j, 1, 1); }
          }
        });
      },
      glow(x, y, rad, k, alpha) {
        const gr = ctx.createRadialGradient(x + .5, y + .5, 0, x + .5, y + .5, rad);
        const c = col(k);
        gr.addColorStop(0, c); gr.addColorStop(1, c + '00');
        g.a(alpha, () => { ctx.fillStyle = gr; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2); });
      },
    };
    return g;
  }

  // ---------- 调色板（沿用港湾四时段，调整室内光照）----------
  const PAL = {
    dawn: {
      wall: '#5a3b28', wallHi: '#7c5438', wallDk: '#382418', wallKnot: '#2a1810',
      floor: '#46302a', floorHi: '#5e4234', floorDk: '#2e1e18',
      sky: '#d27f86', skyHi: '#f6b98a', star: '#ffe6a0',
      stone: '#4a4272', stoneHi: '#6d5b8e', stoneDk: '#35305a',
      fire: '#ff9a3c', fireHi: '#ffe08a', fireDk: '#a8401c',
      light: '#ffd08a', glass: '#e8d6e6', water: '#8f7fb4',
      metal: '#8a97a8', metalHi: '#b4c0d0', metalDk: '#5a6475',
      ink: '#16121f', fireAlpha: .5, lampAlpha: .3, windowAlpha: .6,
    },
    day: {
      wall: '#6e5640', wallHi: '#8e7456', wallDk: '#4a3628', wallKnot: '#3a2418',
      floor: '#58443a', floorHi: '#6e5848', floorDk: '#3e2e28',
      sky: '#8cc8f0', skyHi: '#c4e6f6', star: '#fff8d0',
      stone: '#5a88ae', stoneHi: '#7ea6c8', stoneDk: '#365b45',
      fire: '#ff9a3c', fireHi: '#ffe08a', fireDk: '#a8401c',
      light: '#fffae0', glass: '#f4f8fc', water: '#346f94',
      metal: '#9eaab8', metalHi: '#c8d4e0', metalDk: '#6a7480',
      ink: '#1c1c26', fireAlpha: 0, lampAlpha: 0, windowAlpha: 1,
    },
    dusk: {
      wall: '#5a3b28', wallHi: '#7c5438', wallDk: '#382418', wallKnot: '#2a1810',
      floor: '#46302a', floorHi: '#5e4234', floorDk: '#2e1e18',
      sky: '#c65a52', skyHi: '#f39a4e', star: '#ffb25e',
      stone: '#402c4e', stoneHi: '#5c3c62', stoneDk: '#2c203a',
      fire: '#ff8a3c', fireHi: '#ffd08a', fireDk: '#a83820',
      light: '#ffcc6a', glass: '#e8b8b0', water: '#d0784e',
      metal: '#8a8a9a', metalHi: '#aaaabc', metalDk: '#5a5a6a',
      ink: '#130d18', fireAlpha: .8, lampAlpha: .2, windowAlpha: .3,
    },
    night: {
      wall: '#3a2418', wallHi: '#5a3b28', wallDk: '#241810', wallKnot: '#1a1008',
      floor: '#2e1e18', floorHi: '#3e2a20', floorDk: '#1e1410',
      sky: '#0d1d42', skyHi: '#1f3c6a', star: '#dfeaff',
      stone: '#0d1f38', stoneHi: '#12284a', stoneDk: '#09172a',
      fire: '#ff9a3c', fireHi: '#ffe08a', fireDk: '#a8401c',
      light: '#ffd466', glass: '#8aa4c8', water: '#173a64',
      metal: '#7a8090', metalHi: '#9aa8b8', metalDk: '#4a5060',
      ink: '#060a14', fireAlpha: 1, lampAlpha: 1, windowAlpha: .1,
    },
  };

  // ---------- 物件热区表（五个功能区） ----------
  const PLACES = {
    yard: { name: '晒场', icon: '☀️', hot: [18, 60, 84, 96] },
    breeding: { name: '繁育', icon: '🧬', hot: [110, 112, 64, 56] },
    pet: { name: '宠物', icon: '🐶', hot: [190, 56, 100, 128] },
    role: { name: '角色', icon: '🧍', hot: [310, 62, 54, 118] },
    rod: { name: '钓竿', icon: '🎣', hot: [380, 36, 84, 118] },
  };
  const DRAW_ORDER = ['yard', 'breeding', 'pet', 'role', 'rod'];

  // ---------- 精灵（宠物） ----------
  const S = { dog: ['.......yy.', '......yyyy', '......yky.', '......yyyn', '....yyyyy.', '..yyyyyyy.', '..yyyyyyy.', '..y.y..y.y'] };
  const DOG = { y: '#d9a441', k: 'ink', n: 'ink' };

  // ---------- 状态映射 ----------
  function houseState(st) {
    const h = st.house || {};
    return { houseFull: (+h.capacityHours || 0) > 0 && (+h.hours || 0) >= (+h.capacityHours || 0) };
  }

  // ---------- 主绘制：基础层（墙面+地板）+ 物件层 ----------
  function makeLayers(P, st) {
    const base = canvas(W, H), bc = base.getContext('2d'), g = G(bc, P);
    
    // 后墙：横木板（精致纹理，参考港湾渔屋）
    for (let x = 0; x < W; x += 3) {
      g.r(x, 0, 2, GROUND, P.wall);
      g.r(x + 2, 0, 1, GROUND, P.wallDk);
      // 木板纹理（随机节疤、木纹）
      for (let y = 0; y < GROUND; y++) {
        const n = grain(x, y, 31);
        if (n > .97) g.r(x, y, 1, 1, P.wallKnot);
        else if (n > .94) g.r(x, y, 1, 1, P.wallHi);
      }
    }
    // 墙面横梁（装饰）
    g.r(0, 30, W, 3, P.wallDk); g.r(0, 30, W, 1, P.wallKnot);
    g.r(0, GROUND - 4, W, 4, P.wallDk); g.r(0, GROUND - 4, W, 1, P.wallHi);
    
    // 地板：竖木板（精致纹理）
    for (let y = GROUND; y < H; y += 3) {
      g.r(0, y, W, 2, P.floor);
      g.r(0, y + 2, W, 1, P.wallDk);
      // 地板磨损与节疤
      for (let x = 0; x < W; x++) {
        const n = grain(x, y, 37);
        if (n > .96) g.r(x, y, 1, 1, P.floorDk);
        else if (n > .93) g.r(x, y, 1, 1, P.floorHi);
      }
    }
    
    return { base };
  }

  function drawFrame(ctx, L, P, st, t, hover) {
    ctx.drawImage(L.base, 0, 0);
    const g = G(ctx, P);
    const f = .6 + .4 * Math.sin(t * 1.8); // 炉火节拍

    // ---- 1. 窗外晒鱼架（左侧，yard） ----
    // 窗框：木质双层
    g.r(23, 65, 62, 52, P.wallDk); g.r(26, 68, 56, 46, P.sky);
    g.r(26, 68, 56, 1, P.skyHi); // 窗顶高光
    // 窗格（十字分割）
    g.r(53, 68, 2, 46, P.wallDk); g.r(26, 90, 56, 2, P.wallDk);
    // 窗外星星（夜晚/清晨）
    if (P.windowAlpha < .5) {
      for (let i = 0; i < 9; i++) {
        const x = 30 + (i * 23) % 48, y = 72 + (i * 13) % 30;
        if (i % 3 === Math.floor(t * 2) % 3) g.r(x, y, 1, 1, P.star);
      }
    }
    // 窗外晒鱼架（屋外，窗下）
    g.r(20, 118, 68, 4, P.wallHi);
    g.r(20, 118, 68, 1, P.wallDk);
    for (let i = 0; i < 7; i++) {
      g.r(26 + i * 9, 122, 1, 4, P.ink);
      // 晒鱼干（橙黄色）
      g.r(24 + i * 9, 126, 5, 10, '#c8a060');
      // 鱼干细节：眼睛、纹理
      g.r(25 + i * 9, 127, 1, 1, P.ink);
      g.r(26 + i * 9, 130, 3, 1, '#a88040');
    }
    // 满仓闪光
    if (st.houseFull && Math.floor(t * 2) % 2) {
      g.r(82, 120, 4, 4, '#ffd23e');
      g.r(83, 121, 2, 2, '#ffe08a');
    }

    // ---- 2. 孵化箱 / 鱼缸（左中，breeding） ----
    // 木桌（精致纹理）
    g.r(112, 150, 60, 4, P.wallHi);
    g.r(112, 150, 60, 1, P.wallDk);
    // 桌腿
    g.r(116, 154, 3, 26, P.wallDk); g.r(166, 154, 3, 26, P.wallDk);
    g.r(116, 154, 1, 26, P.wall); g.r(166, 154, 1, 26, P.wall);
    // 玻璃鱼缸（蓝色水体）
    g.r(122, 120, 40, 30, P.metalDk);
    g.r(124, 122, 36, 26, P.water);
    // 水面高光
    g.r(124, 122, 36, 2, mix(P.water, P.glass, .4));
    // 水泡动画（同步炉火节拍）
    for (let i = 0; i < 4; i++) {
      const yy = 146 - ((t * 3.6 + i * 7) % 24);
      g.r(130 + i * 8, yy, 2, 2, mix(P.water, P.glass, .8));
      g.r(130 + i * 8, yy, 1, 1, P.glass);
    }
    // 小鱼游动（橙色，同步炉火）
    const fishX = Math.round(134 + Math.sin(t * .9) * 8);
    const fishY = Math.round(134 + Math.sin(t * 1.8) * 2);
    g.r(fishX - 1, fishY, 1, 1, '#e0906a');
    g.r(fishX, fishY - 1, 3, 3, '#e0906a');
    g.r(fishX + 3, fishY, 1, 1, '#e0906a');
    g.r(fishX + 1, fishY, 1, 1, '#c8764a');
    g.r(fishX + 1, fishY + 1, 1, 1, P.ink);
    // 鱼鳍
    g.r(fishX - 2, fishY, 1, 1, '#c8764a');

    // ---- 3. 壁炉 + 狗窝（中央，pet） ----
    // 石砌壁炉（精致砖块纹理）
    for (let y = 70; y < 176; y += 6) {
      g.r(200, y, 80, 5, P.stone);
      g.r(200, y, 80, 1, P.stoneHi);
      g.r(200, y + 5, 80, 1, P.stoneDk);
      // 砖块缝隙
      for (let x = 200 + ((y / 6) % 2) * 8; x < 280; x += 16) {
        g.r(x, y + 1, 1, 4, P.stoneDk);
      }
    }
    // 炉口（黑色洞口）
    g.r(214, 110, 52, 50, P.ink);
    g.r(214, 110, 52, 1, P.stoneDk);
    // 炉火（按时段强度）
    if (P.fireAlpha > 0) {
      g.a(P.fireAlpha, () => {
        g.r(222, 140 - f * 10, 36, 20 + f * 10, P.fireDk);
        g.r(230, 146 - f * 8, 20, 14 + f * 8, P.fire);
        g.r(236, 150, 8, 10, P.fireHi);
        // 火星
        for (let i = 0; i < 3; i++) {
          const sx = 230 + Math.sin(t * 3 + i) * 8;
          const sy = 135 - ((t * 4 + i * 3) % 15);
          g.a(.6, () => g.r(sx, sy, 1, 1, P.fireHi));
        }
      });
    }
    // 炉顶横梁
    g.r(196, 64, 88, 6, P.wallHi);
    g.r(196, 64, 88, 1, P.wallDk);
    // 炉火光晕（径向渐变）
    if (P.fireAlpha > .05) {
      const gx = 240, gy = 150;
      const gr = ctx.createRadialGradient(gx, gy, 4, gx, gy, 90 + f * 8);
      gr.addColorStop(0, 'rgba(255,154,60,' + (.32 * f * P.fireAlpha).toFixed(3) + ')');
      gr.addColorStop(.5, 'rgba(255,138,60,' + (.12 * f * P.fireAlpha).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(255,138,60,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gr;
      ctx.fillRect(gx - 100, gy - 100, 200, 200);
      ctx.restore();
    }
    // 狗窝（精致木质）
    g.r(206, 168, 68, 10, '#8a3a3a');
    g.r(208, 166, 64, 2, '#b85a5a');
    g.r(206, 168, 68, 1, '#6a2a2a');
    // 驻守宠物（狗，尾巴摆动）
    g.spr(226, 160, S.dog, DOG);
    const tailFrame = Math.floor(t * 1.8 * 2) % 2;
    g.r(224, 162 - tailFrame, 3, 1, DOG.y);

    // ---- 4. 落地穿衣镜（右中，role） ----
    const mx = 336, my = 118, mrx = 22, mry = 50;
    // 椭圆木框（精致绘制）
    for (let y = -mry - 3; y <= mry + 3; y++) {
      const hw = Math.round((mrx + 3) * Math.sqrt(Math.max(0, 1 - (y / (mry + 3)) ** 2)));
      g.r(mx - hw, my + y, hw * 2, 1, P.wallHi);
    }
    for (let y = -mry - 1; y <= mry + 1; y++) {
      const hw = Math.round((mrx + 1) * Math.sqrt(Math.max(0, 1 - (y / (mry + 1)) ** 2)));
      g.r(mx - hw, my + y, hw * 2, 1, P.wallDk);
    }
    // 镜面底色（深蓝灰）
    for (let y = -mry; y <= mry; y++) {
      const hw = Math.round(mrx * Math.sqrt(Math.max(0, 1 - (y / mry) ** 2)));
      g.r(mx - hw, my + y, hw * 2, 1, y < 0 ? '#2e4260' : '#26384f');
    }
    // 顶部金饰
    g.r(mx - 3, my - mry - 6, 6, 3, '#e8b83a');
    g.r(mx - 2, my - mry - 7, 4, 1, '#ffd23e');
    // 支脚
    g.r(mx - 14, my + mry + 2, 2, 8, P.wallDk);
    g.r(mx + 12, my + mry + 2, 2, 8, P.wallDk);
    g.r(mx - 16, my + mry + 8, 32, 2, P.wallHi);
    // 镜面斜线反光（柔和）
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

    // ---- 5. 钓竿架（右侧，rod） ----
    // 上下横档（精致木质）
    g.r(382, 56, 80, 5, P.wallHi);
    g.r(382, 56, 80, 1, '#a06c4a');
    g.r(382, 61, 80, 1, P.wallDk);
    g.r(382, 146, 80, 5, P.wallHi);
    g.r(382, 146, 80, 1, '#a06c4a');
    g.r(382, 151, 80, 1, P.wallDk);
    // 侧立柱
    [384, 458].forEach(x => {
      g.r(x, 54, 2, 100, P.wallDk);
      g.r(x, 52, 2, 2, P.ink);
      g.r(x, 54, 1, 100, P.wall);
    });
    // 四根钓竿（精致细节）
    const RODS = [['#ffd23e', '#8a5a34'], ['#38bdf8', '#2c4f74'], ['#c084fc', '#5a3a78'], ['#cbd5e1', '#46425a']];
    RODS.forEach(([k, grip], i) => {
      const x = 394 + i * 18;
      // 卡槽
      g.r(x - 2, 60, 6, 2, P.wallDk);
      g.r(x - 2, 144, 6, 2, P.wallDk);
      // 竿梢（伸出横档）
      g.r(x + 1, 40, 1, 22, k);
      g.r(x, 40, 1, 1, mix(k, '#ffffff', .3));
      // 竿身 + 高光
      g.r(x, 62, 2, 54, k);
      g.r(x + 1, 62, 1, 54, 'rgba(255,255,255,.25)');
      // 导环（银色金属）
      [72, 88, 104].forEach(y => {
        g.r(x - 1, y, 4, 1, P.metalHi);
        g.r(x - 1, y + 1, 1, 1, P.metalHi);
        g.r(x + 2, y, 1, 1, P.metalDk);
      });
      // 金属箍
      g.r(x - 1, 116, 4, 2, '#e8b83a');
      g.r(x - 1, 116, 4, 1, '#ffd23e');
      // 缠绳握把
      g.r(x - 1, 118, 4, 26, grip);
      for (let y = 120; y < 142; y += 3) g.r(x - 1, y, 4, 1, P.ink);
      // 尾塞
      g.r(x - 1, 142, 4, 2, P.wallDk);
      // 绕线轮（金属质感）
      g.r(x + 2, 122, 5, 5, P.metal);
      g.r(x + 3, 123, 3, 3, P.metalDk);
      g.r(x + 6, 124, 2, 1, P.ink);
      g.r(x + 3, 123, 1, 1, P.metalHi);
      // 垂线轻摆
      const sw = Math.round(Math.sin(t * .8 + i) * 1.5);
      for (let y = 41; y < 58; y++) {
        g.r(x + 2 + Math.round(sw * (y - 41) / 17), y, 1, 1, 'rgba(223,234,255,.5)');
      }
      // 浮漂
      g.r(x + 1 + sw, 57, 3, 2, '#d04040');
      g.r(x + 1 + sw, 59, 3, 1, '#f4f4f4');
    });

    // ---- 6. 油灯（顶部中央，环境光） ----
    if (P.lampAlpha > .05) {
      g.a(.3 * P.lampAlpha, () => {
        g.r(400, 20, 30, 20, P.light);
      });
      g.r(412, 30, 6, 8, P.light);
      g.r(412, 30, 6, 1, mix(P.light, '#ffffff', .5));
      g.glow(415, 34, 10, P.light, .35 * P.lampAlpha);
    }

    // 悬停描边
    if (hover && PLACES[hover]) {
      const [x, y, w, h] = PLACES[hover].hot;
      ctx.strokeStyle = '#ffd23e';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
    }
  }

  window.HouseArt = { W, H, PAL, PLACES, DRAW_ORDER, houseState, makeLayers, drawFrame };
})();
