/** The recording clock and the real editor video's media clock share one chapter timeline. */
export function startWorkflow(root: HTMLElement): void {
  const previous = root.querySelector<HTMLButtonElement>('[data-previous]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-next]')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-toggle]')!;
  const name = root.querySelector<HTMLElement>('[data-stage-name]')!;
  const panels = [...root.querySelectorAll<HTMLElement>('[data-chapter-panel]')];
  const progressFill = root.querySelector<HTMLElement>('[data-workflow-progress]')!;
  const status = root.querySelector<HTMLElement>('[data-stage-status]')!;
  const scene = root.querySelector<HTMLElement>('[data-scene-frame]')!;
  const video = root.querySelector<HTMLVideoElement>('[data-edit-video]')!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let stage = 0, elapsed = 0, last = 0, visible = false, paused = reduced.matches;
  let request = 0, playRequest = 0, pending: number | null = null, videoWanted = false, error = '';
  let artwork: Animation[] = [];
  let duration = 27000;
  const editDuration = (): number => Number.isFinite(video.duration) ? video.duration * 1000 : 13567;
  // Resolve readiness before replacing the outgoing panel. On failure keep its last painted frame.
  const editReady = new Promise<boolean>(resolve => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { resolve(true); return; }
    if (video.error) { resolve(false); return; }
    video.addEventListener('loadeddata', () => resolve(true), { once: true });
    video.addEventListener('error', () => resolve(false), { once: true });
  });
  const refreshArtwork = (): void => {
    artwork = scene.getAnimations({ subtree: true });
    artwork.forEach(animation => animation.pause());
    const lead = artwork.find(animation => (animation as CSSAnimation).animationName === 'ds-camera');
    const timing = lead?.effect?.getTiming().duration;
    if (typeof timing === 'number' && timing > 0) duration = timing;
  };
  refreshArtwork();
  const draw = (): void => {
    const playing = !paused && visible && !document.hidden && !panels[stage].contains(document.activeElement);
    const wantsVideo = stage === 1 && playing;
    if (wantsVideo !== videoWanted) {
      videoWanted = wantsVideo;
      const playingTicket = ++playRequest;
      if (wantsVideo) void video.play().catch(() => {
        // A pending play can be interrupted by a manual chapter change or by scrolling away.
        if (videoWanted && playingTicket === playRequest) { paused = true; videoWanted = false; }
      });
      else video.pause();
    }
    const time = stage === 0 ? elapsed : video.currentTime * 1000;
    const totalProgress = ((stage === 0 ? 0 : duration) + time) / (duration + editDuration());
    progressFill.style.transform = `scaleX(${Math.min(1, totalProgress)})`;
    if (stage === 0) artwork.forEach(animation => { animation.currentTime = elapsed; });
    const message = error || `${playing ? 'Playing' : 'Paused'} · ${stage === 0 ? 'Record → Edit' : 'Edit → Record'}`;
    if (status.textContent !== message) status.textContent = message;
    const stageName = stage === 0 ? 'Record' : 'Edit';
    const otherName = stage === 0 ? 'Edit' : 'Record';
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
  const choose = async (index: number): Promise<void> => {
    const ticket = ++request;
    pending = index;
    // Do not clear or hide Record while the editor's first frame is still downloading/decoding.
    if (index === 1 && !await editReady) {
      if (ticket === request) { pending = null; paused = true; error = 'The editing demo could not load.'; draw(); }
      return;
    }
    if (ticket !== request) return;
    error = '';
    video.pause(); videoWanted = false;
    if (index === 1 && video.currentTime !== 0) {
      await new Promise<void>(resolve => {
        video.addEventListener('seeked', () => resolve(), { once: true });
        video.currentTime = 0;
      });
      if (ticket !== request) return;
    }
    pending = null;
    stage = index; elapsed = 0; last = 0;
    panels.forEach((panel, i) => {
      panel.toggleAttribute('data-active', i === stage);
      panel.inert = i !== stage;
      panel.setAttribute('aria-hidden', String(i !== stage));
    });
    draw();
  };
  previous.addEventListener('click', () => { void choose(((pending ?? stage) + panels.length - 1) % panels.length); });
  next.addEventListener('click', () => { void choose(((pending ?? stage) + 1) % panels.length); });
  toggle.addEventListener('click', () => { paused = !paused; last = 0; draw(); });
  root.querySelector('[role="group"]')!.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key;
    let target: number | undefined;
    if (key === 'ArrowRight') target = ((pending ?? stage) + 1) % panels.length;
    if (key === 'ArrowLeft') target = ((pending ?? stage) + panels.length - 1) % panels.length;
    if (key === 'Home') target = 0;
    if (key === 'End') target = panels.length - 1;
    if (target !== undefined) { event.preventDefault(); void choose(target); }
  });
  reduced.addEventListener('change', () => { paused = reduced.matches; refreshArtwork(); last = 0; draw(); });
  video.addEventListener('ended', () => { if (stage === 1) void choose(0); });
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; last = 0; draw(); }, { threshold: 0.35 }).observe(root.querySelector('.workflow-stage')!);
  document.addEventListener('visibilitychange', () => { last = 0; draw(); });
  const tick = (now: number): void => {
    if (stage === 0 && !paused && visible && !document.hidden && !panels[stage].contains(document.activeElement)) {
      if (last) elapsed = Math.min(duration, elapsed + Math.min(now - last, 100));
      if (elapsed >= duration && pending !== 1) { void choose(1); }
    }
    last = now;
    draw();
    requestAnimationFrame(tick);
  };
  void choose(0);
  requestAnimationFrame(tick);
}
