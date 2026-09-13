/*
 * 前端独立静态服务器（零依赖）
 * 用法： node frontend/serve.js   （默认端口 5500，可用 PORT 环境变量覆盖）
 * 仅用于本地开发；生产可改用 nginx / GitHub Pages 等任意静态托管，直接部署 frontend 目录。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5500;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = http.createServer(function (req, res) {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  const rel = p === '/' ? '/index.html' : p;
  const fp = path.normalize(path.join(ROOT, rel));
  if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log('🎣 钓鱼小游戏前端已启动: http://localhost:' + PORT);
  console.log('   API_BASE=auto：将自动连接同主机的 9000 后端，请先启动 node backend/server.js');
});
