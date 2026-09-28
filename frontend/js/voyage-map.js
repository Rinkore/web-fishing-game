/* 连续的 CSS 像素世界图。960×480 逻辑网格，色调与海岸颗粒参考 assets/worldmap.png 旧草稿，按同宽色段合并为 box-shadow。
   无位图、canvas 或 SVG；固定种子只影响装饰，不参与游戏随机数。
   地貌构建一次并缓存，钓点继续由 UI 按百分比独立定位。 */
(function () {
  'use strict';
  const W = 960, H = 480;
  const COLORS = [
    '', '#103753', '#164161', '#1b4868', '#285574', '#376981', '#4b7784',
    '#638a8e', '#819b98', '#a0afa1', '#c1c4af', '#7b8777',
    '#90795d', '#a58d6e', '#bda783', '#ceb994', '#6a6549',
    '#343f2d', '#414b32', '#4c5739', '#596441', '#66704b', '#737b53',
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
    // 水下沙脊随群岛铺开，先画浅滩再叠海岸，避免覆盖既有岛屿。
    [[586, 126, 55, 22], [752, 219, 57, 39], [889, 367, 43, 28]].forEach(function (shoal) {
      const [cx, cy, rx, ry] = shoal;
      for (let y = cy - ry; y <= cy + ry; y++) {
        for (let x = cx - rx; x <= cx + rx; x++) {
          const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          const ripple = Math.sin(x * .17 + y * .3 + noise(x, y, 12) * 3);
          if (d < .9 && ripple > .65 && hash(x, y) > .28) put(x, y, d < .5 ? 5 : 4);
        }
      }
    });
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
    // Follow the old draft's broken foam and warm sand grain rather than a
    // single sharp coast outline. Work from a snapshot so new foam cannot
    // spread into the next pixel as the scan advances.
    const beforeShore = pixels.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, c = beforeShore[i], fleck = hash(x + 911, y + 277);
      if (c >= 1 && c <= 8) {
        const neighbors = [beforeShore[i - 1], beforeShore[i + 1], beforeShore[i - W], beforeShore[i + W]];
        if (neighbors.some(v => v >= 12 && v <= 22) && fleck > .24) put(x, y, fleck > .76 ? 10 : 9);
      } else if (c >= 12 && c <= 15) {
        if (fleck > .9) put(x, y, Math.min(15, c + 1));
        else if (fleck < .08) put(x, y, Math.max(12, c - 1));
      } else if (c >= 17 && c <= 22 && fleck > .94) put(x, y, Math.min(22, c + 1));
    }
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
      ellipse(x + 4, y + 3, 5, 1, 29);
      rect(x, y - 3, 7, 5, 40); rect(x + 5, y - 3, 2, 5, 39);
      for (let row = 0; row < 4; row++) rect(x - 1 + Math.floor(row / 2), y - 5 + row, 9 - row, 1, row % 2 ? 43 : 44);
      rect(x + 5, y - 7, 1, 3, 34); put(x + 5, y - 7, 36);
      line(x, y - 5, x + 6, y - 5, 45);
      rect(x + 2, y, 2, 3, 38); put(x + 5, y - 1, 46);
    }
    // 湖畔小径与村港共用房屋、码头构件，延续游戏的细像素风格。
    line(310, 225, 294, 277, 13); line(294, 277, 325, 322, 13); line(325, 322, 373, 369, 13);
    [[304, 225, 289, 221], [299, 260, 278, 270], [310, 300, 287, 301],
      [342, 339, 351, 355], [366, 363, 383, 365]].forEach(p => line(...p, 13));
    // 菜畦与围栏放在聚落的空地上，保留湖岸、河面与钓点的视野。
    function field(x, y, w, h) {
      rect(x, y, w, h, 39); line(x, y + h, x + w, y + h, 16);
      for (let row = 2; row < h - 1; row += 3) {
        line(x + 1, y + row, x + w - 2, y + row, 40);
        for (let col = 2; col < w - 1; col += 3) {
          put(x + col, y + row - 1, 26); put(x + col + 1, y + row - 1, 22);
        }
      }
      line(x - 2, y - 2, x + w, y - 2, 31);
      line(x - 2, y - 2, x - 2, y + h, 31);
      for (let col = -2; col <= w; col += 4) rect(x + col, y - 4, 1, 4, 41);
      for (let row = 2; row <= h; row += 4) rect(x - 2, y + row - 2, 1, 4, 41);
    }
    field(279, 212, 13, 9); field(280, 290, 17, 10); field(332, 341, 13, 8);
    // 旧石桥接上西岸小径，桥下留出河水和拱洞的暗部。
    rect(302, 237, 8, 13, 34); rect(304, 236, 4, 15, 32);
    line(302, 237, 302, 249, 37); line(309, 237, 309, 249, 35);
    for (let y = 238; y < 250; y += 4) line(304, y, 307, y, 31);
    rect(309, 240, 2, 5, 43); rect(310, 241, 1, 3, 1);
    [[302, 236], [309, 236], [302, 249], [309, 249]].forEach(function (p) {
      rect(p[0], p[1], 1, 3, 35); put(p[0], p[1], 37);
    });
    [[298, 221], [306, 234], [287, 270], [345, 355], [359, 365], [374, 357], [382, 370]].forEach(p => house(...p));
    function dock(x, y, vertical) {
      for (let n = 0; n < 23; n++) rect(x + (vertical ? 0 : n), y + (vertical ? n : 0), vertical ? 5 : 1, vertical ? 1 : 5, n % 3 ? 41 : 39);
    }
    dock(307, 224, false); dock(373, 373, true);
    function crate(x, y) {
      rect(x, y, 4, 4, 39); rect(x, y, 3, 3, 41);
      line(x, y, x + 2, y + 2, 14); put(x + 2, y, 38); put(x, y + 2, 38);
    }
    [[309, 221], [314, 220], [367, 375], [365, 380], [380, 374]].forEach(p => crate(...p));
    [[297, 226], [378, 363]].forEach(function (p) {
      const [x, y] = p;
      rect(x, y, 7, 4, 43);
      for (let col = 0; col < 7; col += 2) line(x + col, y, x + col, y + 3, 31);
      line(x, y + 1, x + 6, y + 1, 32); line(x, y + 3, x + 6, y + 3, 32);
      rect(x - 1, y - 2, 1, 6, 39); rect(x + 7, y - 2, 1, 6, 39);
    });
    [[319, 224], [327, 224], [373, 380], [373, 390]].forEach(function (p) {
      rect(p[0], p[1] - 1, 1, 3, 38); put(p[0], p[1] - 1, 46);
    });
    rect(184, 91, 5, 18, 32); rect(187, 91, 2, 18, 30);
    rect(182, 87, 9, 4, 45); rect(185, 88, 3, 2, 47);
    line(181, 86, 192, 86, 43); line(184, 83, 189, 83, 43);
    // 芦苇沿浅湾边缘生长，沉船斜卧西南礁群。
    for (let i = 0; i < 36; i++) { const x = 320 + random() * 40, y = 274 + random() * 5; line(x, y, x - 1, y - 4 - random() * 4, 22); }
    // 睡莲只落在近岸浅水；碎石、灌木按小簇排列，避免铺满水面。
    [[325, 204], [328, 208], [331, 205], [399, 243], [403, 241], [335, 269], [340, 270]].forEach(function (p, index) {
      ellipse(p[0], p[1] + 1, 2, 1, 5); line(p[0] - 1, p[1], p[0] + 1, p[1], 26);
      put(p[0], p[1] - 1, 27); put(p[0] + 1, p[1], 6);
      if (index % 3 === 0) put(p[0] - 1, p[1] - 1, 46);
    });
    [[316, 204], [318, 200], [320, 198], [409, 245], [407, 249], [404, 252],
      [365, 270], [366, 273], [401, 130], [404, 128]].forEach(function (p, index) {
      ellipse(p[0], p[1], index % 3 ? 1 : 2, 1, 34); put(p[0] - 1, p[1] - 1, 36);
    });
    [[312, 205], [408, 252], [370, 273], [396, 127]].forEach(function (p) {
      ellipse(p[0], p[1], 3, 2, 24); ellipse(p[0] - 1, p[1] - 1, 2, 1, 27);
    });
    [[315, 76, 323, 79], [323, 79, 329, 76], [329, 76, 338, 78],
      [329, 76, 331, 71], [338, 82, 344, 84], [344, 84, 350, 81]].forEach(p => line(...p, 8));
    line(317, 75, 322, 77, 10); line(338, 81, 342, 82, 10);
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
    // 海上细节也烘入同一份静态地形；不增加计时器或逐物件 DOM。
    function water(x, y) {
      const c = pixels[Math.round(y) * W + Math.round(x)];
      return c <= 8;
    }
    function waterline(x0, y0, x1, y1, c) {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= steps; i++) {
        const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
        if (water(x, y)) put(x, y, c);
      }
    }
    // 弧形涌浪与礁湖水纹保留间隙，让海面有方向而非均匀噪点。
    [[120, 181, 26], [168, 207, 18], [94, 395, 22], [550, 224, 26],
      [678, 278, 23], [724, 367, 21], [858, 416, 25], [576, 87, 17]].forEach(function (swell) {
      const [cx, cy, width] = swell;
      for (let row = 0; row < 3; row++) {
        for (let x = -width + row * 4; x < width - row * 4; x++) {
          const y = cy + row * 5 + Math.round(x * x / (width * 7));
          if ((x + width + row * 3) % 17 < 12 && water(cx + x, y)) put(cx + x, y, row ? 4 : 6);
        }
      }
    });
    // 珊瑚、海草与潮池只落在岛外浅水，保持海岸轮廓完整。
    [[606, 143], [649, 138], [716, 208], [774, 232], [782, 262], [878, 393]].forEach(function (reef) {
      for (let i = 0; i < 7; i++) {
        const x = reef[0] + i * 3, y = reef[1] + Math.round(Math.sin(i * 1.8) * 3);
        if (!water(x, y)) continue;
        waterline(x, y, x - 1, y - 4, 6);
        waterline(x - 1, y - 2, x - 3, y - 3, 7);
        waterline(x, y - 1, x + 2, y - 3, 5);
        waterline(x - 2, y + 2, x + 3, y + 2, 4);
      }
    });
    function buoy(x, y) {
      ellipse(x + 1, y + 2, 4, 1, 5);
      rect(x - 1, y - 2, 3, 3, 40); put(x, y - 2, 47);
      line(x, y - 6, x, y - 3, 38); line(x, y - 6, x + 2, y - 5, 42);
      line(x - 3, y + 3, x, y + 3, 8);
    }
    [[365, 405], [393, 393], [445, 381], [503, 365], [584, 344], [687, 319], [809, 282]]
      .forEach(p => buoy(...p));
    // 船尾两道渐细的水痕，港外另有两只低矮的小渔舟。
    [[471, 389, -1], [627, 331, 1], [823, 329, -1]].forEach(function (boat) {
      const [x, y, direction] = boat;
      for (let i = 0; i < 3; i++) {
        const start = x + direction * (9 + i * 8), end = start + direction * (5 - i);
        waterline(start, y + 2 + i, end, y + 3 + i, i ? 4 : 7);
        waterline(start, y - 1 - i, end, y - 2 - i, 5);
      }
    });
    [[407, 385], [594, 160]].forEach(function (boat) {
      const [x, y] = boat;
      ellipse(x, y + 2, 7, 2, 5);
      line(x - 5, y, x + 5, y, 41); line(x - 3, y + 1, x + 3, y + 1, 38);
      rect(x - 2, y - 1, 4, 1, 32); line(x, y - 3, x + 3, y + 3, 40);
    });
    // 鱼群用低对比剪影，飞鸟用两折短翅，避免误认作可点击的钓点。
    [[80, 242], [224, 358], [535, 183], [667, 86], [710, 397], [851, 296]].forEach(function (school) {
      for (let i = 0; i < 6; i++) {
        const x = school[0] + i * 5, y = school[1] + (i % 3) * 4;
        if (!water(x, y)) continue;
        waterline(x - 2, y, x + 1, y, 2);
        waterline(x + 2, y - 1, x + 2, y + 1, 3);
        if (i % 2 === 0) waterline(x - 3, y - 3, x, y - 3, 5);
      }
    });
    [[172, 78], [179, 82], [166, 84], [429, 355], [438, 351], [449, 356],
      [619, 152], [630, 155], [778, 306], [787, 302]].forEach(function (bird) {
      const [x, y] = bird;
      line(x - 3, y - 1, x, y + 1, 9); line(x, y + 1, x + 3, y - 1, 9);
      put(x - 3, y - 2, 10); put(x + 3, y - 2, 10);
    });
    // 远海鲸背露出一角，尺度与帆船保持一致。
    ellipse(852, 96, 9, 3, 2); ellipse(849, 94, 5, 1, 5);
    line(858, 96, 864, 98, 2); line(864, 98, 867, 95, 2); line(864, 98, 868, 100, 2);
    line(846, 92, 845, 89, 7); line(845, 89, 842, 88, 6); line(845, 89, 847, 87, 6);
    waterline(843, 101, 854, 101, 5);
    // 群岛上的旧瞭望台与小渔棚为远洋提供可辨认的地标。
    rect(744, 167, 7, 12, 33); rect(744, 167, 3, 12, 35);
    rect(743, 166, 9, 2, 36); rect(743, 163, 2, 3, 35); rect(747, 164, 2, 2, 35); rect(750, 163, 2, 3, 34);
    rect(747, 173, 2, 4, 29); put(745, 169, 37);
    house(610, 119); dock(616, 129, true);
    house(893, 353); house(900, 359);
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
