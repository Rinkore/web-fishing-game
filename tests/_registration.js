'use strict';
const crypto = require('crypto');
function solve(challenge) {
  for (let n = 0; n < 3000000; n++) {
    if (crypto.createHash('sha256').update(challenge.prefix + ':' + n).digest('hex').startsWith('0000')) return { id: challenge.id, nonce: String(n) };
  }
  throw new Error('No registration proof found');
}
module.exports = { solve };
