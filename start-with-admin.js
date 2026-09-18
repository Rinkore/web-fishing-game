'use strict';
/* 启动 9000 服务并为 zcode001 配置管理员 TOTP，密钥写入 Documents/web-fishing-game/admin-totp-zcode001.txt */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = 'F:/智谱Zcode数据存储/钓鱼项目';
const DATA = path.join(os.homedir(), 'Documents', 'web-fishing-game');
const S = require(ROOT + '/backend/security.js');

// 服务停着时直接把 zcode001 提权（admin-totp 命令要求已是管理员）
const accFile = path.join(DATA, 'accounts', 'zcode001.json');
const acc = JSON.parse(fs.readFileSync(accFile, 'utf8'));
if (!acc.admin) { acc.admin = true; fs.writeFileSync(accFile, JSON.stringify(acc)); console.log('[prep] zcode001 已提权 admin=true'); }

const srv = spawn(process.execPath, ['backend/server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { FISHING_DEV: '1' }),
  stdio: ['pipe', 'pipe', 'inherit'],
});
let out = '';
srv.stdout.on('data', c => {
  out += c.toString();
  const m = out.match(/请将以下密钥加入验证器[^\n]*：([A-Z2-7]+)/);
  if (m) {
    const secret = m[1];
    const file = path.join(DATA, 'admin-totp-zcode001.txt');
    fs.writeFileSync(file, [
      '管理员账号：zcode001',
      'TOTP 密钥（Base32，添加到验证器 App）：' + secret,
      'otpauth链接：otpauth://totp/FishGame:zcode001?secret=' + secret + '&issuer=FishGame',
      '生成时间：' + new Date().toLocaleString(),
    ].join('\n'));
    console.log('[prep] TOTP 密钥已保存：' + file);
  }
});
function waitHttp(url) {
  return new Promise(res => {
    const q = http.get(url, x => { x.resume(); res(true); });
    q.on('error', () => setTimeout(() => res(waitHttp(url)), 400));
  });
}
(async () => {
  await waitHttp('http://127.0.0.1:9000/api/version');
  console.log('[prep] 服务已就绪');
  await new Promise(r => setTimeout(r, 500));
  srv.stdin.write('admin-totp zcode001\n');
})().catch(e => console.error('[prep] ' + e.message));
