/* 远洋 CSS 像素海图。640×400 逻辑网格，按同宽色段合并为 box-shadow。
   无位图、canvas 或 SVG；固定种子只影响装饰，不参与游戏随机数。
   地貌构建一次并缓存，钓点继续由 UI 按百分比独立定位。 */
(function () {
  'use strict';
  const W = 640, H = 400;
  const COLORS = [
    '', '#103753', '#153d60', '#1b4467', '#244f70', '#315f79', '#416c7b',
    '#527c86', '#709291', '#8ea79d', '#b2baaa', '#7b8777',
    '#8e8165', '#a29272', '#b4a17d', '#c1af87', '#6a6549',
    '#343f2d', '#3d4932', '#465337', '#515d3e', '#5c6745', '#6a714c',
    '#263b2d', '#304831', '#3b5638', '#4a6442', '#5a714a',
    '#24352c', '#182e28', '#756f56', '#8b836b', '#a09a80',
    '#4a5350', '#5c635b', '#72776a', '#8c8f7c', '#a5a590',
    '#433d2d', '#69583d', '#85704c', '#a08a60', '#b4a27a',
    '#324a50', '#496067', '#637675', '#b9b69b', '#d0c6a5', '#0a263db0'
  ];
  let template;
  function build() {
    const pixels = new Uint8Array(W * H);
    let seed = 19027;
    function random() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    function hash(x, y) {
      let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
      n = Math.imul(n ^ n >>> 13, 1274126177);
      return ((n ^ n >>> 16) >>> 0) / 4294967295;
    }
    function noise(x, y, scale) {
      x /= scale; y /= scale;
      const ix = Math.floor(x), iy = Math.floor(y);
      let fx = x - ix, fy = y - iy;
      fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      return (hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx) * (1 - fy) +
        (hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx) * fy;
    }
    function put(x, y, c) {
      x = Math.round(x); y = Math.round(y);
      if (x >= 0 && x < W && y >= 0 && y < H) pixels[y * W + x] = c;
    }
    function rect(x, y, w, h, c) {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, c);
    }
    function line(x0, y0, x1, y1, c) {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= steps; i++) put(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, c);
    }
    function ellipse(cx, cy, rx, ry, c) {
      for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
        for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
          if ((x - cx) ** 2 / (rx * rx) + (y - cy) ** 2 / (ry * ry) <= 1) put(x, y, c);
        }
      }
    }
    // 分散群岛替代单个巨大的环形岛；出发大陆仅露出西南一角。
    // 第五个参数为岩质岛。三个固定钓点周围留出可读的海面。
    const islands = [
      [-9, 387, 69, 65, 0], [27, 354, 23, 22, 0], [56, 339, 10, 7, 1],
      [98, 319, 16, 10, 0], [116, 306, 9, 7, 1], [130, 325, 5, 4, 1], [149, 301, 4, 3, 1],
      [84, 88, 24, 13, 0], [106, 102, 12, 8, 0], [67, 107, 7, 5, 1], [118, 77, 5, 4, 1],
      [193, 161, 6, 4, 1], [203, 151, 3, 2, 1],
      [354, 165, 13, 7, 0], [370, 148, 15, 8, 0], [393, 143, 8, 4, 1],
      [421, 163, 9, 6, 1], [427, 189, 5, 8, 1], [405, 204, 12, 5, 0],
      [377, 207, 7, 4, 1], [347, 191, 8, 5, 1], [336, 178, 3, 3, 1],
      [510, 65, 7, 4, 1], [524, 53, 4, 3, 1], [576, 141, 4, 3, 1],
      [577, 294, 16, 9, 0], [559, 308, 8, 6, 1], [597, 278, 5, 4, 1],
      [282, 337, 5, 3, 1], [299, 345, 3, 2, 1]
    ];
    // 细小、成簇的短水纹，跟随近岸图的海蓝配色。
    for (let i = 0; i < 7600; i++) {
      const x = Math.floor(random() * W), y = Math.floor(random() * H);
      const c = random() < .09 ? 5 : 2 + Math.floor(random() * 3);
      if (noise(x, y, 22) > .3) line(x, y, x + Math.floor(random() * 3), y, c);
    }
    // 深海裂谷藏于水下，以低对比海底等深层表达，不画成地表黑色裂缝。
    for (let y = 40; y < 224; y++) {
      const t = (y - 40) / 184;
      const cx = 572 - t * 66 + Math.sin(t * 9) * 6;
      const width = 5 + Math.sin(t * Math.PI) * 10;
      for (let x = Math.floor(cx - width * 2); x < cx + width * 2; x++) {
        const d = Math.abs(x - cx) / width + (noise(x, y, 9) - .5) * .4;
        if (d < .65) put(x, y, 48);
        else if (d < 1.2 && hash(x, y) > .23) put(x, y, 1);
      }
    }
    const land = [];
    islands.forEach(function (isle, index) {
      const [cx, cy, rx, ry, rocky] = isle;
      for (let y = Math.max(0, Math.floor(cy - ry * 1.8)); y < Math.min(H, cy + ry * 1.8); y++) {
        for (let x = Math.max(0, Math.floor(cx - rx * 1.8)); x < Math.min(W, cx + rx * 1.8); x++) {
          const detail = noise(x + index * 51, y, 8) * .48 + noise(x, y, 3) * .16;
          const elevation = 1 - Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) + detail - .32;
          const speck = hash(x + 311, y + 713);
          let c = 0;
          if (elevation > .15) {
            const light = noise(x, y, 13) * 2 + speck * 2 + (cx - x) / rx;
            c = rocky ? 33 + Math.max(0, Math.min(4, Math.floor(light))) : 17 + Math.max(0, Math.min(5, Math.floor(light)));
            if (!rocky && elevation > .29 && speck > .85) land.push([x, y]);
            if (speck < .08) c = rocky ? 31 : 16;
          } else if (elevation > .025) c = rocky ? 33 + Math.floor(speck * 3) : 12 + Math.floor(speck * 4);
          else if (elevation > -.055) c = speck > .45 ? 11 : 8;
          else if (elevation > -.115) c = speck > .36 ? 9 + (speck > .82 ? 1 : 0) : 6;
          else if (elevation > -.25) c = 5 + Math.floor(speck * 3);
          else if (elevation > -.5 && speck > .36) c = 3 + Math.floor(speck * 3);
          if (c) put(x, y, c);
        }
      }
    });
    function tree(x, y, size) {
      ellipse(x + 2, y + 1, size * .6, 2, 29);
      rect(x, y - 3, 1, 4, 38);
      for (let yy = -size; yy < -1; yy++) {
        const tier = (yy + size) / size;
        const half = Math.max(1, Math.floor(tier * size * .4) - (yy % 3 === 0 ? 1 : 0));
        for (let xx = -half; xx <= half; xx++) {
          let c = xx < 0 ? 25 : 23;
          if (hash(x + xx, y + yy) > .68) c += 1;
          if (yy % 4 === 0) c = 29;
          put(x + xx, y + yy, c);
        }
      }
      put(x - 1, y - size + 1, 27);
    }
    land.sort(function (a, b) { return a[1] - b[1]; });
    land.forEach(function (p) { if (random() > .74) tree(p[0], p[1], 5 + Math.floor(random() * 7)); });
    // 小型岩柱、暗礁和白浪。远处地物与近处遵守相同海图比例。
    function rock(x, y, size) {
      ellipse(x, y + 2, size + 2, 2, 7);
      for (let yy = -size; yy <= 1; yy++) {
        const half = Math.max(1, Math.floor((yy + size + 1) * .7));
        for (let xx = -half; xx <= half; xx++) put(x + xx, y + yy, 33 + Math.min(4, Math.max(0, Math.floor((half - xx) / 2 + hash(x + xx, y + yy) * 2))));
      }
      line(x - size - 1, y + 3, x - 1, y + 3, 9);
    }
    islands.forEach(function (p) {
      if (p[4] && p[2] > 5) {
        rock(p[0], p[1], Math.min(7, Math.floor(p[2] * .5)));
        rock(p[0] - 4, p[1] + 2, 3);
      }
    });
    [[128, 308, 4], [151, 295, 3], [88, 334, 4], [328, 177, 3], [352, 156, 4],
      [399, 138, 3], [435, 184, 3], [412, 210, 4], [512, 61, 4], [525, 49, 3],
      [579, 139, 3], [585, 285, 4], [560, 313, 3], [288, 340, 3]].forEach(p => rock(...p));
    function house(x, y) {
      rect(x, y - 3, 7, 5, 40); rect(x + 5, y - 3, 2, 5, 39);
      for (let row = 0; row < 4; row++) rect(x - 1 + Math.floor(row / 2), y - 5 + row, 9 - row, 1, row % 2 ? 43 : 44);
      rect(x + 2, y, 2, 3, 38); put(x + 5, y - 1, 46);
    }
    // 港口退到大陆边缘；海上船长约地图宽度的 1.5%，强化远航距离。
    line(25, 352, 43, 358, 13); line(16, 369, 37, 359, 12);
    house(29, 350); house(15, 365); house(34, 369);
    rect(43, 358, 19, 3, 39);
    for (let x = 43; x < 63; x += 3) rect(x, 358, 1, 3, 41);
    line(43, 357, 64, 357, 42); rect(60, 355, 2, 9, 40);
    // 灯塔比近岸更小，仍保留砂岩塔身、暗色顶和暖色灯室。
    rect(105, 93, 3, 9, 32); rect(107, 93, 1, 9, 30);
    rect(104, 91, 5, 2, 45); put(106, 91, 47);
    line(104, 90, 108, 90, 43); put(106, 89, 43);
    function ship(x, y, left) {
      line(x - 6, y + 3, x + 7, y + 3, 6);
      line(x - 4, y + 4, x + 2, y + 4, 8);
      rect(x - 5, y, 10, 2, 39); line(x - 3, y + 2, x + 3, y + 2, 38);
      line(x - 5, y - 1, x + 4, y - 1, 41);
      line(x, y - 11, x, y, 40);
      for (let yy = -10; yy < -2; yy++) {
        const width = Math.min(5, Math.floor((yy + 11) * .8));
        for (let xx = 1; xx <= width; xx++) put(x + (left ? -xx : xx), y + yy, xx < 3 ? 46 : 32);
      }
    }
    ship(164, 274, false); ship(278, 204, true); ship(472, 299, false);
    // 将连续色段合并：一个元素绘制一种长度的全部色段，而非逐像素 DOM。
    const runs = new Map();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W;) {
        const color = pixels[y * W + x];
        if (!color) { x++; continue; }
        const start = x;
        while (x < W && pixels[y * W + x] === color) x++;
        const length = x - start;
        if (!runs.has(length)) runs.set(length, []);
        runs.get(length).push(start + 'em ' + y + 'em ' + COLORS[color]);
      }
    }
    const art = document.createElement('div');
    art.className = 'vm-art'; art.setAttribute('aria-hidden', 'true');
    runs.forEach(function (shadows, length) {
      const ink = document.createElement('span'); ink.className = 'vm-ink';
      ink.style.width = length + 'em'; ink.style.boxShadow = shadows.join(',');
      art.appendChild(ink);
    });
    const atmosphere = document.createElement('span'); atmosphere.className = 'vm-atmosphere';
    art.appendChild(atmosphere);
    return art;
  }
  window.VoyageMap = {
    create: function () {
      if (!template) template = build();
      return template.cloneNode(true);
    }
  };
}());
