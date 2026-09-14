/*
 * 测试公共工具：轮询等待 / 超时 / HTTP 就绪探测
 * 设计目标：不依赖固定 sleep —— 条件满足即刻返回，超时才失败，既快又不脆。
 * 零第三方依赖，各测试文件 require 本模块即可。
 */
'use strict';
const http = require('http');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 轮询等待条件成立：cond 可返回布尔或 Promise<boolean>
// 返回 true=已满足，false=超时；用时通常远小于 timeout（首次满足即返回）
async function waitFor(cond, opts) {
  opts = opts || {};
  const timeout = opts.timeout != null ? opts.timeout : 5000;
  const interval = opts.interval != null ? opts.interval : 40;
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try { ok = await cond(); } catch (e) { ok = false; }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(interval, Math.max(1, deadline - Date.now())));
  }
}

// 等待 HTTP 探测通过（服务器就绪）：比固定 sleep 更快、更稳
function waitHttp(url, opts) {
  opts = opts || {};
  const timeout = opts.timeout != null ? opts.timeout : 15000;
  const test = opts.test || (j => j && typeof j === 'object');
  return waitFor(function () {
    return new Promise(function (resolve) {
      const req = http.get(url, function (res) {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', function () {
          if (!opts.raw && res.statusCode !== 200) return resolve(false);
          if (opts.raw) return resolve(true);
          let j = null; try { j = JSON.parse(d); } catch (e) {}
          resolve(!!test(j));
        });
      });
      req.on('error', function () { resolve(false); });
      req.setTimeout(1500, function () { req.destroy(); resolve(false); });
    });
  }, { timeout: timeout, interval: 60 });
}

// 等待 DOM/浏览器条件（playwright page 场景）：cond 内可用 page.$$
function waitPage(cond, opts) { return waitFor(cond, Object.assign({ timeout: 5000 }, opts || {})); }

// 轮询等待数值达标（如「等待累计到 N 条渔获」），避免「睡满 N 秒再看」
function waitUntil(fn, opts) { return waitFor(fn, opts); }

module.exports = { sleep, waitFor, waitHttp, waitPage, waitUntil };
