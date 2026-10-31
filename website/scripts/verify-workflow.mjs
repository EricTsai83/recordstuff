/**
 * Browser regression for the homepage workflow. Run against the production pages served by Astro:
 * pnpm --dir website exec node scripts/verify-workflow.mjs [http://127.0.0.1:4173]
 * Or --local to route requests directly to the built dist/ files without starting a server.
 * Covers delayed media readiness, seeking, repeat switches, pause, reduced motion and the full loop.
 * No desktop or capture permissions: Chrome is headless. Pictures go to compare/workflow/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const local = process.argv[2] === '--local';
const origin = local ? 'https://workflow.local' : process.argv[2] ?? 'http://127.0.0.1:4173';
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const output = fileURLToPath(new URL('../compare/workflow/', import.meta.url));
fs.mkdirSync(output, { recursive: true });
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
    const p = await b.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(String(e)));
    await p.setViewport({ width: 1280, height: 900 });
    await p.setRequestInterception(true);
    p.on('request', async r => {
        if (r.resourceType() === 'media' && r.url().includes('editor-demo')) await new Promise(resolve => setTimeout(resolve, 1800));
        if (!local) { await r.continue(); return; }
        const url = new URL(r.url());
        const name = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`, url.pathname.endsWith('/') ? 'index.html' : '');
        if (url.origin !== origin || !name.startsWith(dist) || !fs.existsSync(name)) { await r.respond({ status: 404 }); return; }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
        await r.respond({ status: 200, contentType: types[path.extname(name)] ?? 'application/octet-stream', body: fs.readFileSync(name) });
    });
    await p.goto(origin, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-workflow][data-playing]');
    assert(await p.$eval('[data-previous]', e => e.disabled));
    assert(await p.$eval('[data-next]', e => !e.disabled));
    assert(await p.$eval('[data-workflow-progress]', e => e.tagName === 'rect' && e.getAttribute('pathLength') === '1'));
    await p.$eval('.workflow', e => scrollTo(0, e.getBoundingClientRect().top + scrollY - 85));
    await p.setViewport({ width: 1280, height: 280 });
    await p.waitForFunction(() => document.querySelector('[data-playback-state]').textContent === 'Playing');
    assert(await p.$eval('[data-pause-icon]', e => !e.hidden));
    await p.click('[data-toggle]');
    assert.equal(await p.$eval('[data-playback-state]', e => e.textContent), 'Paused');
    assert(await p.$eval('[data-play-icon]', e => !e.hidden));
    await p.click('[data-toggle]');
    assert.equal(await p.$eval('[data-playback-state]', e => e.textContent), 'Playing');
    await p.setViewport({ width: 1280, height: 900 });
    await p.focus('[data-next]');
    await p.keyboard.press('Enter');
    assert(await p.$eval('[data-toggle]', e => e === document.activeElement), 'focus moved off controls while waiting for media');
    assert(await p.$eval('#record-demo', e => e.hasAttribute('data-active') && getComputedStyle(e).opacity === '1'), 'outgoing frame disappeared before media readiness');
    await p.waitForFunction(() => document.querySelector('#edit-demo').hasAttribute('data-active'));
    assert(await p.$eval('[data-next]', e => e.disabled));
    assert(await p.$eval('[data-previous]', e => !e.disabled));
    assert(await p.$eval('[data-toggle]', e => e === document.activeElement), 'focus was lost after cold-load transition');
    assert(await p.$eval('[data-edit-video]', e => e.readyState >= 2));
    console.log('PASS: slow cold load keeps outgoing frame until video is decoded');
    const vid = () => p.$eval('[data-edit-video]', e => ({ time: e.currentTime, paused: e.paused }));
    await p.waitForFunction(() => document.querySelector('[data-edit-video]').currentTime > 0.4);
    const beforePictureClick = await vid();
    await p.click('#edit-demo');
    await p.waitForFunction(time => document.querySelector('[data-edit-video]').currentTime > time + .15, {}, beforePictureClick.time);
    assert.equal((await vid()).paused, false);
    console.log('PASS: clicking the demo picture leaves playback running');
    await p.$eval('.workflow-badge', e => e.scrollIntoView({ block: 'center' }));
    await (await p.$('.workflow-badge')).screenshot({ path: `${output}/badge-playing.png` });
    await p.click('[data-toggle]');
    const t = await vid();
    await new Promise(r => setTimeout(r, 300));
    assert(Math.abs((await vid()).time - t.time) < .05);
    assert((await vid()).paused);
    assert.equal(await p.$eval('[data-playback-state]', e => e.textContent), 'Paused');
    await (await p.$('.workflow-badge')).screenshot({ path: `${output}/badge-paused.png` });
    console.log('PASS: real video progresses and pauses with badge');
    const geometry = () => p.$eval('.specs', e => e.getBoundingClientRect().top + scrollY);
    const baseline = await geometry();
    for (let i = 0; i < 6; i++) {
        await p.click('[data-previous]');
        await p.waitForFunction(() => document.querySelector('#record-demo').hasAttribute('data-active'));
        assert.equal(await p.$eval('.hero-scene', e => getComputedStyle(e).opacity), '1');
        assert.equal(await geometry(), baseline);
        await p.focus('[data-next]');
        await p.keyboard.press('Enter');
        assert(await p.$eval('[data-toggle]', e => e === document.activeElement), 'focus was lost while replay sought to zero');
        await p.waitForFunction(() => document.querySelector('#edit-demo').hasAttribute('data-active'));
        assert((await vid()).time < .1);
        assert(await p.$eval('[data-edit-video]', e => e.readyState >= 2));
    }
    console.log('PASS: repeated returns stay opaque; replay seeks before swapping; no layout shift');
    // Pending transitions cannot be wrapped or restarted by a second arrow press.
    await p.click('[data-previous]');
    await p.evaluate(() => { document.querySelector('[data-next]').click(); document.querySelector('[data-previous]').click(); });
    await p.waitForFunction(() => document.querySelector('#edit-demo').hasAttribute('data-active'));
    await p.keyboard.press('ArrowRight');
    assert(await p.$eval('#edit-demo', e => e.hasAttribute('data-active')));
    await p.click('[data-previous]');
    await p.waitForFunction(() => document.querySelector('#record-demo').hasAttribute('data-active'));
    await p.keyboard.press('ArrowLeft');
    assert(await p.$eval('#record-demo', e => e.hasAttribute('data-active')));
    for (const width of [320, 390]) {
        await p.setViewport({ width, height: 1000 });
        await p.evaluate(() => scrollTo(0, 0));
        assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await p.screenshot({ path: `${output}/motion-${width}.png` });
    }
    await p.setViewport({ width: 1280, height: 900 });
    await p.$eval('.workflow', e => scrollTo(0, e.getBoundingClientRect().top + scrollY - 85));
    await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await p.waitForFunction(() => document.querySelector('[data-toggle]').getAttribute('aria-label').includes(', play demo'));
    await p.click('[data-next]');
    await p.waitForFunction(() => document.querySelector('#edit-demo').hasAttribute('data-active'));
    assert((await vid()).paused);
    await p.click('[data-toggle]');
    await p.waitForFunction(() => document.querySelector('[data-edit-video]').currentTime > .2);
    await p.waitForFunction(() => document.querySelector('#record-demo').hasAttribute('data-active'), { timeout: 18000 });
    console.log('PASS: reduced motion waits for explicit Play; actual video end advances chapter');
    assert.deepEqual(errors, []);
    // Full Record → Edit: confirms the SVG timeline and the media clock meet without hiding either source.
    await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await p.waitForFunction(() => document.querySelector('#edit-demo').hasAttribute('data-active'), { timeout: 35000 });
    assert(await p.$eval('[data-edit-video]', e => e.readyState >= 2 && !e.paused));
    console.log('PASS: full recording animation advances to a decoded, playing video; no page errors');
}
finally {
    await b.close();
}
