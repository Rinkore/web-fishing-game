/* DeepFish 港湾场景渲染器（设计稿 v2 · 阶段 B；海岸材质参考 assets/worldmap.png 的旧草稿）。
   只负责画：状态由 js/harbor.js 从游戏状态整理好传进来（sceneState），这里不读 Engine / UI。
   Everything is drawn on a 480×240 canvas and scaled by whole numbers.
   Static layers (sky, land, buildings) are cached per palette + state; the
   frame loop only adds the moving parts (waves, smoke, lights, birds…). */
(function () {
  'use strict';
  const W = 480, H = 240, HORIZON = 118, GROUND = 150, QUAY_B = 166;

  // ---------- colour ----------
  const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgbHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  function mix(a, b, t) { const A = hexRgb(a), B = hexRgb(b); return rgbHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
  function lerpPal(a, b, t) {
    const o = {};
    for (const k in a) {
      const va = a[k], vb = b[k];
      o[k] = Array.isArray(va) ? va.map((c, i) => mix(c, vb[i], t)) : typeof va === 'number' ? va + (vb - va) * t : mix(va, vb, t);
    }
    return o;
  }

  // ---------- palettes (one per period) ----------
  const PAL = {
    dawn: { sky: ['#2c3470', '#6c4f8c', '#d27f86', '#f6b98a'], sun: '#ffe6a0', glow: '#ffb878', star: .35, cloud: ['#f6b0a0', '#b97a96'], cloudA: .9,
      far: '#6d5b8e', near: '#4a4272', tree: '#35305a', snow: '#e8d6e6', sea: ['#8f7fb4', '#6d6aa2', '#4f5a90', '#3a467a'], seaHi: '#ffd6b0',
      quay: '#6a6478', quayHi: '#8a849a', quayDk: '#46425a', wood: '#7a4e38', woodHi: '#a06c4a', woodDk: '#4a3024',
      roof: '#884a48', roofHi: '#aa625a', slate: '#4e5072', slateHi: '#6a6e92', stone: '#6e6a82', stoneHi: '#8c88a0', stoneDk: '#4a4862',
      plaster: '#cdb2a0', plasterHi: '#e0c6b2', win: '#3a3a60', light: '#ffd08a', smoke: '#c9b8cc', ink: '#16121f', foam: '#f2dcd0',
      lamps: .55, beam: .45, tintC: '#5a3a78', tintA: .12 },
    day: { sky: ['#3a86d4', '#5aa6e6', '#8cc8f0', '#c4e6f6'], sun: '#fff8d0', glow: '#fff2b0', star: 0, cloud: ['#ffffff', '#d3e4f2'], cloudA: 1,
      far: '#7ea6c8', near: '#5a88ae', tree: '#365b45', snow: '#f4f8fc', sea: ['#346f94', '#2a6388', '#20567b', '#17466e'], seaHi: '#b6ddea',
      quay: '#8e939e', quayHi: '#b2b7c0', quayDk: '#60656f', wood: '#8e5e3c', woodHi: '#b8845a', woodDk: '#5c3c28',
      roof: '#965443', roofHi: '#b77459', slate: '#5c6c8a', slateHi: '#7a8cac', stone: '#8e949e', stoneHi: '#b0b5be', stoneDk: '#666b76',
      plaster: '#eadcc0', plasterHi: '#f8eed8', win: '#3c6690', light: '#a8d4f0', smoke: '#dfe6ee', ink: '#1c1c26', foam: '#ffffff',
      lamps: 0, beam: 0, tintC: '#ffffff', tintA: 0 },
    dusk: { sky: ['#24285c', '#5e3a72', '#c65a52', '#f39a4e'], sun: '#ffb25e', glow: '#ff8c4a', star: .2, cloud: ['#f07a5a', '#8e4a70'], cloudA: .9,
      far: '#5c3c62', near: '#402c4e', tree: '#2c203a', snow: '#e8b8b0', sea: ['#d0784e', '#94505e', '#5e3c62', '#3c2c50'], seaHi: '#ffc684',
      quay: '#5c4c5e', quayHi: '#7a6678', quayDk: '#3c3040', wood: '#6c4430', woodHi: '#925c40', woodDk: '#402a20',
      roof: '#88443b', roofHi: '#ad6049', slate: '#463f60', slateHi: '#60577c', stone: '#60546a', stoneHi: '#7c6e86', stoneDk: '#40364a',
      plaster: '#b08e7c', plasterHi: '#c8a48e', win: '#2c2644', light: '#ffcc6a', smoke: '#a88e9e', ink: '#130d18', foam: '#ffd8b8',
      lamps: 1, beam: .9, tintC: '#3a1a44', tintA: .12 },
    night: { sky: ['#070f24', '#0d1d42', '#152c58', '#1f3c6a'], sun: '#efe9cc', glow: '#8fb4e8', star: 1, cloud: ['#1e3056', '#162644'], cloudA: .7,
      far: '#12284a', near: '#0d1f38', tree: '#09172a', snow: '#8aa4c8', sea: ['#173a64', '#112e54', '#0c2444', '#081a34'], seaHi: '#4f86bc',
      quay: '#2e3648', quayHi: '#434e66', quayDk: '#1c2232', wood: '#5a3b28', woodHi: '#7c5438', woodDk: '#382418',
      roof: '#623735', roofHi: '#804c43', slate: '#384460', slateHi: '#4c5a7a', stone: '#465064', stoneHi: '#5a6680', stoneDk: '#2a3242',
      plaster: '#6a6252', plasterHi: '#7c7260', win: '#18223a', light: '#ffd466', smoke: '#7e8ca4', ink: '#060a14', foam: '#9cc0e8',
      lamps: 1, beam: 1, tintC: '#0a1638', tintA: .25 },
  };
  const PERIOD_NAME = { dawn: '清晨', day: '白天', dusk: '黄昏', night: '夜晚' };
  const PERIOD_ICON = { dawn: '🌅', day: '☀️', dusk: '🌇', night: '🌙' };

  // ---------- time ----------
  const toMin = s => { const [h, m] = String(s).split(':').map(Number); return (h * 60 + m) % 1440; };
  const fmt = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const ORDER = ['dawn', 'day', 'dusk', 'night'];
  function bounds(s) { return ORDER.map(n => [n, toMin(s.periods[n])]); }
  function validPeriods(s) {
    const b = bounds(s).map(x => x[1]);
    for (let i = 0; i < 3; i++) if (b[i + 1] - b[i] < s.blend) return '「' + PERIOD_NAME[ORDER[i]] + '」到「' + PERIOD_NAME[ORDER[i + 1]] + '」至少要隔 ' + s.blend + ' 分钟，且按清晨 → 白天 → 黄昏 → 夜晚排列';
    if (b[0] + 1440 - b[3] < s.blend) return '夜晚到次日清晨至少要隔 ' + s.blend + ' 分钟';
    return '';
  }
  function periodAt(m, s) { let cur = 'night'; for (const [n, v] of bounds(s)) if (m >= v) cur = n; return cur; }
  function paletteAt(m, s) {
    const b = bounds(s), half = s.blend / 2;
    for (let i = 0; i < 4; i++) {
      let d = m - b[i][1]; if (d > 720) d -= 1440; if (d < -720) d += 1440;
      if (half > 0 && Math.abs(d) < half) {
        const from = b[(i + 3) % 4][0], to = b[i][0], t = (d + half) / s.blend;
        return { P: lerpPal(PAL[from], PAL[to], t), period: t < .5 ? from : to, key: 'b' + Math.round(m / 2), blend: [from, to, t] };
      }
    }
    const p = periodAt(m, s);
    return { P: PAL[p], period: p, key: p };
  }
  // Fixed periods still need a sun/moon position: use a representative minute.
  function sampleMinute(p, s) { const b = toMin(s.periods[p]); return p === 'day' ? 12 * 60 + 30 : p === 'night' ? (b + 180) % 1440 : b + 45; }
  function celestial(m, s) {
    const a = toMin(s.periods.dawn), b = toMin(s.periods.night);
    let sun = true, p;
    if (m >= a && m < b) p = (m - a) / (b - a);
    else { sun = false; p = ((m - b + 1440) % 1440) / ((a - b + 1440) % 1440); }
    return { sun, x: Math.round(24 + p * 432), y: Math.round(HORIZON - 4 - Math.sin(p * Math.PI) * 92) };
  }

  // ---------- helpers ----------
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16);
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // The old coast draft gets its depth from many tiny, irregular material
  // changes. Keep those changes deterministic so cached layers never shimmer.
  function grain(x, y, salt) {
    let n = Math.imul(x + salt * 17, 374761393) + Math.imul(y - salt * 29, 668265263);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  }
  function blendPixel(data, offset, rgb, amount) {
    for (let k = 0; k < 3; k++) data[offset + k] = Math.round(data[offset + k] * (1 - amount) + rgb[k] * amount);
  }
  function weatherSprite(ctx, P, ox, oy, w, h) {
    const image = ctx.getImageData(0, 0, w, h), data = image.data;
    const materials = [
      [P.roof, P.roofHi, P.ink, 1], [P.slate, P.slateHi, P.ink, 2],
      [P.wood, P.woodHi, P.woodDk, 3], [P.stone, P.stoneHi, P.stoneDk, 4],
      [P.plaster, P.plasterHi, P.stoneDk, 5],
    ];
    const keys = new Map(materials.map(([base, light, dark, salt]) => {
      const rgb = hexRgb(base);
      return [(rgb[0] << 16) | (rgb[1] << 8) | rgb[2], { light: hexRgb(light), dark: hexRgb(dark), salt }];
    }));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] !== 255) continue;
      const material = keys.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (!material) continue;
      const gx = ox + x, gy = oy + y;
      const fleck = grain(gx, gy, material.salt);
      const patch = grain(gx >> 2, gy >> 2, material.salt + 11);
      if (fleck > .91 || patch > .82 && fleck > .58) blendPixel(data, i, material.light, .35);
      else if (fleck < .08 || patch < .18 && fleck < .43) blendPixel(data, i, material.dark, .3);
    }
    ctx.putImageData(image, 0, 0);
  }
  function textureSea(image, P) {
    const data = image.data, light = hexRgb(P.seaHi), dark = hexRgb(P.sea[3]);
    for (let y = HORIZON + 2; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const patch = grain(x >> 3, y >> 2, 19), fleck = grain(x, y, 23);
      const current = Math.sin(x * .105 + y * .19) + Math.sin(x * .037 - y * .11);
      if (patch > .54 && current > .5 && fleck > .52) blendPixel(data, i, light, .08 + .08 * fleck);
      else if (patch < .32 && fleck < .48) blendPixel(data, i, dark, .16);
      if (fleck > .982 && y > HORIZON + 18) blendPixel(data, i, light, .24);
    }
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function dither(img, y0, y1, stops) {
    const d = new Uint32Array(img.data.buffer), rgb = stops.map(hexRgb), w = img.width;
    for (let y = y0; y < y1; y++) {
      const t = (y - y0) / Math.max(1, y1 - y0 - 1) * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(t)), f = (t - i) * 3;
      const l = Math.min(2, Math.floor(f)), sub = f - l, A = rgb[i], B = rgb[i + 1];
      const c1 = A.map((v, k) => v + (B[k] - v) * l / 3), c2 = A.map((v, k) => v + (B[k] - v) * (l + 1) / 3);
      const p1 = (255 << 24) | (c1[2] << 16) | (c1[1] << 8) | c1[0], p2 = (255 << 24) | (c2[2] << 16) | (c2[1] << 8) | c2[0];
      for (let x = 0; x < w; x++) d[y * w + x] = BAYER[(y & 3) * 4 + (x & 3)] < sub ? p2 : p1;
    }
  }
  // Drawing context bound to a palette. Keys resolve to palette colours;
  // literal hex colours are pulled toward the period tint so fixed-colour
  // sprites (dog, flags, fish) sit in the same light as the buildings.
  function G(ctx, P) {
    const col = k => (typeof P[k] === 'string' ? P[k] : k[0] === '#' ? (P.tintA ? mix(k, P.tintC, P.tintA) : k) : k);
    const g = {
      P, ctx, col,
      r(x, y, w, h, k) { ctx.fillStyle = col(k); ctx.fillRect(x, y, w, h); },
      a(alpha, fn) { const o = ctx.globalAlpha; ctx.globalAlpha = o * alpha; fn(); ctx.globalAlpha = o; },
      line(x0, y0, x1, y1, k) {
        ctx.fillStyle = col(k); const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy;
        for (;;) { ctx.fillRect(x0, y0, 1, 1); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
      },
      spr(x, y, rows, map) { rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const ch = row[i]; if (ch !== '.') { ctx.fillStyle = col(map[ch]); ctx.fillRect(x + i, y + j, 1, 1); } } }); },
      roof(cx, y0, y1, half, k, kHi) { for (let y = y0; y <= y1; y++) { const hw = Math.round((y - y0) / (y1 - y0) * half); g.r(cx - hw, y, hw * 2 + 1, 1, (y - y0) % 4 === 0 ? kHi : k); if ((y - y0) % 4 === 2) for (let x = cx - hw + ((y >> 2) & 1) * 3; x < cx + hw; x += 6) g.r(x, y, 1, 1, 'ink'); } g.line(cx - half, y1, cx, y0, kHi); },
      bricks(x0, y0, w, h, k, kHi, kDk) { g.r(x0, y0, w, h, k); for (let y = y0; y < y0 + h; y += 4) { g.r(x0, y, w, 1, kDk); for (let x = x0 + ((y - y0) / 4 % 2 ? 4 : 0); x < x0 + w; x += 8) { g.r(x, y + 1, 1, 3, kDk); g.r(x + 1, y + 1, 5, 1, kHi); } } },
      glow(x, y, rad, k, alpha) { const gr = ctx.createRadialGradient(x + .5, y + .5, 0, x + .5, y + .5, rad); const c = col(k); gr.addColorStop(0, c); gr.addColorStop(1, c + '00'); g.a(alpha, () => { ctx.fillStyle = gr; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2); }); },
      win(x, y, w, h) { g.r(x - 1, y - 1, w + 2, h + 2, 'woodDk'); g.r(x, y, w, h, mix(P.win, P.light, P.lamps)); g.r(x + (w >> 1), y, 1, h, 'woodDk'); g.r(x, y + (h >> 1), w, 1, 'woodDk'); if (P.lamps < .3) g.r(x + 1, y + 1, 1, 2, 'plasterHi'); g.r(x - 1, y + h + 1, w + 2, 1, 'woodHi'); },
    };
    return g;
  }

  // ---------- sprites ----------
  const S = {
    dog: ['.......yy.', '......yyyy', '......yky.', '......yyyn', '....yyyyy.', '..yyyyyyy.', '..yyyyyyy.', '..y.y..y.y'],
    angler: ['..hhhh...', '.hhhhhh..', '.hhhhh...', '.hhhsse..', '..ssse...', '.kkwkkss.', '.kktkkk..', '.kkkkkk..', '..pppp...', '..pppp...', '..ss.ss..', '..bb.bb..'],
    twin: ['.h.hhh.h.', 'hhhhhhhhh', 'hhssesshh', '.hsssss..', '.rrkrrr..', '.rrrrrrs.', '.rrrrrr..', '..rrrr...', '..pppp...', '..pp.pp..', '..pp.pp..', '..bb.bb..'],
    pony: ['.hhhhhh..', 'hhhhhhhh.', 'hhsssehh.', '.hsssss..', '.wkkwss..', '.wpppwss.', '.wppppw..', '..pppp...', '..pppp...', '..pp.pp..', '..pp.pp..', '..bb.bb..'],
    chest: ['..wwwwwwwwww..', '.wWWWWWWWWWWw.', '.wWggWWWWggWw.', 'wwwwwwwwwwwwww', 'gggggggggggggg', 'wWWWWWggWWWWWw', 'wWWWWWgkWWWWWw', 'wWWWWWggWWWWWw', 'wWWWWWWWWWWWWw', 'wwwwwwwwwwwwww'],
    anvil: ['skkkkkkkk.', '.kkkkkkkkk', '...kkkk...', '...kkkk...', '..kkkkkk..', '.kkkkkkkk.'],
    lock: ['.ggg.', 'g...g', 'ggggg', 'gGkGg', 'ggggg'],
    merchant: ['.hhh.', 'hhhhh', '.sss.', '.sks.', 'aaaaa'],
    barrel: ['.www.', 'kkkkk', 'wWWWw', 'kkkkk', 'wWWWw', 'kkkkk', '.www.'],
    gull: [['k.....k', '.k...k.', '..kkk..'], ['.......', 'kkk.kkk', '...k...']],
    fishling: ['.fff.', 'ffffk', '.fff.'],
  };
  const DOG = { y: '#d9a441', k: 'ink', n: 'ink' };
  const MAN = { h: '#c4d0f5', s: '#f1c9ad', e: '#88a149', k: '#24212d', w: '#f4f1e6', t: '#ca4057', p: '#464477', b: '#262531' };
  const TWIN = { h: '#d95969', s: '#f6d2bb', e: '#e7ac45', r: '#a8454f', k: '#302c31', p: '#aaa092', b: '#302d2a' };
  const PONY = { h: '#e7e8f3', s: '#f4d9c8', e: '#7596b0', w: '#e7e2d5', k: '#334863', p: '#3b5579', b: '#483a31' };
  function activeAngler() {
    try {
      const look = JSON.parse(localStorage.getItem('fishing_char_v2') || '{}');
      if (look.model === 'twin') return { rows: S.twin, palette: TWIN };
      if (look.model === 'pony') return { rows: S.pony, palette: PONY };
    } catch (_) { /* 离线或私密模式保持默认角色 */ }
    return { rows: S.angler, palette: anglerPalette() };
  }
  function anglerPalette() {
    const palette = Object.assign({}, MAN);
    try {
      const look = JSON.parse(localStorage.getItem('fishing_char_v2') || '{}');
      const hairs = { teal: '#81d0db', red: '#dd94b5', cream: '#e2e1d1' };
      const uniforms = {
        yellow: ['#5c4730', '#7f5b3b', '#e1b556'],
        red: ['#5d2b3d', '#7d385b', '#eeafbe'],
        blue: ['#284563', '#32648d', '#69cdd6'],
      };
      const skins = { tan: '#c7a08c', dark: '#8e6f64' };
      if (hairs[look.hat]) palette.h = hairs[look.hat];
      if (uniforms[look.outfit]) [palette.k, palette.p, palette.t] = uniforms[look.outfit];
      if (skins[look.skin]) palette.s = skins[look.skin];
    } catch (_) { /* 私密浏览模式保持原色 */ }
    return palette;
  }
  const CHEST = { w: 'woodDk', W: 'wood', g: '#e8b83a', k: 'ink' };
  const IRON = { s: 'stoneHi', k: 'ink' };
  const LOCK = { g: '#e8b83a', G: '#b8862a', k: 'ink' };
  const MERCH = { h: '#c83a3a', s: '#f0c090', k: 'ink', a: 'plasterHi' };
  const BARREL = { w: 'woodDk', W: 'woodHi', k: 'ink' };

  // ---------- places: sprite box, drawing, lights ----------
  // box = sprite canvas bounds; hot = hotspot bounds; door = what gets boarded up when locked.
  const PLACES = {
    sea: { box: [372, 50, 108, 130], hot: [378, 54, 102, 124], door: [449, 118, 7, 10], sign: [428, 58], draw: drawLighthouse, lights: lightLighthouse },
    character: { box: [0, 60, 76, 92], hot: [2, 74, 70, 76], door: [31, 120, 10, 26], sign: [37, 74], draw: drawHouse, lights: lightHouse },
    mail: { box: [70, 108, 22, 44], hot: [71, 110, 18, 40], door: [72, 120, 11, 10], sign: [79, 110], draw: drawMailbox, lights: null },
    inventory: { box: [84, 86, 66, 66], hot: [86, 88, 62, 62], door: [100, 114, 28, 32], sign: [116, 88], draw: drawWarehouse, lights: lightWarehouse },
    workshop: { box: [146, 58, 64, 94], hot: [148, 64, 60, 86], door: [156, 118, 18, 28], sign: [178, 82], draw: drawWorkshop, lights: lightWorkshop },
    chest: { box: [206, 136, 20, 16], hot: [206, 132, 20, 18], door: [209, 140, 14, 10], sign: [216, 132], draw: drawChest, lights: lightChest },
    mall: { box: [224, 98, 70, 54], hot: [226, 102, 66, 48], door: [229, 136, 26, 14], sign: [259, 102], draw: drawMarket, lights: lightMarket },
    ground: { box: [288, 64, 62, 88], hot: [292, 68, 56, 82], door: [316, 128, 12, 18], sign: [321, 68], draw: drawTavern, lights: lightTavern },
    board: { box: [348, 114, 22, 38], hot: [348, 116, 22, 34], door: [350, 120, 17, 13], sign: [359, 116], draw: drawBoard, lights: null },
    fishing: { box: [192, 138, 118, 64], hot: [194, 150, 136, 70], door: null, sign: [262, 150], draw: drawPier, lights: lightPier },
  };
  const DRAW_ORDER = ['sea', 'character', 'mail', 'inventory', 'workshop', 'chest', 'mall', 'ground', 'board', 'fishing'];

  function drawHouse(g, st) {
    g.r(4, 146, 66, 4, 'stoneDk'); g.r(4, 146, 66, 1, 'stone');
    for (let x = 8; x < 66; x += 3) { g.r(x, 104, 2, 42, 'wood'); g.r(x + 2, 104, 1, 42, 'woodDk'); }
    g.r(8, 104, 58, 1, 'woodHi');
    g.r(46, 78, 7, 18, 'stone'); g.r(46, 78, 7, 1, 'stoneHi'); g.r(45, 76, 9, 2, 'stoneDk'); g.r(52, 79, 1, 17, 'stoneDk');
    g.roof(37, 76, 104, 35, 'roof', 'roofHi');
    g.r(2, 104, 71, 2, 'woodDk');
    g.win(12, 112, 11, 10); g.win(51, 112, 11, 10);
    [12, 51].forEach(x => { g.r(x - 1, 124, 13, 3, 'woodDk'); for (let i = 0; i < 11; i += 2) g.r(x + i, 122, 1, 2, i % 4 ? '#e8b83a' : '#d04a5a'); });
    g.r(30, 119, 12, 27, 'woodDk'); g.r(31, 120, 10, 26, 'wood'); g.r(31, 120, 10, 1, 'woodHi'); g.r(33, 123, 6, 8, 'woodDk'); g.r(33, 134, 6, 9, 'woodDk'); g.r(39, 133, 1, 1, '#e8b83a');
    g.r(43, 111, 1, 3, 'ink'); g.r(42, 114, 3, 4, 'ink'); g.r(43, 115, 1, 2, mix(g.P.win, g.P.light, g.P.lamps));
    [[22, 106], [27, 107], [58, 106]].forEach(([x, y]) => { g.r(x, y - 1, 1, 1, 'ink'); g.spr(x - 2, y, ['.ff.', 'ffff', '.ff.'], { f: '#9fb8cc' }); });
    g.spr(57, 142, S.dog, DOG);
    if (st.houseFull) { g.r(6, 140, 5, 6, '#e8b83a'); g.r(7, 139, 3, 1, '#ffd23e'); g.r(12, 142, 4, 4, '#e8b83a'); }
  }
  function lightHouse(g, st, t) {
    const L = g.P.lamps; if (L > .05) { g.glow(17, 117, 9, 'light', .4 * L); g.glow(56, 117, 9, 'light', .4 * L); g.glow(43, 116, 7, 'light', .55 * L); }
    const tail = Math.floor(t * 4) % 2; g.r(56, 145 - tail, 2, 1, DOG.y); g.r(55, 144 - tail * 2, 1, 1, DOG.y);
    smoke(g, 49, 75, t, st.houseFull ? 1 : .7, 0);
  }
  function drawMailbox(g, st) {
    g.r(76, 130, 2, 20, 'woodDk'); g.r(76, 130, 1, 20, 'wood');
    g.r(73, 120, 9, 1, '#c83a3a'); g.r(72, 121, 11, 9, '#c83a3a'); g.r(72, 121, 11, 1, '#e05a4a'); g.r(82, 121, 1, 9, '#8e2a2a'); g.r(74, 124, 7, 1, 'ink');
    if (st.mail > 0) g.r(75, 122, 5, 2, '#f4f0e0');
    if (st.mail > 0) { g.r(84, 112, 1, 10, 'ink'); g.r(85, 112, 4, 3, '#ffd23e'); } else { g.r(83, 127, 6, 1, 'ink'); g.r(88, 127, 2, 3, '#ffd23e'); }
  }
  function drawWarehouse(g, st) {
    g.r(86, 146, 62, 4, 'stoneDk');
    for (let y = 100; y < 146; y += 3) { g.r(88, y, 56, 2, 'wood'); g.r(88, y + 2, 56, 1, 'woodDk'); }
    for (let y = 88; y <= 100; y++) { const hw = y < 93 ? 16 + (y - 88) * 2 : Math.round(26 + (y - 93) * .6); g.r(116 - hw, y, hw * 2, 1, y % 3 === 0 ? 'slateHi' : 'slate'); }
    g.r(100, 88, 32, 1, 'slateHi'); g.r(86, 100, 60, 1, 'ink');
    g.win(111, 103, 10, 6);
    g.r(98, 113, 32, 1, 'ink'); g.r(100, 114, 28, 32, 'woodDk');
    [101, 115].forEach(x => { g.r(x, 115, 12, 31, 'wood'); g.line(x, 115, x + 11, 145, 'woodHi'); g.line(x + 11, 115, x, 145, 'woodHi'); g.r(x, 115, 12, 1, 'woodHi'); });
    const spots = [[130, 138], [138, 138], [130, 130], [89, 138], [138, 130], [134, 122]];
    for (let i = 0; i < Math.min(st.crates, spots.length); i++) { const [x, y] = spots[i]; g.r(x, y, 8, 8, 'woodDk'); g.r(x + 1, y + 1, 6, 6, 'woodHi'); g.line(x + 1, y + 1, x + 6, y + 6, 'woodDk'); g.r(x + 1, y + 1, 6, 1, 'wood'); }
  }
  function lightWarehouse(g) { if (g.P.lamps > .05) g.glow(116, 106, 8, 'light', .35 * g.P.lamps); }
  function drawWorkshop(g) {
    g.r(148, 146, 62, 4, 'stoneDk');
    g.bricks(150, 104, 56, 42, 'stone', 'stoneHi', 'stoneDk');
    g.roof(178, 84, 104, 30, 'slate', 'slateHi'); g.r(148, 104, 61, 1, 'ink');
    g.bricks(193, 64, 9, 32, 'stone', 'stoneHi', 'stoneDk'); g.r(192, 62, 11, 2, 'stoneDk');
    g.r(175, 91, 6, 6, 'woodDk'); g.r(176, 92, 4, 4, mix(g.P.win, g.P.light, g.P.lamps));
    g.r(158, 118, 14, 1, 'stoneDk'); g.r(156, 119, 18, 27, 'stoneDk'); g.r(157, 120, 16, 26, 'ink');
    g.r(159, 138, 12, 8, '#3a1a10'); g.r(160, 140, 10, 4, '#a8401c');
    g.r(184, 124, 11, 22, 'woodDk'); g.r(185, 125, 9, 21, 'wood'); g.r(185, 129, 9, 1, 'ink'); g.r(185, 139, 9, 1, 'ink');
    g.r(178, 99, 1, 3, 'ink'); g.spr(175, 102, ['.kkk.', 'k.g.k', 'kgggk', 'k.g.k', '.kkk.'], { k: 'ink', g: '#e8b83a' });
    g.spr(196, 144, S.anvil, IRON);
  }
  function lightWorkshop(g, st, t) {
    const f = .7 + .3 * Math.sin(t * 9) * Math.sin(t * 5.3);
    g.glow(165, 140, 14, '#ff8a3c', .55 * f); g.r(161, 139, 8, 3, mix('#ff9a3c', '#ffe08a', f));
    smoke(g, 197, 61, t, 1, st.forgeReady ? 1 : 0);
    if (st.forgeReady) sparkle(g, [[170, 86], [206, 72], [150, 110], [196, 118]], t);
  }
  function drawChest(g, st) { g.r(207, 149, 17, 1, 'ink'); g.spr(209, 140, S.chest, CHEST); if (st.chestReady) g.r(211, 142, 10, 1, '#ffe08a'); }
  function lightChest(g, st, t) {
    if (!st.chestReady) return;
    const k = .5 + .5 * Math.sin(t * 3); g.glow(216, 142, 13, '#ffd23e', .25 + .25 * k);
    g.a(.35 + .3 * k, () => { g.r(212, 132, 1, 8, '#ffe08a'); g.r(216, 128, 1, 12, '#ffe08a'); g.r(220, 132, 1, 8, '#ffe08a'); });
  }
  function awning(g, x0, x1, y0, kA, kB) {
    for (let x = x0; x < x1; x++) { const k = Math.floor((x - x0) / 4) % 2 ? kB : kA; g.r(x, y0, 1, 8, k); if ((x - x0) % 4 === 1 || (x - x0) % 4 === 2) g.r(x, y0 + 8, 1, 1, k); }
    g.r(x0, y0, x1 - x0, 1, 'ink');
  }
  function drawMarket(g) {
    [228, 254, 260, 288].forEach(x => { g.r(x, 112, 2, 38, 'woodDk'); g.r(x, 112, 1, 38, 'wood'); });
    awning(g, 226, 258, 106, '#c83a3a', '#f0e6d0'); awning(g, 258, 292, 106, '#2f8c7a', '#f0e6d0');
    g.r(229, 136, 26, 14, 'wood'); g.r(229, 136, 26, 1, 'woodHi'); g.r(229, 142, 26, 1, 'woodDk');
    g.r(231, 133, 22, 3, '#cfe8f4');
    [[232, 131, '#9fb8cc'], [239, 131, '#e0906a'], [246, 131, '#c8d0dc']].forEach(([x, y, c]) => g.spr(x, y, S.fishling, { f: c, k: 'ink' }));
    g.spr(270, 124, S.merchant, MERCH);
    g.r(261, 136, 27, 14, 'wood'); g.r(261, 136, 27, 1, 'woodHi'); g.r(261, 142, 27, 1, 'woodDk');
    [[263, '#e8b83a'], [271, '#6cc04a'], [279, '#d05050']].forEach(([x, c]) => { g.r(x, 131, 6, 5, 'woodDk'); g.r(x + 1, 131, 4, 2, c); });
    g.r(241, 114, 1, 3, 'ink'); g.r(240, 117, 3, 4, 'ink');
    for (let x = 226; x <= 292; x++) g.r(x, Math.round(100 + 3 * Math.sin((x - 226) / 66 * Math.PI)), 1, 1, 'ink');
  }
  function lightMarket(g, st, t) {
    const L = Math.max(.25, g.P.lamps), cols = ['#ffd23e', '#ff6b6b', '#34e0c0', '#8ad4ff'];
    for (let i = 0, x = 228; x < 292; x += 5, i++) { const y = Math.round(100 + 3 * Math.sin((x - 226) / 66 * Math.PI)) + 1; const on = (i + Math.floor(t * 2)) % 4 !== 0; g.r(x, y, 1, 2, on ? cols[i % 4] : 'ink'); if (on && g.P.lamps > .2) g.glow(x, y, 3, cols[i % 4], .35 * L); }
    g.r(241, 118, 1, 2, 'light'); if (g.P.lamps > .05) g.glow(241, 119, 8, 'light', .45 * g.P.lamps);
  }
  const TAVERN_WINDOWS = [[297, 100, 7, 8], [310, 100, 8, 8], [324, 100, 8, 8], [338, 100, 7, 8], [299, 130, 9, 8], [334, 130, 9, 8]];
  function drawTavern(g) {
    g.r(292, 146, 58, 4, 'stoneDk');
    g.bricks(296, 124, 50, 22, 'stone', 'stoneHi', 'stoneDk');
    g.r(294, 96, 54, 28, 'plaster'); g.r(294, 96, 54, 1, 'plasterHi');
    [294, 306, 320, 334, 346].forEach(x => g.r(x, 96, 2, 28, 'woodDk'));
    [96, 109, 122].forEach(y => g.r(294, y, 54, 2, 'woodDk'));
    g.line(308, 111, 319, 121, 'woodDk'); g.line(322, 121, 333, 111, 'woodDk');
    g.roof(321, 68, 96, 30, 'roof', 'roofHi'); g.r(290, 96, 62, 1, 'ink');
    g.r(334, 74, 6, 14, 'stone'); g.r(333, 72, 8, 2, 'stoneDk');
    TAVERN_WINDOWS.forEach(w => g.win(...w));
    g.r(315, 127, 14, 19, 'woodDk'); g.r(317, 126, 10, 1, 'woodDk'); g.r(316, 128, 12, 18, 'wood'); g.r(321, 128, 1, 18, 'woodDk'); g.r(319, 137, 1, 1, '#e8b83a');
    g.r(313, 120, 18, 5, 'woodHi'); g.r(313, 120, 18, 1, 'woodDk'); g.spr(319, 120, ['.www.', 'wbbbw', 'wbbbww', 'wbbbw'], { w: '#f4f0e0', b: '#e8b83a' });
    g.spr(297, 143, S.barrel, BARREL); g.spr(303, 143, S.barrel, BARREL);
  }
  function lightTavern(g, st) {
    const L = g.P.lamps;
    TAVERN_WINDOWS.forEach(([x, y, w, h], i) => {
      if (L > .05) g.glow(x + w / 2, y + h / 2, 8, 'light', .35 * L);
      if (i < st.online) { const cx = x + (w >> 1) - 1; g.r(cx, y + h - 5, 3, 3, 'ink'); g.r(cx - 1, y + h - 2, 5, 2, 'ink'); }
    });
    smoke(g, 337, 71, 0, .5, 0);
  }
  function drawBoard(g, st) {
    g.r(352, 128, 2, 22, 'woodDk'); g.r(365, 128, 2, 22, 'woodDk');
    g.r(349, 117, 20, 3, 'roof'); g.r(349, 117, 20, 1, 'roofHi');
    g.r(350, 120, 18, 13, 'woodDk'); g.r(351, 121, 16, 11, 'woodHi');
    const P = [[352, 122, 5, 4], [358, 122, 4, 5], [363, 123, 3, 4], [353, 127, 4, 4], [359, 128, 5, 3]];
    for (let i = 0; i < Math.min(st.papers, P.length); i++) { const [x, y, w, h] = P[i]; g.r(x, y, w, h, i % 2 ? '#f4f0e0' : '#e8dcc0'); g.r(x + 1, y, 1, 1, '#d04040'); }
  }
  function drawLighthouse(g) {
    g.r(372, 150, 62, 3, 'wood'); g.r(372, 150, 62, 1, 'woodHi'); [380, 396, 412, 428].forEach(x => g.r(x, 153, 2, 16, 'woodDk'));
    for (let y = 126; y < 180; y++) {
      const l = Math.round(438 - (y - 126) * .9 + Math.sin(y * .5) * 2), r = Math.min(479, Math.round(470 + (y - 126) * .3 + Math.sin(y * .3) * 2));
      g.r(l, y, r - l, 1, y < 132 ? 'stoneHi' : y > 168 ? 'stoneDk' : 'stone');
      if (y > 130 && y % 5 === 0) g.r(l + 4 + (y % 11), y, 4, 1, 'tree');
    }
    for (let x = 424; x < 480; x += 3) g.r(x, 178 + (x % 2), 2, 1, 'foam');
    for (let y = 80; y < 128; y++) {
      const hw = Math.round(5 + (y - 80) / 48 * 3), band = Math.floor((y - 80) / 8) % 2;
      g.r(452 - hw, y, hw * 2, 1, band ? '#c63c3c' : '#eef0f4'); g.r(452 + hw - 1, y, 1, 1, band ? '#8e2a2a' : '#b8bcc6');
    }
    g.r(449, 118, 6, 10, 'woodDk'); g.r(451, 100, 2, 3, 'ink');
    g.r(444, 76, 17, 4, 'ink'); for (let x = 444; x < 461; x += 2) g.r(x, 74, 1, 2, 'ink');
    g.r(447, 66, 11, 10, 'ink'); g.r(448, 67, 9, 8, mix(g.P.win, g.P.light, Math.max(.4, g.P.lamps))); g.r(452, 67, 1, 8, 'ink');
    g.roof(452, 58, 66, 7, '#c63c3c', '#e05a4a'); g.r(452, 55, 1, 3, 'ink');
  }
  function lightLighthouse(g, st, t) {
    const B = st.voyageAway ? Math.max(g.P.lamps > .3 ? .8 : .25, g.P.beam) : g.P.beam;
    g.glow(452, 71, 10, 'light', .5 * Math.max(.3, B));
    if (B < .02) return;
    const a = Math.PI + .35 + Math.sin(t * .55) * 1.05, len = 300, ctx = g.ctx;
    g.a(.16 * B, () => { ctx.fillStyle = g.col('light'); ctx.beginPath(); ctx.moveTo(452, 71); ctx.lineTo(452 + Math.cos(a - .07) * len, 71 + Math.sin(a - .07) * len); ctx.lineTo(452 + Math.cos(a + .07) * len, 71 + Math.sin(a + .07) * len); ctx.closePath(); ctx.fill(); });
  }
  function drawShip(g) {
    for (let y = 164; y < 176; y++) { const l = 378 + Math.round((y - 164) * .6), r = 418 - Math.round((y - 164) * .3) + (y < 167 ? 4 : 0); g.r(l, y, r - l, 1, y === 167 ? 'wood' : y < 167 ? 'woodHi' : 'woodDk'); }
    [386, 394, 402, 410].forEach(x => g.r(x, 170, 2, 2, mix(g.P.win, g.P.light, g.P.lamps)));
    g.r(396, 110, 2, 54, 'woodDk');
    for (let y = 116; y < 160; y++) { const w = Math.round((y - 116) * .42) + 3; g.r(398, y, w, 1, y % 9 === 0 ? 'plaster' : 'plasterHi'); g.r(398 + w - 1, y, 1, 1, 'plaster'); }
    for (let y = 122; y < 160; y++) { const w = Math.round((y - 122) * .35); g.r(395 - w, y, w, 1, 'plasterHi'); }
    g.r(398, 106, 6, 4, '#c83a3a'); g.r(398, 106, 1, 4, '#8e2a2a');
    g.line(397, 111, 422, 164, 'ink'); g.line(396, 111, 376, 164, 'ink');
  }
  function drawPier(g, st) {
    const player = activeAngler();
    g.r(196, 150, 6, 16, 'woodDk'); for (let y = 152; y < 166; y += 3) g.r(197, y, 4, 1, 'woodHi');
    g.r(196, 166, 112, 5, 'wood'); g.r(196, 166, 112, 1, 'woodHi'); for (let x = 199; x < 308; x += 4) g.r(x, 167, 1, 4, 'woodDk');
    [200, 232, 264, 302].forEach(x => { g.r(x, 171, 3, 26, 'woodDk'); g.r(x, 171, 1, 26, 'wood'); g.a(.3, () => g.r(x, 199, 3, 10, 'woodDk')); });
    g.line(203, 173, 231, 194, 'woodDk'); g.line(235, 173, 263, 194, 'woodDk'); g.line(267, 173, 301, 194, 'woodDk');
    g.r(304, 148, 1, 18, 'ink'); g.r(303, 145, 3, 4, 'ink');
    g.r(250, 161, 6, 5, '#6a7a8e'); g.r(250, 161, 6, 1, '#8a9aae');
    if (st.fishing) { g.spr(266, 154, player.rows, player.palette); g.line(273, 159, 300, 139, 'woodHi'); }
    else { g.spr(274, 154, player.rows, player.palette); g.line(279, 160, 284, 136, 'woodHi'); }
  }
  function lightPier(g, st, t) {
    g.r(304, 146, 1, 2, 'light'); if (g.P.lamps > .05) g.glow(304, 147, 10, 'light', .5 * g.P.lamps);
    if (!st.fishing) return;
    const bob = Math.round(Math.sin(t * 3) * 1), bx = 322, by = 213 + bob;
    g.a(.55, () => { for (let i = 0; i <= 20; i++) { const k = i / 20, x = Math.round(300 + (bx - 300) * k), y = Math.round(139 + (by - 139) * k + Math.sin(k * Math.PI) * 6); g.r(x, y, 1, 1, 'foam'); } });
    g.r(bx, by - 2, 2, 2, '#d04040'); g.r(bx, by, 2, 1, '#f4f4f4');
    const ph = (t % 2) / 2, rw = Math.round(3 + ph * 10);
    g.a(.5 * (1 - ph), () => { g.r(bx - rw, by + 2, rw * 2 + 2, 1, 'foam'); });
  }
  function smoke(g, x, y, t, amount, sparks) {
    for (let i = 0; i < 7; i++) {
      const ph = (t * .22 + i / 7) % 1, s = 1 + Math.round(ph * 3);
      g.a(amount * .55 * (1 - ph), () => g.r(Math.round(x + ph * 10 + Math.sin(ph * 6 + i) * 1.5), Math.round(y - ph * 26), s, s, 'smoke'));
      if (sparks && i % 2) g.a(1 - ph, () => g.r(Math.round(x + 2 + Math.sin(i * 3 + t * 2) * 4), Math.round(y - ph * 18), 1, 1, '#ffd23e'));
    }
  }
  function sparkle(g, pts, t) {
    pts.forEach(([x, y], i) => { const k = (Math.sin(t * 4 + i * 1.7) + 1) / 2; if (k < .35) return; g.a(k, () => { g.r(x, y - 2, 1, 5, '#ffe08a'); g.r(x - 2, y, 5, 1, '#ffe08a'); }); });
  }
  function boardUp(g, [x, y, w, h]) {
    g.line(x, y + 2, x + w - 1, y + h - 3, 'woodHi'); g.line(x, y + 3, x + w - 1, y + h - 2, 'woodDk');
    g.line(x + w - 1, y + 2, x, y + h - 3, 'woodHi'); g.line(x + w - 1, y + 3, x, y + h - 2, 'woodDk');
    g.spr(x + (w >> 1) - 2, y + (h >> 1) - 2, S.lock, LOCK);
  }

  // ---------- layers ----------
  function buildSprite(id, P, st) {
    const p = id === 'ship' ? { box: [374, 104, 50, 74], draw: drawShip } : PLACES[id];
    const [x, y, w, h] = p.box, c = canvas(w, h), ctx = c.getContext('2d');
    ctx.translate(-x, -y); const g = G(ctx, P); p.draw(g, st);
    if (st.locked && st.locked[id] && p.door) boardUp(g, p.door);
    weatherSprite(ctx, P, x, y, w, h);
    const sil = canvas(w, h), s = sil.getContext('2d'); s.drawImage(c, 0, 0); s.globalCompositeOperation = 'source-in'; s.fillStyle = '#ffd23e'; s.fillRect(0, 0, w, h);
    return { c, sil, x, y, w, h };
  }
  const STARS = (() => { const R = rng(3), a = []; for (let i = 0; i < 80; i++) a.push({ x: Math.floor(R() * W), y: Math.floor(R() * 96), ph: R() * 6, big: R() < .08 }); return a; })();
  const CLOUDS = (() => { const R = rng(11), a = []; for (let i = 0; i < 6; i++) a.push({ x: R() * W, y: 14 + R() * 50, w: 18 + Math.floor(R() * 26), sp: .6 + R() * 1.2, seed: Math.floor(R() * 999) }); return a; })();
  function makeLayers(P, st) {
    const sky = canvas(W, HORIZON + 1), sc = sky.getContext('2d'), si = sc.createImageData(W, HORIZON + 1); dither(si, 0, HORIZON + 1, P.sky); sc.putImageData(si, 0, 0);
    const land = canvas(W, H), lc = land.getContext('2d'), li = lc.createImageData(W, H); dither(li, HORIZON, H, P.sea); textureSea(li, P); lc.putImageData(li, 0, 0);
    const g = G(lc, P), ridge = X => Math.round(92 + 9 * Math.sin(X * .014 + 1.3) + 6 * Math.sin(X * .043 + .4) + 2 * Math.sin(X * .13));
    const hill = X => Math.round(106 + 5 * Math.sin(X * .021 + 2.1) + 3 * Math.sin(X * .07 + 1));
    for (let X = 0; X < W; X++) { const y = ridge(X); g.r(X, y, 1, HORIZON - y, 'far'); if (y < 90) g.r(X, y, 1, Math.min(3, 91 - y), 'snow'); }
    for (let X = 0; X < W; X++) { const y = hill(X); g.r(X, y, 1, HORIZON - y, 'near'); }
    const R = rng(7); for (let X = 2; X < W; X += 3 + Math.floor(R() * 5)) { const b = hill(X), h = 3 + Math.floor(R() * 4); for (let k = 0; k < h; k++) g.r(X - (k >> 1), b - h + k, (k >> 1) * 2 + 1, 1, 'tree'); }
    g.a(.55, () => g.r(0, HORIZON, W, 1, 'seaHi'));
    const sprites = {}; DRAW_ORDER.forEach(id => { sprites[id] = buildSprite(id, P, st); }); sprites.ship = buildSprite('ship', P, st);
    const mid = canvas(W, H), mc = mid.getContext('2d'), m = G(mc, P);
    m.r(0, GROUND, 380, QUAY_B - GROUND, 'quay'); m.r(0, GROUND, 380, 2, 'quayHi');
    for (let row = 0; row < 2; row++) { const y = GROUND + 3 + row * 6; m.r(0, y - 1, 380, 1, 'quayDk'); for (let x = row ? -8 : 0; x < 380; x += 16) m.r(x, y, 1, 5, 'quayDk'); }
    for (let y = GROUND + 2; y < QUAY_B - 1; y++) for (let x = 0; x < 380; x++) {
      const n = grain(x, y, 31);
      if (n > .958) m.r(x, y, 1, 1, 'quayHi');
      else if (n < .028) m.r(x, y, 1, 1, 'quayDk');
    }
    m.r(0, QUAY_B - 1, 380, 1, 'quayDk'); m.a(.45, () => m.r(0, QUAY_B, 380, 2, 'ink'));
    for (let x = 2; x < 380; x += 2) if (grain(x, QUAY_B, 37) > .72) m.a(.38, () => m.r(x, QUAY_B + 2 + (x % 3), 1 + (x % 4 === 0 ? 1 : 0), 1, 'foam'));
    [70, 146, 224, 290, 368].forEach(x => { m.r(x, GROUND - 4, 3, 4, 'ink'); m.r(x - 1, GROUND - 5, 5, 1, 'stoneHi'); });
    [[225, 128], [348, 128]].forEach(([x, y]) => { m.r(x, y, 1, 22, 'ink'); m.r(x - 1, y - 4, 3, 4, 'ink'); });
    DRAW_ORDER.forEach(id => { const s = sprites[id]; mc.drawImage(s.c, s.x, s.y); });
    return { sky, land, mid, sprites };
  }

  // ---------- frame ----------
  function drawFrame(ctx, L, P, st, t, sunM, s, hover) {
    const g = G(ctx, P);
    ctx.drawImage(L.sky, 0, 0);
    if (P.star > .03) STARS.forEach(o => { const a = P.star * (.5 + .5 * Math.sin(t * 1.6 + o.ph)); g.a(a, () => { g.r(o.x, o.y, 1, 1, '#dfeaff'); if (o.big) { g.r(o.x - 1, o.y, 3, 1, '#dfeaff'); g.r(o.x, o.y - 1, 1, 3, '#dfeaff'); } }); });
    const cel = celestial(sunM, s), rad = cel.sun ? 8 : 6;
    if (cel.y < HORIZON + 4) {
      g.glow(cel.x, cel.y, cel.sun ? 30 : 22, 'glow', cel.sun ? .45 : .3);
      for (let dy = -rad; dy <= rad; dy++) { const hw = Math.floor(Math.sqrt(rad * rad - dy * dy)); g.r(cel.x - hw, cel.y + dy, hw * 2 + 1, 1, 'sun'); }
      if (!cel.sun) { const cr = mix(P.sun, P.far, .25); g.r(cel.x - 2, cel.y - 2, 2, 2, cr); g.r(cel.x + 2, cel.y + 1, 2, 1, cr); g.r(cel.x - 1, cel.y + 3, 1, 1, cr); }
    }
    CLOUDS.forEach(c => {
      const x = Math.round(((c.x + t * c.sp) % (W + 80)) - 40), R = rng(c.seed);
      g.a(P.cloudA, () => { for (let i = 0; i < 5; i++) { const lw = Math.round(c.w * (.35 + R() * .45)), lx = x + Math.round(R() * (c.w - lw)), ly = Math.round(c.y + R() * 4); g.r(lx, ly, lw, 3, P.cloud[0]); g.r(lx + 1, ly + 3, lw - 2, 1, P.cloud[1]); } });
    });
    ctx.drawImage(L.land, 0, 0);
    [121, 124, 128, 133, 139, 146, 169, 173, 178, 184, 191, 199, 208, 218, 229].forEach((y, row) => {
      const len = 2 + Math.round((y - HORIZON) / 14), sp = (.4 + (y - HORIZON) / 50) * (row % 2 ? 1 : -1), n = 7 + (row % 3);
      g.a(.22 + (y - HORIZON) / 122 * .35, () => { for (let i = 0; i < n; i++) { const x = Math.round((((i * 97 + y * 13) % W) + t * sp * 8) % W + W) % W; g.r(x, y, len, 1, row > 9 && i % 3 === 0 ? 'foam' : 'seaHi'); } });
    });
    if (cel.y < HORIZON) g.a(cel.sun ? .55 : .4, () => { for (let y = QUAY_B + 2; y < H; y += 2) { const w = 2 + ((y * 7 + Math.floor(t * 5)) % 5); g.r(Math.round(cel.x - w / 2 + Math.sin(t * 2 + y) * 2), y, w, 1, 'glow'); } });
    if (P.lamps > .05) g.a(.35 * P.lamps, () => [204, 304, 165, 318, 44].forEach((x, i) => { for (let y = QUAY_B + 2; y < QUAY_B + 20; y += 3) g.r(Math.round(x + Math.sin(t * 3 + y + i) * 2), y, 2 + (y % 3), 1, 'light'); }));
    ctx.drawImage(L.mid, 0, 0);
    const ship = L.sprites.ship, bob = Math.round(Math.sin(t * 1.4));
    if (!st.voyageAway) ctx.drawImage(ship.c, ship.x, ship.y + bob);
    else g.r(462, HORIZON - 3, 4, 2, 'ink');
    if (hover && L.sprites[hover]) {
      const sp = L.sprites[hover];
      [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => { ctx.drawImage(sp.sil, sp.x + dx, sp.y + dy); if (hover === 'sea' && !st.voyageAway) ctx.drawImage(ship.sil, ship.x + dx, ship.y + bob + dy); });
      ctx.drawImage(sp.c, sp.x, sp.y); if (hover === 'sea' && !st.voyageAway) ctx.drawImage(ship.c, ship.x, ship.y + bob);
    }
    DRAW_ORDER.forEach(id => { const p = PLACES[id]; if (p.lights) p.lights(g, st, t); });
    if (P.star < .5) for (let i = 0; i < 3; i++) { const x = Math.round((t * 16 + i * 170) % (W + 40)) - 20, y = Math.round(34 + i * 9 + Math.sin(t * 2 + i) * 2); g.spr(x, y, S.gull[Math.floor(t * 4 + i) % 2], { k: P.star > .2 ? 'ink' : '#f4f4f4' }); }
    const jp = (t % 9) / 1.3; if (jp < 1) { g.spr(Math.round(120 + jp * 16), Math.round(206 - Math.sin(jp * Math.PI) * 12), S.fishling, { f: '#c8d4e0', k: 'ink' }); }
  }

  // Sprite plus its lighting pass (sparks, lit windows, silhouettes) at a given moment — used by the art sheet.
  function renderPlace(id, P, st, t) {
    const s = buildSprite(id, P, st), c = canvas(s.w, s.h), ctx = c.getContext('2d');
    ctx.drawImage(s.c, 0, 0); ctx.translate(-s.x, -s.y);
    const p = PLACES[id]; if (p && p.lights) p.lights(G(ctx, P), st, t);
    return { c, w: s.w, h: s.h };
  }
  window.HarborArt = { renderPlace, W, H, HORIZON, PAL, PERIOD_NAME, PERIOD_ICON, ORDER, PLACES, DRAW_ORDER, toMin, fmt, periodAt, paletteAt, sampleMinute, celestial, validPeriods, makeLayers, buildSprite, drawFrame, mix };
})();
