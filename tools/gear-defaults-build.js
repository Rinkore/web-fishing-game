'use strict';

// Export the shared defaults without rewriting their source or generation rules.
// Repeated exports are safe; frontend/js/data.js remains the source of truth.
const fs = require('node:fs');
const path = require('node:path');
const D = require('../frontend/js/data');

const output = path.resolve(__dirname, '../output/gear-local/defaults.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(D.GEAR_SYSTEM, null, 2) + '\n');
console.log('Exported gear defaults to ' + output);
