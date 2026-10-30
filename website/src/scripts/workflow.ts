/** One clock drives the recording artwork, edit frames and a continuous chapter timeline. */
export function startWorkflow(root: HTMLElement): void {
  const previous = root.querySelector<HTMLButtonElement>('[data-previous]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-next]')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-toggle]')!;
  const count = root.querySelector<HTMLElement>('[data-stage-count]')!;
  const name = root.querySelector<HTMLElement>('[data-stage-name]')!;
  const panels = [...root.querySelectorAll<HTMLElement>('[data-chapter-panel]')];
  const progressFill = root.querySelector<HTMLElement>('[data-workflow-progress]')!;
  const frames = [...root.querySelectorAll<HTMLElement>('[data-edit-frame]')];
  const status = root.querySelector<HTMLElement>('[data-stage-status]')!;
  const scene = root.querySelector<HTMLElement>('[data-scene-frame]')!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let stage = 0, elapsed = 0, last = 0, visible = false, paused = reduced.matches;
  let artwork: Animation[] = [];
  let duration = 27000;
  const editDuration = 12000;
  const refreshArtwork = (): void => {
    artwork = scene.getAnimations({ subtree: true });
    artwork.forEach(animation => animation.pause());
    const lead = artwork.find(animation => (animation as CSSAnimation).animationName === 'ds-camera');
    const timing = lead?.effect?.getTiming().duration;
    if (typeof timing === 'number' && timing > 0) duration = timing;
  };
  refreshArtwork();
  const draw = (): void => {
    const progress = elapsed / (stage === 0 ? duration : editDuration);
    const totalProgress = ((stage === 0 ? 0 : duration) + progress * (stage === 0 ? duration : editDuration)) / (duration + editDuration);
    progressFill.style.transform = `scaleX(${totalProgress})`;
    if (stage === 0) artwork.forEach(animation => { animation.currentTime = elapsed; });
    const editFrame = Math.min(2, Math.floor(elapsed / 4000));
    frames.forEach((frame, index) => { frame.hidden = index !== editFrame; });
    const holdingFocus = panels[stage].contains(document.activeElement);
    const playing = !paused && visible && !document.hidden && !holdingFocus;
    status.textContent = `${playing ? 'Playing' : 'Paused'} · ${stage === 0 ? 'Record → Edit' : 'Edit → Record'}`;
    const stageName = stage === 0 ? 'Record' : 'Edit';
    const otherName = stage === 0 ? 'Edit' : 'Record';
    const number = `0${stage + 1} / 02`;
    if (count.textContent !== number) count.textContent = number;
    if (name.textContent !== stageName) name.textContent = stageName;
    const action = `${paused ? 'Play' : 'Pause'} ${stageName} demo`;
    if (toggle.getAttribute('aria-label') !== action) {
      toggle.setAttribute('aria-label', action);
      toggle.title = action;
      previous.setAttribute('aria-label', `Previous stage: ${otherName}`);
      next.setAttribute('aria-label', `Next stage: ${otherName}`);
    }
    root.dataset.playing = String(playing);
  };
  const choose = (index: number): void => {
    stage = index; elapsed = 0; last = 0;
    panels.forEach((panel, i) => { panel.hidden = i !== stage; });
    // Showing the SVG again may recreate its CSS animations.
    if (stage === 0) refreshArtwork();
    draw();
  };
  previous.addEventListener('click', () => choose((stage + panels.length - 1) % panels.length));
  next.addEventListener('click', () => choose((stage + 1) % panels.length));
  toggle.addEventListener('click', () => { paused = !paused; last = 0; draw(); });
  root.querySelector('[role="group"]')!.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    let target: number | undefined;
    if (key === 'ArrowRight') target = (stage + 1) % panels.length;
    if (key === 'ArrowLeft') target = (stage + panels.length - 1) % panels.length;
    if (key === 'Home') target = 0;
    if (key === 'End') target = panels.length - 1;
    if (target !== undefined) { event.preventDefault(); choose(target); }
  });
  reduced.addEventListener('change', () => { paused = reduced.matches; refreshArtwork(); last = 0; draw(); });
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; last = 0; draw(); }, { threshold: 0.35 }).observe(root.querySelector('.workflow-stage')!);
  document.addEventListener('visibilitychange', () => { last = 0; draw(); });
  const tick = (now: number): void => {
    const hold = panels[stage].contains(document.activeElement);
    if (!paused && visible && !document.hidden && !hold) {
      if (last) elapsed += Math.min(now - last, 100);
      if (elapsed >= (stage === 0 ? duration : editDuration)) choose((stage + 1) % panels.length);
    }
    last = now;
    draw();
    requestAnimationFrame(tick);
  };
  choose(0);
  requestAnimationFrame(tick);
}
