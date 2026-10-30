/**
 * Browser regression for the homepage workflow. Run against the production pages served by Astro:
 * pnpm --dir website exec node scripts/verify-workflow.mjs [http://127.0.0.1:4173]
 * Covers delayed media readiness, seeking, repeat switches, pause, reduced motion and the full loop.
 * No desktop or capture permissions: Chrome is headless. Pictures go to compare/workflow/.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const origin = process.argv[2] ?? 'http://127.0.0.1:4173';
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
    p.on('request', r => { if (r.resourceType() === 'media' && r.url().includes('editor-demo'))
        setTimeout(() => r.continue(), 1800);
    else
        r.continue(); });
    await p.goto(origin, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-workflow][data-playing]');
    await p.$eval('.workflow', e => scrollTo(0, e.getBoundingClientRect().top + scrollY - 85));
    await p.click('[data-next]');
    assert(await p.$eval('#record-demo', e => e.hasAttribute('data-active') && getComputedStyle(e).opacity === '1'), 'outgoing frame disappeared before media readiness');
    await p.waitForFunction(() => document.querySelector('#edit-demo').hasAttribute('data-active'));
    assert(await p.$eval('[data-edit-video]', e => e.readyState >= 2));
    console.log('PASS: slow cold load keeps outgoing frame until video is decoded');
    const vid = () => p.$eval('[data-edit-video]', e => ({ time: e.currentTime, paused: e.paused }));
    await p.waitForFunction(() => document.querySelector('[data-edit-video]').currentTime > 0.4);
    await p.click('[data-toggle]');
    const t = await vid();
    await new Promise(r => setTimeout(r, 300));
    assert(Math.abs((await vid()).time - t.time) < .05);
    assert((await vid()).paused);
    console.log('PASS: real video progresses and pauses with badge');
    const geometry = () => p.$eval('.specs', e => e.getBoundingClientRect().top + scrollY);
    const baseline = await geometry();
    for (let i = 0; i < 6; i++) {
        await p.click('[data-previous]');
        await p.waitForFunction(() => document.querySelector('#record-demo').hasAttribute('data-active'));
        assert.equal(await p.$eval('.hero-scene', e => getComputedStyle(e).opacity), '1');
        assert.equal(await geometry(), baseline);
        await p.click('[data-next]');
        await p.waitForFunction(() => document.querySelector('#edit-demo').hasAttribute('data-active'));
        assert((await vid()).time < .1);
        assert(await p.$eval('[data-edit-video]', e => e.readyState >= 2));
    }
    console.log('PASS: repeated returns stay opaque; replay seeks before swapping; no layout shift');
    // A delayed request cannot override a later manual choice.
    await p.click('[data-previous]');
    await p.evaluate(() => { document.querySelector('[data-next]').click(); document.querySelector('[data-previous]').click(); });
    await p.waitForFunction(() => document.querySelector('#record-demo').hasAttribute('data-active'));
    for (const width of [320, 390]) {
        await p.setViewport({ width, height: 1000 });
        await p.evaluate(() => scrollTo(0, 0));
        assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await p.screenshot({ path: `${output}/motion-${width}.png` });
    }
    await p.setViewport({ width: 1280, height: 900 });
    await p.$eval('.workflow', e => scrollTo(0, e.getBoundingClientRect().top + scrollY - 85));
    await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await p.waitForFunction(() => document.querySelector('[data-toggle]').getAttribute('aria-label').startsWith('Play'));
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
