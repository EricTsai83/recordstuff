import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import { startWorkflow } from "../src/scripts/workflow.ts";

function setup(ready = true, observeImmediately = true) {
  const window = new Window();
  const document = window.document;
  document.body.innerHTML = `<div data-workflow><div role="group">
    <button data-previous></button><button data-toggle><span data-play-icon></span><span data-pause-icon></span><span data-stage-name></span><span data-playback-state></span></button><button data-next></button>
    <svg><path data-workflow-progress /></svg><span data-stage-status></span></div>
    <div class="workflow-stage"><div data-chapter-panel><div data-scene-frame></div></div><div data-chapter-panel><video data-edit-video></video></div></div></div>`;
  let frame: FrameRequestCallback = () => {};
  let visibility: (entries: unknown[]) => void = () => {};
  Object.assign(globalThis, { document, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; return 1; },
    IntersectionObserver: class {
      callback: (entries: unknown[]) => void;
      constructor(callback: (entries: unknown[]) => void) { this.callback = callback; visibility = callback; }
      observe() { if (observeImmediately) this.callback([{ isIntersecting: true }]); }
    },
  });
  const root = document.querySelector("[data-workflow]")!;
  root.getBoundingClientRect = () => new window.DOMRect(0, 0, 156, 500);
  const video = document.querySelector("video")!;
  Object.defineProperties(video, { readyState: { value: ready ? 2 : 0 }, duration: { value: 10 } });
  video.play = async () => {};
  video.pause = () => {};
  Object.assign(document.querySelector("[data-scene-frame]")!, { getAnimations: () => [] });
  startWorkflow(root as unknown as HTMLElement);
  const previous = root.querySelector("[data-previous]") as import("happy-dom").HTMLButtonElement;
  const next = root.querySelector("[data-next]") as import("happy-dom").HTMLButtonElement;
  const key = (value: string) => root.querySelector('[role="group"]')!.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true }));
  return { window, root, video, previous, next, key, frame: (now: number) => frame(now),
    visible: (isIntersecting: boolean) => visibility([{ isIntersecting }]),
    stage: () => root.querySelector("[data-stage-name]")!.textContent,
    progress: () => Number((root.querySelector("[data-workflow-progress]") as import("happy-dom").SVGElement).style.strokeDashoffset) };
}

test("manual arrows and keyboard stop at each chapter's boundary; automatic completion still loops", async () => {
  const s = setup();
  try {
    assert.equal(s.previous.disabled, true); assert.equal(s.next.disabled, false);
    s.key("ArrowLeft"); assert.equal(s.stage(), "Record");
    s.next.click(); await Promise.resolve();
    assert.equal(s.stage(), "Edit");
    assert.equal(s.previous.disabled, false); assert.equal(s.next.disabled, true);
    s.key("ArrowRight"); assert.equal(s.stage(), "Edit");
    s.previous.click(); assert.equal(s.stage(), "Record");
    // A user navigating with the keyboard cannot wrap, but the media timeline can.
    s.next.click(); await Promise.resolve();
    s.video.dispatchEvent(new s.window.Event("ended"));
    assert.equal(s.stage(), "Record");
  } finally { await s.window.happyDOM.close(); }
});

test("the perimeter stroke follows the shared recording and editing timeline", async () => {
  const s = setup();
  try {
    assert.equal(s.progress(), 1);
    s.frame(100); s.frame(200);
    assert.ok(s.progress() < 1 && s.progress() > 0);
    s.next.click(); await Promise.resolve();
    const start = s.progress();
    s.video.currentTime = 5; s.frame(300);
    assert.ok(s.progress() < start);
    s.video.currentTime = 10; s.frame(400);
    assert.equal(s.progress(), 0);
  } finally { await s.window.happyDOM.close(); }
});

