'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }

(async () => {
  const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.route('http://social.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '') });
      return route.fulfill({ path: file });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://social.test/');
    await page.evaluate(() => {
      document.querySelector('#auth').remove();
      const st = Engine.state;
      st.me = { id: 'self', name: 'Self' };
      const peers = [
        { id: 'peer', name: 'Fisher', username: 'peer', online: true, status: 'fishing' },
        { id: 'other', name: 'Fisher', username: 'other', online: true, status: 'fishing' },
      ];
      window.socialFixture = { peers, relations: { friends: [], in: [], out: [] }, actions: [] };
      st.playersPage = { page: 1, pages: 1, total: 3, list: [st.me, ...peers] };
      st.onlineTotal = 3;
      Net.setPlayersView = () => {};
      Net.fetchPlayersPage = async () => ({ ok: true });
      Net.friendRelations = async () => ({ ok: true, data: socialFixture.relations });
      Net.friendUpdate = async (id, action) => {
        socialFixture.actions.push({ id, action });
        for (const bucket of Object.keys(socialFixture.relations)) {
          socialFixture.relations[bucket] = socialFixture.relations[bucket].filter(key => key !== id);
        }
        if (action === 'request') socialFixture.relations.out.push(id);
        if (action === 'accept') socialFixture.relations.friends.push(id);
        return { ok: true, data: {} };
      };
      Net.fetchFriends = async () => {
        const rel = socialFixture.relations;
        return { ok: true, data: {
          friends: peers.filter(p => rel.friends.includes(p.id)),
          players: peers.map(p => ({ ...p, friend: rel.friends.includes(p.id), reqIn: rel.in.includes(p.id), reqOut: rel.out.includes(p.id) })),
          requests: { in: peers.filter(p => rel.in.includes(p.id)), out: peers.filter(p => rel.out.includes(p.id)) },
          page: 1, pages: 1, total: peers.length,
        } };
      };
      UI.setView('ground'); UI.renderView();
    });
    const online = page.locator('[data-region="peeps"]');
    const onlinePeer = online.locator('[data-key="peer"]');
    check('Online list initially shows each player once, including matching nicknames', await online.locator('.peep').count() === 3);
    await page.evaluate(() => { window.unchangedPeer = document.querySelector('[data-region="peeps"] [data-key="other"]'); });
    await onlinePeer.getByRole('button', { name: '➕ 加好友', exact: true }).click();
    await online.getByRole('button', { name: '撤回申请', exact: true }).first().waitFor();
    check('Adding a friend replaces the original online card without duplicating it', await online.locator('.peep').count() === 3 && await onlinePeer.getByRole('button', { name: '撤回申请', exact: true }).count() === 1);
    await page.evaluate(async () => { for (let i = 0; i < 20; i++) { await UI.friendPush(); UI.renderView(); } });
    check('Repeated relation pushes and player renders retain one card per player', await online.locator('.peep').count() === 3 && await onlinePeer.count() === 1);
    check('Unchanged players keep their existing DOM nodes', await page.evaluate(() => unchangedPeer === document.querySelector('[data-region="peeps"] [data-key="other"]')));
    await onlinePeer.getByRole('button', { name: '撤回申请', exact: true }).click();
    await onlinePeer.getByRole('button', { name: '➕ 加好友', exact: true }).waitFor();
    check('Cancel updates the same player once', await online.locator('.peep').count() === 3);
    await page.evaluate(async () => { socialFixture.relations.in = ['peer']; await UI.friendPush(); });
    await onlinePeer.getByRole('button', { name: '✓ 同意', exact: true }).click();
    await onlinePeer.getByRole('button', { name: '✓ 已添加', exact: true }).waitFor();
    check('Accept shows exactly one disabled added button', await online.locator('.peep').count() === 3 && await onlinePeer.getByRole('button', { name: '✓ 已添加', exact: true }).isDisabled());
    await page.evaluate(() => { Engine.state.playersPage.list.reverse(); UI.renderView(); });
    check('Reordering moves existing cards without duplicates', await online.locator('.peep').evaluateAll(nodes => nodes.map(n => n.dataset.key).join(',') === 'other,peer,self'));
    await page.evaluate(() => { Engine.state.playersPage.list = Engine.state.playersPage.list.filter(p => p.id !== 'peer'); Engine.state.playersPage.total--; UI.renderView(); });
    check('A departing player leaves no stale card after replacement', await online.locator('.peep').count() === 2 && await onlinePeer.count() === 0);

    await page.evaluate(async () => { socialFixture.relations = { friends: [], in: [], out: [] }; await UI.friendPush(); });
    await page.getByRole('button', { name: '👥 好友', exact: true }).click();
    const search = page.locator('.friends-panel .ground-cols > .sub').nth(1).locator('.peeps');
    const saved = page.locator('.friends-panel .ground-cols > .sub').first().locator('.peeps');
    const incoming = page.locator('.friend-reqs > .peeps').nth(0);
    const outgoing = page.locator('.friend-reqs > .peeps').nth(1);
    const searchPeer = search.locator('[data-key="peer"]');
    await searchPeer.getByRole('button', { name: '添加好友', exact: true }).waitFor();
    await searchPeer.getByRole('button', { name: '添加好友', exact: true }).click();
    await outgoing.locator('.peep').waitFor();
    await page.evaluate(async () => { for (let i = 0; i < 20; i++) await UI.friendPush(); });
    check('Friend search retains one row per player across repeated refreshes', await search.locator('.peep').count() === 2 && await searchPeer.getByRole('button', { name: '撤回申请', exact: true }).count() === 1);
    check('Sent requests do not accumulate during refreshes', await outgoing.locator('.peep').count() === 1);
    await outgoing.getByRole('button', { name: '撤回', exact: true }).click();
    await searchPeer.getByRole('button', { name: '添加好友', exact: true }).waitFor();
    check('Cancel removes the request and restores a single search row', await outgoing.locator('.peep').count() === 0 && await search.locator('.peep').count() === 2);
    await page.evaluate(async () => { socialFixture.relations.in = ['peer']; await UI.friendPush(); });
    await page.evaluate(async () => { for (let i = 0; i < 10; i++) await UI.friendPush(); });
    check('Received requests retain one row during repeated refreshes', await incoming.locator('.peep').count() === 1 && await search.locator('.peep').count() === 2);
    await incoming.getByRole('button', { name: '✓ 同意', exact: true }).click();
    await saved.locator('[data-key="peer"]').waitFor();
    await page.evaluate(async () => { for (let i = 0; i < 10; i++) await UI.friendPush(); });
    check('Accept clears the request and creates one saved friend', await incoming.locator('.peep').count() === 0 && await saved.locator('.peep').count() === 1 && await search.locator('.peep').count() === 2 && await searchPeer.getByRole('button', { name: '已添加', exact: true }).isDisabled());
    await saved.getByRole('button', { name: '移除好友', exact: true }).click();
    await searchPeer.getByRole('button', { name: '添加好友', exact: true }).waitFor();
    check('Remove deletes the saved row without leaving duplicate search entries', await saved.locator('.peep').count() === 0 && await search.locator('.peep').count() === 2);
    await page.evaluate(async () => { socialFixture.relations.in = ['peer']; await UI.friendPush(); });
    await incoming.getByRole('button', { name: '拒绝', exact: true }).click();
    await searchPeer.getByRole('button', { name: '添加好友', exact: true }).waitFor();
    check('Reject removes the request without stale rows', await incoming.locator('.peep').count() === 0 && await search.locator('.peep').count() === 2);
    check('Each click sends exactly one action for the intended player', await page.evaluate(() => socialFixture.actions.every(a => a.id === 'peer') && socialFixture.actions.map(a => a.action).join(',') === 'request,cancel,accept,request,cancel,accept,remove,reject'));
    assert.deepEqual(errors, []);
    check('No browser errors', true);
    console.log('通过 ' + count + ' 项，失败 0 项');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
