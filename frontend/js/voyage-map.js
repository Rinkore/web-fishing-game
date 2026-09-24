/* 连续的 CSS 像素世界图。960×480 逻辑网格，按同宽色段合并为 box-shadow。
   无位图、canvas 或 SVG；固定种子只影响装饰，不参与游戏随机数。
   地貌构建一次并缓存，钓点继续由 UI 按百分比独立定位。 */
(function () {
  'use strict';
  const W = 960, H = 480;
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
    // 西侧大陆包含高山、湖泊和河口，沿南岸出港即可抵达东侧群岛。
    // 第五个参数为岩质岛；历史地图坐标通过 project 投影，服务端数据不变。
    const islands = [
      [345, 84, 122, 112, 0], [369, 226, 112, 137, 0], [315, 315, 84, 48, 0],
      [375, 366, 44, 30, 0], [188, 105, 24, 17, 0], [165, 124, 8, 6, 1],
      [88, 305, 20, 11, 1], [119, 325, 7, 5, 1], [214, 401, 18, 12, 0],
      [509, 324, 27, 17, 0], [541, 309, 13, 9, 1], [565, 295, 6, 4, 1],
      [613, 116, 30, 16, 0], [640, 128, 15, 9, 0], [586, 137, 8, 5, 1],
      [721, 192, 16, 11, 0], [747, 177, 20, 10, 0], [780, 183, 10, 7, 1],
      [792, 218, 7, 10, 1], [770, 249, 15, 8, 0], [733, 254, 9, 6, 1],
      [708, 229, 7, 5, 1], [896, 358, 22, 14, 0], [870, 377, 11, 8, 1],
      [909, 331, 6, 5, 1], [813, 63, 8, 5, 1], [661, 401, 8, 5, 1]
    ];
    // 细小、成簇的短水纹，跟随近岸图的海蓝配色。
    for (let i = 0; i < 10500; i++) {
      const x = Math.floor(random() * W), y = Math.floor(random() * H);
      const c = random() < .09 ? 5 : 2 + Math.floor(random() * 3);
      if (noise(x, y, 22) > .3) line(x, y, x + Math.floor(random() * 3), y, c);
    }
    // 深海裂谷藏于水下，以低对比海底等深层表达，不画成地表黑色裂缝。
    for (let y = 54; y < 262; y++) {
      const t = (y - 54) / 208;
      const cx = 887 - t * 66 + Math.sin(t * 9) * 6;
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
          // 合并大陆地块时保留已经绘制的内陆，避免沿交界重复描海岸。
          const old = pixels[y * W + x];
          if (c && !(old >= 12 && old <= 22 && c < 12)) put(x, y, c);
        }
      }
    });
    // 湖心、芦苇浅湾、落瀑潭与出海河道，水面和陆地使用同一像素网格。
    function lake(cx, cy, rx, ry, frozen) {
      for (let y = Math.floor(cy - ry - 5); y <= cy + ry + 5; y++) {
        for (let x = Math.floor(cx - rx - 5); x <= cx + rx + 5; x++) {
          const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + (noise(x, y, 9) - .5) * .13;
          if (d < 1.1) put(x, y, d > .96 ? 9 : frozen ? (hash(x, y) > .7 ? 10 : 9) : d > .8 ? 6 : (hash(x, y) > .94 ? 4 : 3));
        }
      }
    }
    lake(366, 219, 51, 47, false); lake(343, 259, 23, 17, false);
    lake(410, 144, 19, 16, false); lake(332, 78, 26, 14, true);
    function river(points, width) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        for (let n = 0; n <= steps; n++) {
          const x = a[0] + (b[0] - a[0]) * n / steps, y = a[1] + (b[1] - a[1]) * n / steps;
          ellipse(x, y, width + 2, width + 1, 7); ellipse(x, y, width, width - 1, 4);
        }
      }
    }
    river([[409, 157], [402, 174], [386, 179], [379, 194]], 4);
    river([[322, 238], [302, 243], [290, 230], [275, 232], [254, 244], [232, 247]], 6);
    for (let y = 158; y < 172; y++) { line(404, y, 411, y, y % 3 ? 10 : 47); }
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
    land.forEach(function (p) {
      const c = pixels[p[1] * W + p[0]];
      if (c >= 17 && c <= 22 && random() > .86) tree(p[0], p[1], 5 + Math.floor(random() * 7));
    });
    function mountain(cx, cy, height) {
      for (let y = 0; y < height; y++) {
        const half = Math.floor(y * .72 + Math.sin(y * .7) * 1.4);
        for (let x = -half; x <= half; x++) {
          const snow = y < height * .3 + Math.sin(x * .8) * 3;
          const ridge = x < Math.sin(y * .35) * 3;
          const speck = hash(cx + x, cy + y);
          put(cx + x, cy - height + y, snow ? (ridge ? 47 : 10) : (ridge ? 35 : 33) + (speck > .75 ? 1 : 0));
        }
      }
    }
    [[278, 70, 38], [309, 55, 42], [360, 57, 49], [395, 80, 43], [431, 110, 38], [450, 132, 31]]
      .forEach(p => mountain(...p));
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
    [[134, 331, 4], [154, 319, 3], [529, 332, 4], [567, 298, 3], [697, 226, 4],
      [769, 171, 3], [804, 212, 3], [779, 259, 4], [883, 352, 4]].forEach(p => rock(...p));
    function house(x, y) {
      rect(x, y - 3, 7, 5, 40); rect(x + 5, y - 3, 2, 5, 39);
      for (let row = 0; row < 4; row++) rect(x - 1 + Math.floor(row / 2), y - 5 + row, 9 - row, 1, row % 2 ? 43 : 44);
      rect(x + 2, y, 2, 3, 38); put(x + 5, y - 1, 46);
    }
    // 湖畔小径与村港共用房屋、码头构件，延续游戏的细像素风格。
    line(310, 225, 294, 277, 13); line(294, 277, 325, 322, 13); line(325, 322, 373, 369, 13);
    [[298, 221], [306, 234], [287, 270], [345, 355], [359, 365], [374, 357], [382, 370]].forEach(p => house(...p));
    function dock(x, y, vertical) {
      for (let n = 0; n < 23; n++) rect(x + (vertical ? 0 : n), y + (vertical ? n : 0), vertical ? 5 : 1, vertical ? 1 : 5, n % 3 ? 41 : 39);
    }
    dock(307, 224, false); dock(373, 373, true);
    rect(184, 91, 5, 18, 32); rect(187, 91, 2, 18, 30);
    rect(182, 87, 9, 4, 45); rect(185, 88, 3, 2, 47);
    line(181, 86, 192, 86, 43); line(184, 83, 189, 83, 43);
    // 芦苇沿浅湾边缘生长，沉船斜卧西南礁群。
    for (let i = 0; i < 36; i++) { const x = 320 + random() * 40, y = 274 + random() * 5; line(x, y, x - 1, y - 4 - random() * 4, 22); }
    for (let i = 0; i < 18; i++) line(103 + i, 337 + i / 4, 104 + i, 342 + i / 4, i % 3 ? 39 : 41);
    line(110, 337, 117, 327, 40);
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
    ship(471, 389, false); ship(627, 331, true); ship(823, 329, false);
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
    [['雾松大陆', 33, 32], ['西风海', 11, 45], ['潮汐群岛', 65, 39], ['无尽远洋', 85, 57]].forEach(function (entry) {
      const label = document.createElement('span'); label.className = 'vm-region'; label.textContent = entry[0];
      label.style.left = entry[1] + '%'; label.style.top = entry[2] + '%'; art.appendChild(label);
    });
    const compass = document.createElement('span'); compass.className = 'vm-compass'; compass.textContent = 'N'; art.appendChild(compass);
    return art;
  }
  window.VoyageMap = {
    project: function (pos, voyage) { return [(voyage ? 53 : 5) + pos[0] * (voyage ? .42 : .46), 8 + pos[1] * .84]; },
    unproject: function (pos, voyage) { return [Math.max(0, Math.min(100, (pos[0] - (voyage ? 53 : 5)) / (voyage ? .42 : .46))), Math.max(0, Math.min(100, (pos[1] - 8) / .84))]; },
    create: function () {
      if (!template) template = build();
      return template.cloneNode(true);
    }
  };
}());
