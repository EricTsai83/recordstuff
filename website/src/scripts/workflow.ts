/** The recording clock and the real editor video's media clock share one chapter timeline. */
export function startWorkflow(root: HTMLElement): void {
  const previous = root.querySelector<HTMLButtonElement>('[data-previous]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-next]')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-toggle]')!;
  const name = root.querySelector<HTMLElement>('[data-stage-name]')!;
  const playbackState = root.querySelector<HTMLElement>('[data-playback-state]')!;
  const playIcon = root.querySelector<HTMLElement>('[data-play-icon]')!;
  const pauseIcon = root.querySelector<HTMLElement>('[data-pause-icon]')!;
  const panels = [...root.querySelectorAll<HTMLElement>('[data-chapter-panel]')];
  const progressFill = root.querySelector<SVGElement>('[data-workflow-progress]')!;
  const status = root.querySelector<HTMLElement>('[data-stage-status]')!;
  const scene = root.querySelector<HTMLElement>('[data-scene-frame]')!;
  const video = root.querySelector<HTMLVideoElement>('[data-edit-video]')!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const bounds = root.getBoundingClientRect();
  const viewport = root.ownerDocument.defaultView;
  const initiallyVisible = !!viewport && bounds.width > 0 && bounds.height > 0
    && bounds.bottom > 0 && bounds.right > 0 && bounds.top < viewport.innerHeight && bounds.left < viewport.innerWidth;
  let stage = 0, elapsed = 0, last = 0, visible = initiallyVisible, paused = reduced.matches;
  let request = 0, playRequest = 0, pending: number | null = null, videoWanted = false, error = '';
  let artwork: Animation[] = [];
  let recordClock: Animation | undefined;
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
    recordClock = lead;
    const timing = lead?.effect?.getTiming().duration;
    if (typeof timing === 'number' && timing > 0) duration = timing;
    artwork.forEach(animation => {
      if (animation.effect?.getTiming().duration === duration) animation.effect.updateTiming({ iterations: 1, fill: 'both' });
    });
  };
  refreshArtwork();
  const draw = (): void => {
    const playing = !paused && visible && !document.hidden;
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
    progressFill.style.strokeDashoffset = String(1 - Math.max(0, Math.min(1, totalProgress)));
    previous.disabled = stage === 0 || pending !== null;
    next.disabled = stage === panels.length - 1 || pending !== null;
    // Let the browser interpolate transforms on its own timeline instead of seeking every animation each frame.
    const animateRecord = stage === 0 && playing && elapsed < duration;
    artwork.forEach(animation => {
      if (animateRecord && animation.playState !== 'running') animation.play();
      else if (!animateRecord && animation.playState === 'running') animation.pause();
    });
    const message = error || `${playing ? 'Playing' : 'Paused'} · ${stage === 0 ? 'Record → Edit' : 'Edit → Record'}`;
    if (status.textContent !== message) status.textContent = message;
    const stateName = pending !== null ? 'Loading' : playing ? 'Playing' : 'Paused';
    if (playbackState.textContent !== stateName) playbackState.textContent = stateName;
    playIcon.hidden = playing;
    pauseIcon.hidden = !playing;
    const stageName = stage === 0 ? 'Record' : 'Edit';
    if (name.textContent !== stageName) name.textContent = stageName;
    const action = `${stageName} ${stateName}, ${playing ? 'pause' : 'play'} demo`;
    if (toggle.getAttribute('aria-label') !== action) {
      toggle.setAttribute('aria-label', action);
      toggle.title = action;
      previous.setAttribute('aria-label', 'Previous stage: Record');
      next.setAttribute('aria-label', 'Next stage: Edit');
    }
    root.dataset.playing = String(playing);
  };
  const choose = async (index: number): Promise<void> => {
    // Move focus before draw disables an arrow; browsers may otherwise send it to the body during the await.
    if (document.activeElement === previous || document.activeElement === next) toggle.focus({ preventScroll: true });
    const ticket = ++request;
    pending = index;
    draw();
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
    if (stage === 0) artwork.forEach(animation => { animation.currentTime = 0; });
    panels.forEach((panel, i) => {
      panel.toggleAttribute('data-active', i === stage);
      panel.inert = i !== stage;
      panel.setAttribute('aria-hidden', String(i !== stage));
    });
    draw();
    if ((document.activeElement === previous && previous.disabled) || (document.activeElement === next && next.disabled)) {
      toggle.focus({ preventScroll: true });
    }
  };
  const chooseManually = (index: number): void => {
    if (pending !== null || index < 0 || index >= panels.length || index === stage) return;
    void choose(index);
  };
  previous.addEventListener('click', () => { chooseManually(stage - 1); });
  next.addEventListener('click', () => { chooseManually(stage + 1); });
  toggle.addEventListener('click', () => { paused = !paused && visible && !document.hidden; last = 0; draw(); });
  root.querySelector('[role="group"]')!.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key;
    let target: number | undefined;
    if (key === 'ArrowRight') target = stage + 1;
    if (key === 'ArrowLeft') target = stage - 1;
    if (key === 'Home') target = 0;
    if (key === 'End') target = panels.length - 1;
    if (target !== undefined) { event.preventDefault(); chooseManually(target); }
  });
  reduced.addEventListener('change', () => { paused = reduced.matches; refreshArtwork(); last = 0; draw(); });
  video.addEventListener('ended', () => { if (stage === 1) void choose(0); });
  // Include the controls: when the badge is visible, its state and action must remain usable.
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; last = 0; draw(); }, { threshold: 0 }).observe(root);
  document.addEventListener('visibilitychange', () => { last = 0; draw(); });
  const tick = (now: number): void => {
    if (stage === 0 && !paused && visible && !document.hidden) {
      if (typeof recordClock?.currentTime === 'number') elapsed = Math.min(duration, recordClock.currentTime);
      else if (last) elapsed = Math.min(duration, elapsed + Math.min(now - last, 100));
      if (elapsed >= duration && pending !== 1) { void choose(1); }
    }
    last = now;
    draw();
    requestAnimationFrame(tick);
  };
  void choose(0);
  requestAnimationFrame(tick);
}
