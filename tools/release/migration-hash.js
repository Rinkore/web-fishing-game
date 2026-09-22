'use strict';

const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

function migrationHash(directory = path.resolve(__dirname, '../../server-go/migrations')) {
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error('No SQL migrations found');
  const entries = files.map(name => {
    const digest = createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex');
    return `${name}:${digest}\n`;
  }).join('');
  return createHash('sha256').update(entries, 'utf8').digest('hex');
}

module.exports = { migrationHash };
if (require.main === module) process.stdout.write(`${migrationHash(process.argv[2])}\n`);