test("loading the next chapter disables both arrows until the visible stage changes", async () => {
  const s = setup(false);
  try {
    s.next.click();
    assert.equal(s.previous.disabled, true); assert.equal(s.next.disabled, true);
    s.key("ArrowLeft"); s.key("End"); assert.equal(s.stage(), "Record");
    s.video.dispatchEvent(new s.window.Event("loadeddata")); await Promise.resolve();
    assert.equal(s.stage(), "Edit");
    assert.equal(s.previous.disabled, false); assert.equal(s.next.disabled, true);
  } finally { await s.window.happyDOM.close(); }
});

test("the visible playback state and action icon update immediately when toggled", async () => {
  const s = setup();
  try {
    const state = () => s.root.querySelector('[data-playback-state]')!.textContent;
    const toggle = s.root.querySelector('[data-toggle]') as import('happy-dom').HTMLButtonElement;
    assert.equal(state(), 'Playing');
    toggle.click();
    assert.equal(state(), 'Paused');
    assert.equal(s.root.querySelector('[data-play-icon]')!.hasAttribute('hidden'), false);
    assert.equal(s.root.querySelector('[data-pause-icon]')!.hasAttribute('hidden'), true);
    assert.equal(s.stage(), 'Record');
    toggle.click(); assert.equal(state(), 'Playing');
  } finally { await s.window.happyDOM.close(); }
});

test("clicking or focusing the demo picture does not pause its animation", async () => {
  const s = setup();
  try {
    const panel = s.root.querySelector('[data-chapter-panel]') as import('happy-dom').HTMLElement;
    panel.tabIndex = 0; panel.focus(); panel.click();
    s.frame(100); s.frame(200);
    assert.ok(s.progress() < 1);
    assert.equal(s.root.querySelector('[data-playback-state]')!.textContent, 'Playing');
    s.next.click(); await Promise.resolve();
    const edit = s.root.querySelectorAll('[data-chapter-panel]')[1] as import('happy-dom').HTMLElement;
    edit.tabIndex = 0; edit.focus(); edit.click(); s.frame(300);
    assert.equal(s.root.getAttribute('data-playing'), 'true');
  } finally { await s.window.happyDOM.close(); }
});

test("offscreen pause keeps the visible state and icon consistent, and the spoken name includes the visible words", async () => {
  const s = setup();
  try {
    const toggle = s.root.querySelector('[data-toggle]')!;
    const state = () => s.root.querySelector('[data-playback-state]')!.textContent;
    assert.equal(toggle.getAttribute('aria-label'), 'Record Playing, pause demo');
    s.visible(false);
    assert.equal(state(), 'Paused');
    assert.equal(s.root.querySelector('[data-play-icon]')!.hasAttribute('hidden'), false);
    assert.equal(s.root.querySelector('[data-pause-icon]')!.hasAttribute('hidden'), true);
    assert.equal(toggle.getAttribute('aria-label'), 'Record Paused, play demo');
    s.visible(true);
    assert.equal(state(), 'Playing');
    assert.equal(s.root.querySelector('[data-pause-icon]')!.hasAttribute('hidden'), false);
  } finally { await s.window.happyDOM.close(); }
});

test("an initially visible demo stays Playing before IntersectionObserver first reports", async () => {
  const s = setup(true, false);
  try {
    assert.equal(s.root.querySelector('[data-playback-state]')!.textContent, 'Playing');
    assert.equal(s.root.querySelector('[data-pause-icon]')!.hasAttribute('hidden'), false);
  } finally { await s.window.happyDOM.close(); }
});

test("an Edit load failure does not replace the resumed Record playback state", async () => {
  const s = setup(false);
  try {
    s.next.click(); s.video.dispatchEvent(new s.window.Event('error')); await Promise.resolve();
    assert.equal(s.root.querySelector('[data-playback-state]')!.textContent, 'Paused');
    assert.match(s.root.querySelector('[data-stage-status]')!.textContent!, /could not load/);
    (s.root.querySelector('[data-toggle]') as import('happy-dom').HTMLButtonElement).click();
    assert.equal(s.root.querySelector('[data-playback-state]')!.textContent, 'Playing');
    assert.equal(s.root.querySelector('[data-toggle]')!.getAttribute('aria-label'), 'Record Playing, pause demo');
  } finally { await s.window.happyDOM.close(); }
});
