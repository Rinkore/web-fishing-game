/* 渔屋鱼类繁育：参考图表型、二倍体显隐性基因、开放谱系。 */
(function () {
  'use strict';

  var catalog = null;
  var catalogPromise = null;
  var view = null;
  var root = null;
  var mountID = 0;
  var busy = false;
  var notice = '';
  var selectedA = '';
  var selectedB = '';
  var inspected = '';
  var pendingCommand = null;
  var selectedItem = '';
  var selectedColor = 'crimson';
  var selectedHabitat = '';
  var habitatTab = 'aquarium';
  var mode = 'workbench';
  var selectedTransfer = '';
  var refreshTimer = null;
  var loading = false;
  var dataEpoch = 0;
  var artImages = new Map();
  var artComposites = new Map();

  var SIZE_NAME = { normal: '普通体型', large: '大型', giant: '巨型' };
  var MUTATION_ORDER = ['albino', 'star', 'veil', 'glow'];
  var COLOR_ORDER = ['crimson', 'golden', 'azure', 'melanic', 'opal'];
  var ORNAMENT_ORDER = ['goldscale', 'moonlight'];
  var HABITAT_NAMES = { aquarium: '观赏鱼缸', freshwater: '淡水养殖场', marine: '海水养殖场' };
  var REAGENTS = [['gene_albino', '白化'], ['gene_star', '星点'], ['gene_veil', '流纱'], ['gene_glow', '荧光'], ['gene_prism', '异色']];
  var LAYER_ORDER = ['skin', 'head', 'dorsal', 'ventral', 'tail'];
  var BLEND_RULES = {
    skin: { feather: 5, strength: .76, colourMatch: .55 },
    head: { feather: 4, strength: .91, colourMatch: .28 },
    dorsal: { feather: 3, strength: .87, colourMatch: .38 },
    ventral: { feather: 3, strength: .87, colourMatch: .38 },
    tail: { feather: 4, strength: .83, colourMatch: .42 },
  };
  var ERROR_TEXT = {
    breeding_parent_not_found: '找不到这条亲本，它可能已经不属于你。',
    breeding_already_released: '这条鱼已经离池。',
    breeding_capacity: '工作台已满，请先放流亲鱼或转入挂机设施。',
    breeding_parent_in_habitat: '挂机设施中的鱼不能手动配对，请先取回工作台。',
    breeding_invalid_founder: '这条背包鱼不能作为亲代。',
    breeding_incompatible: '仅同种鱼、现实杂交白名单或黄金锦鲤与月光鲤可以配对。',
    breeding_habitat_not_found: '这处养殖设施不存在或不属于你。',
    breeding_wrong_habitat: '鱼缸只接收普通体型的淡水观赏鱼；淡水鱼与海水鱼需放入对应养殖场。',
    breeding_habitat_full: '这处设施已经满员，请先移出一条鱼。',
    breeding_habitat_limit: '每类养殖设施最多建造两处。',
    insufficient_funds: '金币不足。',
    insufficient_items: '背包里的亲代鱼或定向试剂数量不足。',
    feature_disabled: '管理员暂时关闭了鱼类繁育。',
    invalid_request_key: '请求标识无效，请刷新后重试。',
    request_key_conflict: '这次操作与上次重试内容不一致，请刷新后再试。',
    unavailable: '服务暂时不可用；再次点击会沿用同一请求，不会重复扣除。',
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function species(id) {
    return (catalog && catalog.species && catalog.species[id]) || { id: id, name: id, notes: '', breedGroup: id, breedNote: '仅允许同种繁育' };
  }

  function alleleName(locus, id) {
    if (locus === 'size') return SIZE_NAME[id] || id;
    if (catalog && catalog.species && catalog.species[id]) return catalog.species[id].name;
    return id;
  }

  function individual(id) {
    return (view && view.fish || []).find(function (fish) { return fish.id === id; }) || null;
  }

  function activeFish() {
    return (view && view.fish || []).filter(function (fish) { return fish.active; });
  }

  function compatible(a, b) {
    if (!a || !b || a.id === b.id) return false;
    var sa = species(a.species), sb = species(b.species);
    if (a.species === b.species) return true;
    if (catalog && Array.isArray(catalog.pairs)) return catalog.pairs.some(function (pair) { return pair[0] === a.species && pair[1] === b.species || pair[1] === a.species && pair[0] === b.species; });
    return sa.group === sb.group && sa.breedGroup && sa.breedGroup === sb.breedGroup;
  }

  function workbenchFish() {
    return activeFish().filter(function (fish) { return !fish.habitatId; });
  }

  function habitat(id) { return (view && view.habitats || []).find(function (h) { return h.id === id; }); }
  function canHouse(kind, id, size) {
    var info = species(id);
    if (kind === 'aquarium') return info.habitat === 'freshwater' && info.ornamental && size === 'normal';
    return kind === 'freshwater' ? info.habitat === 'freshwater' : kind === 'marine' && info.habitat === 'marine';
  }
  function habitatDescription(kind) {
    return kind === 'aquarium' ? '普通体型淡水观赏鱼 · 大型、巨型请放淡水场' : kind === 'freshwater' ? '淡水鱼 · 可混养不同鱼种' : '海水鱼 · 可混养不同鱼种';
  }

  function artImage(src) {
    if (!artImages.has(src)) {
      artImages.set(src, new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('fish art unavailable')); };
        img.src = src;
      }).catch(function (err) { artImages.delete(src); throw err; }));
    }
    return artImages.get(src);
  }

  function artBounds(info, locus) {
    var box = info && info.bounds && info.bounds[locus];
    return Array.isArray(box) && box.length === 4 && box[2] > box[0] && box[3] > box[1] ? box : null;
  }

  function softenOverlay(overlay, bodyPixels, radius, strength, colourMatch) {
    var ctx = overlay.getContext('2d', { willReadFrequently: true });
    var width = overlay.width, height = overlay.height;
    var image = ctx.getImageData(0, 0, width, height);
    var pixels = image.data, distances = new Uint8Array(width * height);
    var x, y, i, d;
    var donorTotals = [0, 0, 0], bodyTotals = [0, 0, 0], samples = 0;
    // Distance to the nearest transparent pixel: the transferred feature
    // fades into the body at its real outline, not only at a rectangular crop.
    for (i = 0; i < distances.length; i++) {
      if (pixels[i * 4 + 3] && bodyPixels[i * 4 + 3]) {
        distances[i] = 255;
        if (pixels[i * 4 + 3] >= 128 && bodyPixels[i * 4 + 3] >= 128) {
          for (var channel = 0; channel < 3; channel++) {
            donorTotals[channel] += pixels[i * 4 + channel];
            bodyTotals[channel] += bodyPixels[i * 4 + channel];
          }
          samples++;
        }
      }
    }
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        i = y * width + x;
        if (!distances[i]) continue;
        d = distances[i];
        if (x) d = Math.min(d, distances[i - 1] + 1);
        if (y) d = Math.min(d, distances[i - width] + 1);
        if (x && y) d = Math.min(d, distances[i - width - 1] + 1);
        if (x + 1 < width && y) d = Math.min(d, distances[i - width + 1] + 1);
        distances[i] = d;
      }
    }
    for (y = height - 1; y >= 0; y--) {
      for (x = width - 1; x >= 0; x--) {
        i = y * width + x;
        if (!distances[i]) continue;
        d = distances[i];
        if (x + 1 < width) d = Math.min(d, distances[i + 1] + 1);
        if (y + 1 < height) d = Math.min(d, distances[i + width] + 1);
        if (x + 1 < width && y + 1 < height) d = Math.min(d, distances[i + width + 1] + 1);
        if (x && y + 1 < height) d = Math.min(d, distances[i + width - 1] + 1);
        distances[i] = d;
      }
    }
    var shift = donorTotals.map(function (sum, channel) {
      return samples ? (bodyTotals[channel] - sum) / samples * colourMatch : 0;
    });
    for (i = 0; i < distances.length; i++) {
      if (!distances[i]) { pixels[i * 4 + 3] = 0; continue; }
      // Match the donor's average palette to the receiving region while
      // preserving its dark markings and internal texture.
      var lightness = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 765;
      for (var colour = 0; colour < 3; colour++) {
        pixels[i * 4 + colour] = Math.max(0, Math.min(255,
          Math.round(pixels[i * 4 + colour] + shift[colour] * (.4 + .6 * lightness))));
      }
      var progress = Math.min(1, distances[i] / (radius + 1));
      var fade = Math.max(.22, progress * progress * (3 - 2 * progress));
      pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3] * strength * fade * bodyPixels[i * 4 + 3] / 255);
    }
    ctx.putImageData(image, 0, 0);
  }

  async function applyColorGenes(canvas, colors) {
    var active = COLOR_ORDER.filter(function (locus) { return colors && colors[locus]; });
    if (!active.length) return;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height), pixels = image.data;
    var tones = { crimson: [205, 70, 97], golden: [233, 181, 69], azure: [73, 166, 211] };
    var hue = active.filter(function (locus) { return tones[locus]; });
    for (var y = 0; y < canvas.height; y++) for (var x = 0; x < canvas.width; x++) {
      var i = (y * canvas.width + x) * 4;
      if (!pixels[i + 3]) continue;
      var light = (pixels[i] * .3 + pixels[i + 1] * .59 + pixels[i + 2] * .11) / 150;
      if (hue.length) {
        for (var channel = 0; channel < 3; channel++) {
          var target = hue.reduce(function (sum, locus) { return sum + tones[locus][channel]; }, 0) / hue.length;
          pixels[i + channel] = Math.max(0, Math.min(255, Math.round(pixels[i + channel] * .42 + target * light * .58)));
        }
      }
      if (colors.melanic) for (var dark = 0; dark < 3; dark++) pixels[i + dark] = Math.round(pixels[i + dark] * .58);
      if (colors.opal) {
        var sheen = Math.sin((x + y * .7) * .27) * 15;
        pixels[i] = Math.max(0, Math.min(255, pixels[i] + sheen));
        pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + 10 - sheen * .3));
        pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + 19 - sheen));
      }
    }
    ctx.putImageData(image, 0, 0);
    // Small Go-generated pattern tiles add discrete pixel texture without
    // changing the fish silhouette or blurring its reference-derived detail.
    for (var j = 0; j < active.length; j++) {
      var tile = await artImage('assets/genetics/pattern-' + active[j] + '.png');
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = .5;
      ctx.fillStyle = ctx.createPattern(tile, 'repeat');
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }

  function applyOrnaments(canvas, phenotype) {
    var skin = phenotype.traits && phenotype.traits.skin && phenotype.traits.skin.source || phenotype.body;
    var active = ORNAMENT_ORDER.filter(function (locus) { return phenotype.ornaments && phenotype.ornaments[locus] && catalog.ornaments && catalog.ornaments[locus] && catalog.ornaments[locus].reference !== skin; });
    var suppressed = ORNAMENT_ORDER.some(function (locus) { return phenotype.ornaments && phenotype.ornaments[locus] === false && catalog.ornaments && catalog.ornaments[locus] && catalog.ornaments[locus].reference === skin; });
    if (!active.length && !suppressed) return;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height), data = image.data;
    for (var y = 0; y < canvas.height; y++) for (var x = 0; x < canvas.width; x++) {
      var i = (y * canvas.width + x) * 4;
      if (!data[i + 3]) continue;
      var light = data[i] * .3 + data[i + 1] * .59 + data[i + 2] * .11;
      if (light < 38) continue;
      // Remove native gold/cold-white colour when its locus is not expressed.
      // Keep the reference silhouette, scales, shading and dark eye pixels.
      if (suppressed) data[i] = data[i + 1] = data[i + 2] = Math.min(190, light * .78 + 12);
      if (active.indexOf('goldscale') >= 0) {
        data[i] = Math.min(255, data[i] * .58 + light * .65);
        data[i + 1] = Math.min(255, data[i + 1] * .58 + light * .48);
        data[i + 2] = Math.min(255, data[i + 2] * .58 + light * .18);
        if ((x * 3 + y * 5) % 23 === 1) { data[i] = 255; data[i + 1] = 223; data[i + 2] = 129; }
      }
      if (active.indexOf('moonlight') >= 0) {
        var spot = (Math.floor(x / 7) + Math.floor(y / 5) * 3) % 7 === 0;
        data[i] = data[i] * .42 + (spot ? 107 : 227) * .58;
        data[i + 1] = data[i + 1] * .42 + (spot ? 167 : 235) * .58;
        data[i + 2] = data[i + 2] * .42 + 249 * .58;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  function composedArt(phenotype) {
    var body = phenotype.body;
    var bodyInfo = species(body);
    var sources = LAYER_ORDER.map(function (locus) {
      var trait = phenotype.traits && phenotype.traits[locus];
      return trait && !trait.hidden && trait.source || body;
    });
    var key = JSON.stringify([catalog.version, body, phenotype.colors || {}, phenotype.ornaments || {}].concat(sources));
    if (!artComposites.has(key)) {
      var promise = artImage('assets/fish/' + body + '.png').then(async function (bodyImage) {
        var result = document.createElement('canvas');
        result.width = bodyInfo.width || bodyImage.naturalWidth;
        result.height = bodyInfo.height || bodyImage.naturalHeight;
        var ctx = result.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bodyImage, 0, 0);
        var bodyPixels = ctx.getImageData(0, 0, result.width, result.height).data;
        for (var j = 0; j < LAYER_ORDER.length; j++) {
          var locus = LAYER_ORDER[j], source = sources[j];
          if (source === body) continue;
          var donorInfo = species(source);
          var target = artBounds(bodyInfo, locus), donor = artBounds(donorInfo, locus);
          if (!target || !donor) continue;
          var donorImage = await artImage('assets/genetics/' + source + '-' + locus + '.png');
          var overlay = document.createElement('canvas');
          overlay.width = result.width;
          overlay.height = result.height;
          var layer = overlay.getContext('2d', { willReadFrequently: true });
          layer.imageSmoothingEnabled = false;
          layer.drawImage(donorImage, donor[0], donor[1], donor[2] - donor[0], donor[3] - donor[1],
            target[0], target[1], target[2] - target[0], target[3] - target[1]);
          var blend = BLEND_RULES[locus];
          softenOverlay(overlay, bodyPixels, blend.feather, blend.strength, blend.colourMatch);
          ctx.drawImage(overlay, 0, 0);
        }
        applyOrnaments(result, phenotype);
        await applyColorGenes(result, phenotype.colors);
        // The body locus owns the silhouette, including semi-transparent edge
        // pixels. Donor colours may blend inside it but cannot grow new limbs.
        var finished = ctx.getImageData(0, 0, result.width, result.height);
        for (var i = 3; i < finished.data.length; i += 4) finished.data[i] = bodyPixels[i];
        ctx.putImageData(finished, 0, 0);
        return result;
      }).catch(function (err) { artComposites.delete(key); throw err; });
      artComposites.set(key, promise);
    }
    return artComposites.get(key);
  }

  function renderHybrids() {
    root.querySelectorAll('[data-breed-canvas]').forEach(function (canvas) {
      var fish = individual(canvas.dataset.breedCanvas);
      if (!fish || !fish.phenotype) return;
      composedArt(fish.phenotype).then(function (art) {
        if (!canvas.isConnected) return;
        canvas.getContext('2d').drawImage(art, 0, 0);
        canvas.parentElement.classList.add('breed-hybrid-ready');
      }).catch(function () { /* Keep the body sprite as a readable fallback. */ });
    });
  }

  function phenotypeImage(ind) {
    var phenotype = ind.phenotype || {};
    var body = phenotype.body || ind.species;
    var mutation = Object.keys(phenotype.mutations || {}).filter(function (key) { return phenotype.mutations[key]; });
    var colors = COLOR_ORDER.filter(function (key) { return phenotype.colors && phenotype.colors[key]; });
    var ornaments = ORNAMENT_ORDER.filter(function (key) { return phenotype.ornaments && phenotype.ornaments[key]; });
    var classes = ['breed-fish-art', 'breed-size-' + (phenotype.size || 'normal')].concat(mutation.map(function (key) { return 'breed-mut-' + key; }));
    if (phenotype.referenceExact) classes.push('breed-reference-exact');
    ornaments.forEach(function (key) { classes.push('breed-ornament-' + key); });
    // Founders are rendered from the same five lossless layers as descendants,
    // rather than bypassing the genome with the original PNG. fishgen verifies
    // that these layers recompose every visible source pixel exactly.
    var art = phenotype.referenceExact ? LAYER_ORDER.map(function (locus) {
      return '<img class="breed-trait-layer breed-layer-' + locus + '" src="assets/genetics/' + esc(body) + '-' + locus + '.png" alt="">';
    }).join('') : '<img class="breed-hybrid-fallback" src="assets/fish/' + esc(body) + '.png" alt="">' +
      '<canvas class="breed-hybrid-canvas" data-breed-canvas="' + esc(ind.id) + '" width="' + (Number(species(body).width) || 220) +
      '" height="' + (Number(species(body).height) || 130) + '"></canvas>';
    return '<div class="' + classes.join(' ') + '"><span class="sr-only">' + esc(species(body).name) + '</span><div class="breed-fish-stack">' + art + '</div>' +
      (mutation.indexOf('star') >= 0 ? '<span class="breed-mutation-spark" aria-hidden="true">✦ · ✧ · ✦</span>' : '') +
      (colors.length ? '<span class="breed-color-badge" title="表达异色：' + esc(colors.map(function (key) { return catalog.colors[key].label; }).join('、')) + '">异色 ×' + colors.length + '</span>' : '') +
      (phenotype.referenceExact ? '<span class="breed-reference-seal" title="参考图 SHA-256：' + esc(phenotype.referenceSha256 || '') + '">参考图一致</span>' : '') + '</div>';
  }

  function lineage(ind) {
    return ind.parents && ind.parents[0] ? '#' + ind.parents[0] + ' × #' + ind.parents[1] : '参考亲代（G0）';
  }

  function housingControls(ind) {
    var size = ind.phenotype && ind.phenotype.size || 'normal';
    return '<div class="breed-housing"><select data-fish-habitat="' + esc(ind.id) + '" aria-label="选择放养设施">' +
      '<option value="">取回工作台（停止挂机）</option>' + (view.habitats || []).filter(function (h) { return canHouse(h.kind, ind.species, size); }).map(function (h) {
        var full = (h.fishIds || []).length >= h.capacity && ind.habitatId !== h.id;
        return '<option value="' + esc(h.id) + '"' + (ind.habitatId === h.id ? ' selected' : '') + (full ? ' disabled' : '') + '>' + esc(h.name) + ' ' + (h.fishIds || []).length + '/' + h.capacity + '</option>';
      }).join('') + '</select><button type="button" class="mini" data-move-fish="' + esc(ind.id) + '"' + (busy ? ' disabled' : '') + '>确认转移</button></div>';
  }

  function fishCard(ind, slot, automated) {
    if (!ind) return '<button type="button" class="breed-slot empty" data-empty-slot="' + slot + '">从工作台亲鱼中选择亲本 ' + slot + '</button>';
    var phenotype = ind.phenotype || {};
    var selected = (slot === 'A' && selectedA === ind.id) || (slot === 'B' && selectedB === ind.id);
    return '<article class="breed-slot' + (selected ? ' selected' : '') + '" data-fish-id="' + esc(ind.id) + '">' +
      phenotypeImage(ind) + '<div class="breed-card-copy"><b>' + esc(species(ind.species).name) + '</b>' +
      '<span>第 ' + ind.generation + ' 代 · ' + esc(SIZE_NAME[phenotype.size] || phenotype.size) + '</span>' +
      '<small>' + esc(lineage(ind)) + '</small></div>' +
      (slot ? '' : '<div class="breed-card-actions">' + (automated ? '' : '<button type="button" class="mini" data-pick="A" data-id="' + esc(ind.id) + '">设为 A</button><button type="button" class="mini" data-pick="B" data-id="' + esc(ind.id) + '">设为 B</button>') + '<button type="button" class="mini" data-inspect="' + esc(ind.id) + '">基因</button><button type="button" class="mini danger" data-release="' + esc(ind.id) + '">放流</button></div>' + (automated ? housingControls(ind) : '')) + '</article>';
  }

  function geneRows(ind) {
    if (!ind) return '<p class="note">选择一条鱼查看所有基因位点。</p>';
    var phenotype = ind.phenotype || {};
    var order = (catalog.loci || []).concat(['size']).concat(COLOR_ORDER, MUTATION_ORDER, ORNAMENT_ORDER);
    return '<div class="breed-inspect-head">' + phenotypeImage(ind) + '<div><b>' + esc(species(ind.species).name) + ' · 第 ' + ind.generation + ' 代</b><small>参考摘要 ' + esc((ind.referenceSha256 || '').slice(0, 12)) + '…</small></div></div>' +
      '<div class="breed-table-wrap"><table class="breed-genes"><thead><tr><th>性状位点</th><th>两份等位基因</th><th>显隐性 / 表达</th></tr></thead><tbody>' + order.map(function (locus) {
        var trait = phenotype.traits && phenotype.traits[locus];
        if (!trait) return '';
        var label = locus === 'size' ? '体型档位' : (catalog.labels && catalog.labels[locus]) || (catalog.colors && catalog.colors[locus] && catalog.colors[locus].label) || (catalog.mutations && catalog.mutations[locus] && catalog.mutations[locus].label) || (catalog.ornaments && catalog.ornaments[locus] && catalog.ornaments[locus].label) || locus;
        var alleles = (trait.alleles || []).map(function (allele) { return alleleName(locus, allele); });
        var expression = trait.hidden ? '<span class="breed-hidden">潜伏</span>' : '<span class="breed-expressed">表达：' + esc(alleleName(locus, trait.source || trait.winner)) + '</span>';
        var dominance = trait.zygosity === 'homozygous' ? '纯合' : '显性 ' + alleleName(locus, trait.dominant) + ' / 隐性 ' + alleleName(locus, trait.recessive);
        return '<tr><th>' + esc(label) + '</th><td><code>' + esc(alleles.join(' / ')) + '</code></td><td>' + expression + '<small class="breed-mode">' + esc(dominance) + (trait.reason ? '；' + esc(trait.reason) : '') + '</small></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function stockCards(destination) {
    var stock = view.stock || [];
    if (!stock.length) return '<p class="note">背包里没有支持留种的鱼，先去钓鱼获得亲代。</p>';
    return '<div class="breed-stock">' + stock.map(function (item) {
      var source = species(item.species);
      var manual = destination === 'workbench', target = manual ? null : habitat(selectedHabitat);
      var allowed = manual || target && canHouse(target.kind, item.species, item.tier);
      var full = manual ? workbenchFish().length >= view.capacity : target && (target.fishIds || []).length >= target.capacity;
      var label = manual ? '放入工作台' : !target ? '先选择设施' : !allowed ? '环境不符' : full ? '设施已满' : '放入挂机设施';
      return '<article class="breed-stock-card"><img src="assets/fish/' + esc(item.species) + '.png" alt=""><div><b>' + esc(source.name) + '</b><small>' + esc(SIZE_NAME[item.tier] || item.tier) + ' × ' + item.quantity + ' · ' + (source.habitat === 'marine' ? '海水' : '淡水') + (source.ornamental ? '观赏鱼' : '鱼') + '</small><small>' + esc(source.breedNote || '仅允许同种繁育') + '</small></div><button type="button" class="mini go" data-founder="' + esc(item.species) + '" data-tier="' + esc(item.tier) + '" data-destination="' + destination + '"' + (!allowed || full || busy ? ' disabled' : '') + '>' + label + '</button></article>';
    }).join('') + '</div>';
  }

  function habitatControls() {
    var all = view.habitats || [], list = all.filter(function (h) { return h.kind === habitatTab; });
    var caps = view.habitatCapacities || { aquarium: 8, freshwater: 12, marine: 10 };
    var max = view.habitatLimit || 2;
    return '<section class="breed-habitats"><div class="breed-habitat-toolbar"><nav class="breed-habitat-tabs" aria-label="养殖环境">' +
      ['aquarium', 'freshwater', 'marine'].map(function (kind) { return '<button type="button" data-habitat-tab="' + kind + '" class="mini' + (habitatTab === kind ? ' on' : '') + '">' + HABITAT_NAMES[kind] + '</button>'; }).join('') +
      '</nav><button type="button" class="mini go" data-create-habitat="' + habitatTab + '"' + (list.length >= max || busy ? ' disabled' : '') + '>建造' + HABITAT_NAMES[habitatTab] + ' ' + list.length + '/' + max + '</button></div>' +
      '<p class="breed-habitat-rule">' + esc(habitatDescription(habitatTab)) + ' · 每处最多 ' + caps[habitatTab] + ' 条 · 每 ' + Math.round((view.spawnIntervalSeconds || 600) / 60) + ' 分钟自然配对一次 · 不相容鱼种和平共处</p>' +
      '<div class="breed-habitat-grid">' + (list.length ? list.map(function (h) {
        var residents = (h.fishIds || []).map(individual).filter(Boolean);
        var remaining = Math.max(0, Math.ceil((h.nextSpawnAt - Date.now()) / 60000));
        var status = h.status === 'full' ? '满员 · 暂停产生后代' : h.compatiblePairs ? '可配对 ' + h.compatiblePairs + ' 组 · 下一轮约 ' + remaining + ' 分钟' : '没有相容亲鱼 · 可混养，不会乱配';
        return '<article class="breed-habitat-card' + (selectedHabitat === h.id ? ' selected' : '') + '" data-habitat-id="' + esc(h.id) + '"><header><b>' + esc(h.name) + '</b><span>' + residents.length + ' / ' + h.capacity + ' 条</span></header>' +
          '<div class="breed-habitat-scene breed-habitat-' + h.kind + '"><div class="breed-water-glints"></div><div class="breed-residents">' + residents.map(function (f, i) {
            return '<button type="button" class="breed-swimmer" data-inspect="' + esc(f.id) + '" style="--swim-delay:' + (-i * .8) + 's" title="' + esc(species(f.species).name) + ' · 第 ' + f.generation + ' 代">' + phenotypeImage(f) + '</button>';
          }).join('') + '</div>' + (!residents.length ? '<span class="breed-habitat-empty">空置 · 从养殖专用入口放入亲鱼</span>' : '') + '</div>' +
          '<p class="breed-habitat-status">' + esc(status) + '</p><button type="button" class="mini" data-select-habitat="' + esc(h.id) + '">' + (selectedHabitat === h.id ? '当前放养位置' : '设为放养位置') + '</button></article>';
      }).join('') : '<div class="breed-habitat-placeholder">还没有' + HABITAT_NAMES[habitatTab] + '。建造后即可放入亲鱼，服务器会自动完成自然繁育。</div>') + '</div></section>';
  }

  function reagentControls() {
    var counts = view.reagents || {};
    return '<section class="breed-reagents"><div class="sec-h">定向基因试剂 <small>可在此购买；每次繁育最多消耗一瓶，使后代该位点增加一份特殊等位基因，隐性性状仍须成对</small></div>' +
      '<div class="breed-reagent-list"><button type="button" class="breed-reagent' + (!selectedItem ? ' on' : '') + '" data-reagent="">自然遗传</button>' +
      REAGENTS.map(function (entry) {
        var count = Number(counts[entry[0]]) || 0;
        var price = Number(view.reagentPrices && view.reagentPrices[entry[0]]) || 0;
        return '<span class="breed-reagent-entry"><button type="button" class="breed-reagent' + (selectedItem === entry[0] ? ' on' : '') + '" data-reagent="' + entry[0] + '"' + (!count ? ' disabled' : '') + '><img src="assets/item/' + entry[0] + '.png" alt=""><span>' + entry[1] + '<small>×' + count + '</small></span></button><button type="button" class="mini" data-buy-reagent="' + entry[0] + '">购买 ' + price + '💰</button></span>';
      }).join('') + '</div>' +
      (selectedItem === 'gene_prism' ? '<label class="breed-color-target">定向异色位点 <select data-color-target>' + COLOR_ORDER.map(function (locus) {
        var label = catalog.colors && catalog.colors[locus] && catalog.colors[locus].label || locus;
        return '<option value="' + locus + '"' + (selectedColor === locus ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('') + '</select></label>' : '') + '</section>';
  }

  function draw() {
    if (!root) return;
    if (!view || !catalog) {
      root.innerHTML = '<div class="breed-loading">正在读取参考图与基因档案…</div>';
      return;
    }
    var active = activeFish(), manual = workbenchFish(), auto = mode === 'aquaculture';
    if (auto && (!habitat(selectedHabitat) || habitat(selectedHabitat).kind !== habitatTab)) {
      var first = (view.habitats || []).find(function (h) { return h.kind === habitatTab; });
      selectedHabitat = first ? first.id : '';
    }
    var a = individual(selectedA), b = individual(selectedB);
    if (a && (!a.active || a.habitatId)) { selectedA = ''; a = null; }
    if (b && (!b.active || b.habitatId)) { selectedB = ''; b = null; }
    var generation = a && b ? Math.max(a.generation, b.generation) + 1 : null;
    var canBreed = compatible(a, b);
    var pairHint = !a || !b ? '请选择两条不同的在养亲本。' : !compatible(a, b) ? '该组合不在现实可杂交白名单中。' : species(a.species).breedNote;
    var inspect = individual(inspected);
    if (inspect && (!!inspect.habitatId !== auto || !inspect.active)) inspect = null;
    inspect = inspect || (!auto && (a || b));
    root.dataset.mode = mode;
    var modes = '<nav class="breed-mode-tabs" aria-label="繁育玩法"><button type="button" class="mini' + (!auto ? ' on' : '') + '" data-breed-mode="workbench" aria-pressed="' + !auto + '">手动工作台</button><button type="button" class="mini' + (auto ? ' on' : '') + '" data-breed-mode="aquaculture" aria-pressed="' + auto + '">挂机养殖</button></nav>';
    var content = auto ? aquacultureContent(manual) :
      '<div class="breed-mode-note">工作台只手动繁育，不产生挂机收益；这里的鱼与鱼缸、养殖场分别管理。</div><div class="sec-h breed-workbench-title">配对繁育工作台 <small>手动选择亲鱼，可使用定向试剂</small></div>' +
      '<section class="breed-pair"><div><h3>亲本 A</h3>' + fishCard(a, 'A') + '</div><div class="breed-cross">×<small>孟德尔随机分离</small></div><div><h3>亲本 B</h3>' + fishCard(b, 'B') + '</div></section>' +
      '<div class="breed-pair-status ' + (canBreed ? 'ok' : '') + '">' + esc(pairHint || '同种配对') + '</div>' + reagentControls() +
      '<div class="breed-actions"><button type="button" class="mini go" data-breed' + (!canBreed || busy || manual.length >= view.capacity ? ' disabled' : '') + '>繁育第 ' + (generation == null ? '—' : generation) + ' 代后代</button></div>' +
      '<section class="breed-section" data-stock-section="workbench"><div class="sec-h">工作台放鱼 <small>从背包消耗 1 条鱼，只放入手动工作台</small></div>' + stockCards('workbench') + '</section>' +
      '<section class="breed-lower"><div><div class="sec-h">工作台亲鱼 <small>手动后代留在这里，不会自动转入挂机设施</small></div><div class="breed-pool">' + (manual.length ? manual.map(function (fish) { return fishCard(fish, ''); }).join('') : '<p class="note">工作台还没有亲鱼，从上方专用入口放鱼开始。</p>') + '</div></div>';
    root.innerHTML = '<header class="breed-header"><div><span class="gear-eyebrow">手动配对 · 挂机繁育 · 独立放鱼</span><h2>养殖与繁育</h2><p>工作台由你选择亲鱼和试剂；挂机设施自动繁育相容后代，不产金币。两边各自放鱼、各自占用名额。黄金锦鲤与月光鲤可繁育，黄金鳞光显性、月白蓝斑隐性。</p></div><div class="breed-metrics"><span>工作台亲鱼<b>' + manual.length + ' / ' + view.capacity + '</b></span><span>挂机在养<b>' + (active.length - manual.length) + ' / ' + (view.aquacultureCapacity || 60) + '</b></span><span>' + (auto ? '挂机周期<b>每 ' + Math.round((view.spawnIntervalSeconds || 600) / 60) + ' 分钟' : '手动繁育<b>' + view.breedCost + ' 金币') + '</b></span></div></header>' + modes +
      (notice ? '<p class="breed-notice" role="status">' + esc(notice) + '</p>' : '') +
      '<div class="breed-actions"><button type="button" class="mini" data-refresh' + (busy ? ' disabled' : '') + '>刷新档案</button></div>' + content + '<aside class="breed-inspector"><div class="sec-h">完整基因检视</div>' + geneRows(inspect) + '</aside></section>';
    bind();
    renderHybrids();
  }

  function aquacultureContent(manual) {
    var target = habitat(selectedHabitat), full = target && (target.fishIds || []).length >= target.capacity;
    var candidates = manual.filter(function (f) { return target && canHouse(target.kind, f.species, f.phenotype.size); });
    if (!candidates.some(function (f) { return f.id === selectedTransfer; })) selectedTransfer = '';
    var residents = target ? (target.fishIds || []).map(individual).filter(function (f) { return f && f.active; }) : [];
    return '<div class="breed-mode-note">挂机收益为自动繁育的后代，直接留在原设施；满员暂停，不消耗金币或试剂。挂机鱼不能直接参加手动配对。</div>' + habitatControls() +
      '<section class="breed-section" data-stock-section="aquaculture"><div class="sec-h">挂机设施放鱼 <small>从背包放入选定设施，不经过工作台</small></div><label class="breed-stock-target">目标设施 <select data-stock-target><option value="" disabled' + (!target ? ' selected' : '') + '>先建造并选择一处设施</option>' + (view.habitats || []).filter(function (h) { return h.kind === habitatTab; }).map(function (h) { return '<option value="' + esc(h.id) + '"' + (selectedHabitat === h.id ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select></label>' + stockCards('aquaculture') + '</section>' +
      '<section class="breed-section breed-transfer"><div class="sec-h">从工作台转入 <small>需要你确认转移，原鱼不会被复制</small></div><select data-transfer-fish aria-label="选择转入挂机养殖的工作台亲鱼"><option value="">选择一条环境相符的工作台亲鱼</option>' + candidates.map(function (f) { return '<option value="' + esc(f.id) + '"' + (selectedTransfer === f.id ? ' selected' : '') + '>#' + esc(f.id) + ' ' + esc(species(f.species).name) + ' · 第 ' + f.generation + ' 代</option>'; }).join('') + '</select><button type="button" class="mini" data-transfer-to-habitat' + (!selectedTransfer || !target || full || busy ? ' disabled' : '') + '>确认转入挂机</button></section>' +
      '<section class="breed-lower"><div><div class="sec-h">' + esc(target ? target.name : '设施') + '中的鱼 <small>包含挂机繁育所得后代；取回工作台后可手动配对</small></div><div class="breed-pool breed-resident-pool">' + (residents.length ? residents.map(function (f) { return fishCard(f, '', true); }).join('') : '<p class="note">这处设施还没有鱼，请使用上方挂机专用放鱼入口。</p>') + '</div></div>';
  }

  function bind() {
    root.querySelectorAll('[data-breed-mode]').forEach(function (button) { button.onclick = function () { mode = button.dataset.breedMode; inspected = ''; draw(); }; });
    var transfer = root.querySelector('[data-transfer-fish]');
    if (transfer) transfer.onchange = function () { selectedTransfer = transfer.value; draw(); };
    var transferButton = root.querySelector('[data-transfer-to-habitat]');
    if (transferButton) transferButton.onclick = function () { act({ action: 'stock', id: selectedTransfer, habitatId: selectedHabitat }, '已从工作台转入挂机设施，开始自动繁育。'); };
    root.querySelectorAll('[data-habitat-tab]').forEach(function (button) { button.onclick = function () {
      habitatTab = button.dataset.habitatTab;
      var first = (view.habitats || []).find(function (h) { return h.kind === habitatTab; });
      selectedHabitat = first ? first.id : ''; draw();
    }; });
    root.querySelectorAll('[data-create-habitat]').forEach(function (button) { button.onclick = function () { act({ action: 'habitat_create', habitatKind: button.dataset.createHabitat }, '养殖设施已建好。'); }; });
    root.querySelectorAll('[data-select-habitat]').forEach(function (button) { button.onclick = function () { selectedHabitat = button.dataset.selectHabitat; draw(); }; });
    var stockTarget = root.querySelector('[data-stock-target]');
    if (stockTarget) stockTarget.onchange = function () { selectedHabitat = stockTarget.value; draw(); };
    root.querySelectorAll('[data-move-fish]').forEach(function (button) { button.onclick = function () {
      var select = root.querySelector('[data-fish-habitat="' + button.dataset.moveFish + '"]');
      act({ action: select.value ? 'stock' : 'unstock', id: button.dataset.moveFish, habitatId: select.value }, '放养位置已更新。');
    }; });
    root.querySelectorAll('[data-pick]').forEach(function (button) {
      button.onclick = function () {
        if (button.dataset.pick === 'A') selectedA = button.dataset.id;
        else selectedB = button.dataset.id;
        inspected = button.dataset.id;
        draw();
      };
    });
    root.querySelectorAll('[data-inspect]').forEach(function (button) { button.onclick = function () { inspected = button.dataset.inspect; draw(); }; });
    root.querySelectorAll('[data-founder]').forEach(function (button) {
      button.onclick = function () {
        var command = { action: 'founder', species: button.dataset.founder, tier: button.dataset.tier };
        var auto = button.dataset.destination === 'aquaculture';
        if (auto) {
          if (!habitat(selectedHabitat)) return;
          command.habitatId = selectedHabitat;
        }
        act(command, auto ? '亲鱼已直接进入挂机设施。' : '亲鱼已进入手动工作台。');
      };
    });
    root.querySelectorAll('[data-release]').forEach(function (button) {
      button.onclick = function () {
        if (window.confirm && !window.confirm('放流后不能再用它繁育，但后代谱系仍会保留。确定放流？')) return;
        act({ action: 'release', id: button.dataset.release }, '已放流，谱系档案仍然保留。');
      };
    });
    root.querySelectorAll('[data-reagent]').forEach(function (button) {
      button.onclick = function () { selectedItem = button.dataset.reagent; pendingCommand = null; draw(); };
    });
    root.querySelectorAll('[data-buy-reagent]').forEach(function (button) {
      button.onclick = function () { act({ action: 'buy_reagent', itemId: button.dataset.buyReagent }, '定向试剂已放入背包。'); };
    });
    var target = root.querySelector('[data-color-target]');
    if (target) target.onchange = function () { selectedColor = target.value; pendingCommand = null; };
    var breed = root.querySelector('[data-breed]');
    if (breed) breed.onclick = function () {
      var command = { action: 'breed', id: selectedA, otherId: selectedB };
      if (selectedItem) command.itemId = selectedItem;
      if (selectedItem === 'gene_prism') command.targetGene = selectedColor;
      act(command, '手动繁育完成，后代已留在工作台。');
    };
    var refresh = root.querySelector('[data-refresh]');
    if (refresh) refresh.onclick = function () { load(false); };
  }

  function requestKey() {
    return 'breed-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function act(command, successText) {
    if (busy) return;
    var signature = JSON.stringify(command);
    if (!pendingCommand || pendingCommand.signature !== signature) pendingCommand = { signature: signature, requestKey: requestKey() };
    var payload = Object.assign({}, command, { requestKey: pendingCommand.requestKey });
    var id = mountID;
    var epoch = ++dataEpoch;
    busy = true;
    notice = '正在保存繁育档案…';
    draw();
    window.Net.breedingAction(payload).then(function (response) {
      if (id !== mountID || epoch !== dataEpoch || !root) return;
      if (response && response.ok && response.data && response.data.breeding) {
        view = response.data.breeding;
        if (command.action === 'habitat_create' && response.data.result) selectedHabitat = response.data.result.resourceId || '';
        selectedItem = '';
        pendingCommand = null;
        notice = successText;
        if (!individual(selectedA) || !individual(selectedA).active) selectedA = '';
        if (!individual(selectedB) || !individual(selectedB).active) selectedB = '';
      } else {
        var code = response && response.data && response.data.error || 'unavailable';
        notice = ERROR_TEXT[code] || code;
        // A transport failure may have committed server-side. Keep the exact
        // request key so the next click returns the original result.
        if (response && response.status) pendingCommand = null;
      }
    }).catch(function () {
      if (id !== mountID || epoch !== dataEpoch || !root) return;
      notice = ERROR_TEXT.unavailable;
    }).finally(function () {
      if (id !== mountID || epoch !== dataEpoch || !root) return;
      busy = false;
      draw();
    });
  }

  function loadCatalog() {
    if (!catalogPromise) {
      catalogPromise = fetch('assets/genetics/catalog.json?v=5', { cache: 'force-cache' }).then(function (response) {
        if (!response.ok) throw new Error('catalog');
        return response.json();
      });
    }
    return catalogPromise;
  }

  function load(silent) {
    if (loading || busy) return Promise.resolve();
    loading = true;
    var id = mountID;
    var epoch = dataEpoch;
    if (!silent) { notice = notice || '正在读取鱼池…'; draw(); }
    return Promise.all([window.Net.breedingGet(), loadCatalog()]).then(function (results) {
      if (id !== mountID || !root || epoch !== dataEpoch || busy) return;
      var response = results[0];
      catalog = results[1];
      if (!response.ok || !response.data || !response.data.breeding) {
        notice = ERROR_TEXT[response.data && response.data.error] || '鱼池加载失败。';
        view = { fish: [], stock: [], reagents: {}, reagentPrices: {}, capacity: 60, breedCost: 100, mutationRate: .01 };
      } else {
        view = response.data.breeding;
        if (!silent) notice = '';
      }
      draw();
    }).catch(function () {
      if (id !== mountID || !root || epoch !== dataEpoch || busy) return;
      notice = '参考图或鱼池档案加载失败，请稍后重试。';
      view = view || { fish: [], stock: [], reagents: {}, reagentPrices: {}, capacity: 60, breedCost: 100, mutationRate: .01 };
      catalog = catalog || { loci: [], labels: {}, mutations: {}, colors: {}, ornaments: {}, species: {} };
      draw();
    }).finally(function () { if (id === mountID) loading = false; });
  }

  window.BreedUI = {
    mount: function (host) {
      mountID++;
      dataEpoch++;
      busy = false;
      pendingCommand = null;
      loading = false;
      if (refreshTimer) clearInterval(refreshTimer);
      host.querySelectorAll('.breed-system').forEach(function (node) { node.remove(); });
      root = document.createElement('section');
      root.className = 'breed-system';
      root.setAttribute('data-feature', 'character.breeding');
      host.appendChild(root);
      view = null;
      selectedA = '';
      selectedB = '';
      inspected = '';
      selectedItem = '';
      selectedHabitat = '';
      habitatTab = 'aquarium';
      mode = 'workbench';
      selectedTransfer = '';
      notice = '';
      load();
      refreshTimer = setInterval(function () {
        if (!root || !root.isConnected) { clearInterval(refreshTimer); refreshTimer = null; return; }
        if (!document.hidden && !busy) load(true);
      }, 15000);
    },
  };
}());
