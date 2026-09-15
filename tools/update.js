// 自更新脚本（零依赖）：检查 GitHub 最新 Release → 下载 zip → 解包覆盖本地旧版本。
// 用法：node tools/update.js        检查并按需更新（或双击根目录 update.bat）
//       node tools/update.js --check  只检查不更新
// 数据安全：运行时数据在用户「文档」目录（Documents/web-fishing-game），覆盖程序文件不丢存档。
// 代理：默认直连；失败时自动尝试 HTTPS_PROXY / http://127.0.0.1:7890（本机代理）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPO = 'Rinkore/web-fishing-game';
// 私有仓库需要 token（以下任一处提供，均不入库）：
//   环境变量 GITHUB_TOKEN / 文件 tools/.github-token / 参数 --token=ghp_xxx
function readToken() {
  const arg = process.argv.find(a => a.startsWith('--token='));
  if (arg) return arg.slice(8).trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try { return fs.readFileSync(path.join(__dirname, '.github-token'), 'utf8').trim(); } catch (e) { return ''; }
}
const TOKEN = readToken();

function log(s) { console.log(s); }
function authArgs() { return TOKEN ? ['-H', 'Authorization: token ' + TOKEN] : []; }
const CHECK_ONLY = process.argv.includes('--check');
function curl(args) {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
function fetchJson(url, proxy) {
  const args = ['-sS', '-H', 'User-Agent: web-fishing-game-updater'].concat(authArgs());
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  return JSON.parse(curl(args).toString('utf8'));
}
function download(url, dest, proxy) {
  const args = ['-fSL', '-o', dest, '-H', 'User-Agent: web-fishing-game-updater'].concat(authArgs());
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  curl(args);
}
function withProxyFallback(fn) {
  const proxies = [null, process.env.HTTPS_PROXY || null, 'http://127.0.0.1:7890'].filter((v, i, a) => v === null ? i === 0 : a.indexOf(v) === i);
  let lastErr;
  for (const px of proxies) {
    try { return fn(px); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---------- 版本比较：v0.10.4 -> [0,10,4] ----------
function verParts(v) { return String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0); }
function newerThan(a, b) { // a > b ?
  const pa = verParts(a), pb = verParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
function localVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'data.js'), 'utf8');
  const m = /VERSION\s*=\s*'([^']+)'/.exec(src);
  return m ? m[1] : null;
}

// ---------- 解包与覆盖 ----------
function extract(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // Windows 10+ / macOS / Linux 的 bsdtar 都能解 zip
  execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'pipe' });
}
function copyDir(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
    else fs.copyFileSync(s, d);
  }
}

function main() {
  const local = localVersion();
  log('当前版本：' + (local || '未知'));

  log('正在查询 GitHub 最新 Release…');
  const rel = withProxyFallback(px => fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`, px));
  if (!rel || !rel.tag_name) {
    throw new Error('查询 Release 失败' + (TOKEN ? '' : '（私有仓库需提供 token：设 GITHUB_TOKEN 或在 tools/.github-token 写入 token）') +
      (rel && rel.message ? '：' + rel.message : ''));
  }
  const tag = rel.tag_name;
  log('最新版本：' + tag + '（' + rel.name + '）');

  if (local && !newerThan(tag, local)) {
    log('已是最新版本，无需更新 ✅');
    return;
  }
  if (CHECK_ONLY) {
    log('发现新版本可用：' + tag + '（当前 ' + (local || '?') + '）。运行 node tools/update.js 或双击 update.bat 进行更新。');
    process.exitCode = 2;
    return;
  }

  // 优先下 Release 附件 zip，没有则用 zipball
  const asset = (rel.assets || []).find(a => /\.zip$/i.test(a.name));
  const url = asset ? asset.browser_download_url : rel.zipball_url;
  if (!url) throw new Error('Release 中没有可下载的 zip');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-update-'));
  const zip = path.join(tmp, 'release.zip');
  log('下载 ' + url + ' …');
  withProxyFallback(px => download(url, zip, px));

  const exDir = path.join(tmp, 'extract');
  log('解包…');
  extract(zip, exDir);
  // zipball 会多套一层 <owner>-<repo>-<sha>/ 目录，剥掉
  let srcDir = exDir;
  const entries = fs.readdirSync(exDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) srcDir = path.join(exDir, entries[0].name);

  log('覆盖本地文件（存档不受影响，在文档目录）…');
  copyDir(srcDir, ROOT);
  fs.rmSync(tmp, { recursive: true, force: true });

  log('更新完成 ✅ ' + (local || '?') + ' → ' + tag);
  log('请重启游戏服务（重新运行 run.bat）；玩家浏览器会自动刷新到新前端。');
}

try { main(); } catch (e) {
  console.error('更新失败：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
}
