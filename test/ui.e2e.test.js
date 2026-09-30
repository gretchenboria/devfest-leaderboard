'use strict';
// Browser test of the admin board and the Team page with puppeteer-core and
// the local Chrome. Skipped automatically if Chrome is not installed.
//
// Google's sign-in popup cannot be automated, so each page starts with a
// session token (minted with the server's SESSION_SECRET) already in
// sessionStorage, which is exactly what the pages store after Google sign-in.
// Screenshots go to $UI_SCREENSHOT_DIR (default: a temp dir), never the repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROLES, ADMIN_EMAIL, tmpDir, baseEnv, spawnServer, signer, client } = require('./helpers');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const shots = process.env.UI_SCREENSHOT_DIR || tmpDir('ui-shots');

test('admin board and captain Team page work together in a real browser', { skip: !hasChrome && 'Chrome not found', timeout: 120000 }, async t => {
  const puppeteer = require('puppeteer-core');
  const env = baseEnv(tmpDir('ui'));
  const server = await spawnServer(env);
  const call = client(server.base);
  const sign = signer(env);
  const admin = sign.sign({ email: ADMIN_EMAIL, role: 'admin' });
  const ana = sign.sign({ email: 'ana@example.com', role: 'volunteer' });
  const bo = sign.sign({ email: 'bo@example.com', role: 'volunteer' });

  await call('POST', '/api/admin/assign', { taskId: ROLES.registration, firstName: 'Ana', lastName: 'Lopez', email: 'ana@example.com', phone: '650-555-0101', isCaptain: true }, admin);
  await call('POST', '/api/admin/assign', { taskId: ROLES.registration, firstName: 'Bo', lastName: 'Kim', email: 'bo@example.com', phone: '650-555-0102' }, admin);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await server.stop(); });

  async function openAs(token, url, viewport) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    page.on('dialog', d => d.accept());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.evaluateOnNewDocument(tok => sessionStorage.setItem('devfest_session', tok), token);
    await page.goto(server.base + url, { waitUntil: 'domcontentloaded' });
    page.errors = errors;
    return page;
  }
  const text = (page, sel) => page.$eval(sel, el => el.innerText);
  // Query + click in one step inside the page: live re-renders can replace a
  // node between a separate query and click.
  const tap = (page, sel) => page.$eval(sel, el => el.click());

  // ---- Admin: board, captain warning, seeding ----
  const adminPage = await openAs(admin, '/admin', { width: 1280, height: 1000 });
  await adminPage.waitForFunction(() => document.querySelector('#board-roles').innerText.includes('Registration'));
  const boardText = await text(adminPage, '#board-roles');
  assert.match(boardText, /No captain yet/, 'roles without a captain are flagged');
  assert.match(boardText, /Ana L\./, 'captain shown on Registration');

  await adminPage.click('[data-action="seed-all"]');
  await adminPage.waitForFunction(() => /^0\/[1-9]\d* done/.test(document.getElementById("board-totals").innerText));
  const seededTotal = Number((await text(adminPage, '#board-totals')).match(/0\/(\d+) done/)[1]);
  assert.ok(seededTotal >= 30);

  // ---- Admin: create a task through the modal, with hostile text ----
  await adminPage.click(`[data-action="new-task"][data-role="${ROLES.registration}"]`);
  await adminPage.waitForSelector('#task-modal:not(.hidden)');
  const evil = '<img src=x onerror="window.__xss=1">Hand radios to Security';
  await adminPage.type('#tf-title', evil);
  await adminPage.select('#tf-assignee', (await adminPage.$eval('#tf-assignee option:nth-child(2)', o => o.value)));
  await adminPage.type('#tf-location', 'Front desk');
  await adminPage.click('#tf-save');
  await adminPage.waitForFunction(t => document.querySelector('#board-roles').innerText.includes(t), {}, evil);
  assert.equal(await adminPage.evaluate(() => window.__xss), undefined, 'task title rendered as text, not HTML');
  await adminPage.evaluate(() => { window.__noReload = true; });
  await adminPage.screenshot({ path: path.join(shots, 'admin-board.png'), fullPage: false });

  // ---- Captain on a phone ----
  const capPage = await openAs(ana, '/team', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await capPage.waitForFunction(() => document.querySelector('#task-roles') && document.querySelector('#task-roles').innerText.includes('Registration'));
  assert.match(await text(capPage, '#hello'), /Hi Ana!/);
  assert.match(await text(capPage, '#task-roles'), /Assigned to you/);
  assert.equal(await capPage.evaluate(() => window.__xss), undefined);

  // Mark the first task done.
  const firstId = await capPage.$eval('[data-action="set-status"][data-status="done"]', b => b.dataset.id);
  await tap(capPage, `[data-action="set-status"][data-status="done"][data-id="${firstId}"]`);
  await capPage.waitForFunction(() => /1\/\d+/.test(document.querySelector('#task-roles').innerText));

  // Admin board updates live via SSE, without a reload.
  // Interval polling: Chrome pauses requestAnimationFrame in background tabs.
  await adminPage.waitForFunction(total => document.getElementById('board-totals').innerText.startsWith(`1/${total} done`), { timeout: 10000, polling: 200 }, seededTotal + 1);
  assert.equal(await adminPage.evaluate(() => window.__noReload), true, 'admin page was not reloaded');

  // Captain blocks a task with a note; admin sees it highlighted.
  const secondId = await capPage.$$eval('[data-action="set-status"][data-status="blocked"]', bs => bs[1].dataset.id);
  await capPage.type(`.note-input[data-id="${secondId}"]`, 'Waiver QR code 404s');
  await tap(capPage, `[data-action="send-note"][data-id="${secondId}"]`);
  await capPage.waitForFunction(() => document.querySelector('#task-roles').innerText.includes('Waiver QR code 404s'));
  await tap(capPage, `[data-action="set-status"][data-status="blocked"][data-id="${secondId}"]`);
  await adminPage.waitForFunction(() => /1 blocked/.test(document.getElementById('board-totals').innerText) && document.querySelector('#board-roles').innerText.includes('Waiver QR code 404s'), { timeout: 10000, polling: 200 });
  await capPage.screenshot({ path: path.join(shots, 'captain-tasks.png'), fullPage: false });

  // Captain roster shows own team's phone numbers.
  await capPage.click('[data-action="tab"][data-tab="roster"]');
  await capPage.waitForFunction(() => document.getElementById('roster').innerText.includes('650-555-0102'));
  await capPage.screenshot({ path: path.join(shots, 'captain-roster.png'), fullPage: false });

  // ---- Regular volunteer ----
  const boPage = await openAs(bo, '/team', { width: 390, height: 844, isMobile: true, hasTouch: true });
  await boPage.waitForFunction(() => document.querySelector('#task-roles') && document.querySelector('#task-roles').innerText.includes('Only your team captain can update'));
  assert.equal(await boPage.$('[data-action="set-status"]'), null, 'no status buttons for non-captains');
  await boPage.click('[data-action="tab"][data-tab="roster"]');
  await boPage.waitForFunction(() => document.getElementById('roster').innerText.includes('Ana L.'));
  const boRoster = await text(boPage, '#roster');
  assert.ok(!boRoster.includes('650-555-0101'), "volunteer cannot see the captain's phone");
  assert.ok(boRoster.includes('650-555-0102'), 'volunteer sees their own phone');

  // Volunteer edits their own info.
  await boPage.click('[data-action="tab"][data-tab="me"]');
  await boPage.$eval('#me-phone', el => { el.value = ''; });
  await boPage.type('#me-phone', '650-555-7777');
  await boPage.click('#me-save');
  await boPage.waitForFunction(() => document.getElementById('toast').innerText === 'Saved');
  const vols = (await call('GET', '/api/admin/volunteers', undefined, admin)).body.volunteers;
  assert.equal(vols.find(v => v.firstName === 'Bo').phone, '650-555-7777');
  await boPage.screenshot({ path: path.join(shots, 'volunteer-my-info.png'), fullPage: false });

  for (const p of [adminPage, capPage, boPage]) assert.deepEqual(p.errors, [], 'no uncaught page errors');
  console.log(`UI screenshots: ${shots}`);
});
