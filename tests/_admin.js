'use strict';
const fs = require('fs');
const path = require('path');
const { waitFor } = require('./_util');
const { totp } = require('../backend/security');
// Test-only local console provisioning. Never exposes an HTTP bootstrap bypass.
async function provisionAdmin(server, dir, username) {
  const file = path.join(dir, 'accounts', username + '.json');
  await waitFor(() => fs.existsSync(file), { timeout: 5000 });
  const prior = JSON.parse(fs.readFileSync(file));
  server.stdin.write((prior.admin ? 'admin-totp ' : 'admin-init ') + username + '\n');
  if (!await waitFor(() => {
    const rec = JSON.parse(fs.readFileSync(file));
    return rec.adminTotpSecret && rec.adminTotpSecret !== prior.adminTotpSecret;
  }, { timeout: 5000 })) throw new Error('Local administrator setup failed');
  return totp(JSON.parse(fs.readFileSync(file)).adminTotpSecret);
}
module.exports = { provisionAdmin };
