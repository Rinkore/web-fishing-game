'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = path.resolve(__dirname, '../../frontend/js/data.js');
const D = require(source);
const constants = Object.fromEntries(Object.entries(D).filter(([k, v]) => typeof v !== 'function' && k !== 'EXPR_FUNCS'));
const catalog = { format: 1, version: D.VERSION, source: 'frontend/js/data.js',
  sourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
  constants, items: D.allItems(), defaults: { component: D.getComponentCfg(), fish: D.getFishCfg(),
    snapshot: D.defaultSnapshotCfg(), mall: D.defaultMallCfg() } };
const output = path.resolve(__dirname, '../../server-go/internal/rules/catalog.json');
const content = JSON.stringify(catalog, null, 2) + '\n';
if (process.argv[2] === '--write') {
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content);
} else if (process.argv[2] === '--check') {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== content) throw new Error('Go catalog is stale; review source changes before --write');
} else throw new Error('Usage: node tools/go-rewrite/catalog.js --write|--check');
console.log(`Catalog ${catalog.version}: ${catalog.items.length} definitions, source ${catalog.sourceSHA256.slice(0, 12)}`);
