/** Shared React player. Media events drive the projection; only active feedback owns timers. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
} from "lucide-react";
import { ControlTooltip } from "../components/control-tooltip";
import { TooltipProvider } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
import { Slider } from "../components/ui/slider";
import { VIDEO_TIMING, formatDuration } from "../../shared/video-player";
import { translate, type Language } from "../../shared/i18n";
import { playerKeyAction } from "../../shared/shortcut-catalog";
import { playbackOf } from "./player-state";
import { FramePeek, type FramePeekHandle } from "./frame-peek";

interface PlayerProps {
  id: string;
  source: string;
  title: string;
  language: Language;
  meta?: string;
  error?: string;
  trailing: ReactNode;
  close?: ReactNode;
  videoRef?: (video: HTMLVideoElement | null) => void;
  onError?: () => void;
  onPlay?: () => void;
  onDoubleClick: () => void;
  fullScreen: () => void;
  onMetadata?: (video: HTMLVideoElement) => void;
  /** The full-screen page's larger controls; `trailing` sizes its own button to match. */
  large?: boolean;
  /** Fetched with CORS, so its sound can go through Web Audio (the edit view's volumes, plan 087). */
  crossOrigin?: "anonymous";
  /**
   * The seek bar, play, volume and time along the picture's foot; the edit view leaves them out (2026-10-26, the
   * maintainer's choice): its timeline seeks, its toolbar plays, and nothing is drawn over the picture but its title.
   */
  controls?: boolean;
}
interface MediaView {
  playing: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
}
interface Flash {
  kind: "up" | "down" | "muted" | "play" | "pause";
  percent: string;
  bezel: boolean;
  text: boolean;
  /** A new flash restarts its animation even when the last one is still showing. */
  seq: number;
}
/** A seek's arrow, a filled triangle, as YouTube draws it. */
function SeekArrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5.5 17 12 7 18.5Z" />
    </svg>
  );
}
export function Player({
  id,
  source,
  title,
  language,
  meta,
  error,
  trailing,
  close,
  videoRef,
  onError,
  onPlay,
  onDoubleClick,
  fullScreen,
  onMetadata,
  large = false,
  crossOrigin,
  controls = true,
}: PlayerProps) {
  const video = useRef<HTMLVideoElement>(null),
    root = useRef<HTMLDivElement>(null),
    props = useRef({ onError, onPlay, onMetadata, fullScreen });
  props.current = { onError, onPlay, onMetadata, fullScreen };
  const [media, setMedia] = useState<MediaView>({
    playing: false,
    time: 0,
    duration: 0,
    volume: 1,
    muted: false,
  });
  const [idle, setIdle] = useState(false),
    [flash, setFlash] = useState<Flash | undefined>(undefined),
    [seekHint, setSeekHint] = useState<
      { side: "back" | "forward"; seconds: number; seq: number } | undefined
    >(undefined),
    flashes = useRef(0),
    // The frame at the moment the seek bar is pointed at, drawn above it while a mouse is on it.
    [peeking, setPeeking] = useState(false),
    peek = useRef<FramePeekHandle>(null),
    seekArea = useRef<HTMLDivElement>(null),
    pointerX = useRef(0),
    // Loading or buffering, as YouTube shows it (2026-10-25): a spinner in the middle while no picture is ready to show.
    [loading, setLoading] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    ),
    bezelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    textTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    scrubbing = useRef(false),
    scrubTime = useRef(0);
  const t = (
    key: "Play" | "Pause" | "Mute" | "Unmute" | "Volume" | "Playback position",
  ): string => translate(key, language);
  const sync = useCallback(() => {
    const el = video.current;
    if (!el) return;
    const duration = Number.isFinite(el.duration) ? el.duration : 0;
    const next = {
      playing: playbackOf(el).playing,
      time: Math.min(
        scrubbing.current ? scrubTime.current : el.currentTime || 0,
        duration,
      ),
      duration,
      volume: el.volume,
      muted: el.muted,
    };
    setMedia((previous) =>
      Object.keys(next).every(
        (key) =>
          previous[key as keyof MediaView] === next[key as keyof MediaView],
      )
        ? previous
        : next,
    );
  }, []);
  const rest = useCallback(() => {
    clearTimeout(idleTimer.current);
    if (
      video.current &&
      playbackOf(video.current).playing &&
      !root.current?.querySelector(
        ".pc-top:hover, .pc-bottom:hover, :focus-visible:not(video)",
      )
    )
      setIdle(true);
  }, []);
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    if (video.current && playbackOf(video.current).playing)
      idleTimer.current = setTimeout(rest, VIDEO_TIMING.idleMs);
  }, [rest]);
  const assignVideo = useCallback(
    (node: HTMLVideoElement | null) => {
      video.current = node;
      videoRef?.(node);
    },
    [videoRef],
  );
  useLayoutEffect(() => {
    const el = video.current;
    if (!el) return;
    const update = (event: Event): void => {
      flushSync(() => {
        sync();
        if (event.type === "pause" || event.type === "ended") wake();
      });
    };
    const types = [
      "play",
      "pause",
      "ended",
      "timeupdate",
      "durationchange",
      "loadedmetadata",
      "volumechange",
      "seeked",
      "emptied",
    ];
    for (const type of types) el.addEventListener(type, update);
    const metadata = (): void => props.current.onMetadata?.(el);
    const playing = (): void => {
      props.current.onPlay?.();
      wake();
    };
    const failed = (): void => props.current.onError?.();
    el.addEventListener("loadedmetadata", metadata);
    el.addEventListener("play", playing);
    el.addEventListener("error", failed);
    sync();
    return () => {
      for (const type of types) el.removeEventListener(type, update);
      el.removeEventListener("loadedmetadata", metadata);
      el.removeEventListener("play", playing);
      el.removeEventListener("error", failed);
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [sync, wake]);
  // The spinner: once the recording has had no picture to show for a quarter of a second (a fast load never shows it),
  // while it first loads, waits for data in playback, or seeks; gone as soon as a picture is ready.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let waiting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (event?: Event): void => {
      if (event?.type === "waiting") waiting = true;
      if (event && ["playing", "canplay", "seeked", "loadeddata", "emptied", "error"].includes(event.type)) waiting = false;
      const pending = Boolean(el.getAttribute("src")) && !el.error && (el.readyState < 2 || el.seeking || waiting);
      clearTimeout(timer);
      if (!pending) setLoading(false);
      else timer = setTimeout(() => setLoading(true), 250);
    };
    const types = ["loadstart", "waiting", "seeking", "seeked", "loadeddata", "canplay", "playing", "emptied", "error", "timeupdate"];
    for (const type of types) el.addEventListener(type, check);
    check();
    return () => {
      clearTimeout(timer);
      for (const type of types) el.removeEventListener(type, check);
    };
  }, [source]);
  // The frame picture is placed where the pointer came in, before it moves again, and once more when the recording's
  // length is known if the pointer came in before it was.
  useEffect(() => {
    const el = video.current;
    if (!peeking || !el) return;
    const place = (): void => point(pointerX.current);
    place();
    el.addEventListener("loadedmetadata", place);
    return () => el.removeEventListener("loadedmetadata", place);
  }, [peeking]);
  useEffect(
    () => () => {
      for (const timer of [idleTimer, bezelTimer, textTimer, seekTimer])
        clearTimeout(timer.current);
      video.current?.pause();
    },
    [],
  );
  /** Play or pause; from the picture or a key it also flashes what it did at the centre, as YouTube does. */
  const toggle = (feedback = false): void => {
    const el = video.current;
    if (!el) return;
    const playing = playbackOf(el).playing;
    if (playing) el.pause();
    else void el.play().catch(() => {});
    if (!feedback) return;
    clearTimeout(bezelTimer.current);
    clearTimeout(textTimer.current);
    setFlash({
      kind: playing ? "pause" : "play",
      percent: "",
      bezel: true,
      text: false,
      seq: ++flashes.current,
    });
    bezelTimer.current = setTimeout(() => setFlash(undefined), 500);
  };
  const mute = (): void => {
    const el = video.current;
    if (!el) return;
    if (el.muted || el.volume === 0) {
      el.muted = false;
      if (el.volume === 0) el.volume = 0.5;
    } else el.muted = true;
    sync();
  };
  const volumeTo = (value: number): void => {
    const el = video.current;
    if (!el) return;
    el.volume = value;
    el.muted = value === 0;
    sync();
  };
  const seekTo = (value: number): void => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.min(
      Math.max(0, value),
      Number.isFinite(el.duration) ? el.duration : Infinity,
    );
    sync();
  };
  const nudgeVolume = (by: number): void => {
    const el = video.current;
    if (!el) return;
    const value =
      Math.round(
        Math.min(1, Math.max(0, (el.muted ? 0 : el.volume) + by)) * 100,
      ) / 100;
    volumeTo(value);
    clearTimeout(bezelTimer.current);
    clearTimeout(textTimer.current);
    setFlash({
      kind: value === 0 ? "muted" : by > 0 ? "up" : "down",
      percent: `${Math.round(value * 100)}%`,
      bezel: true,
      text: true,
      seq: ++flashes.current,
    });
    bezelTimer.current = setTimeout(
      () => setFlash((state) => (state ? { ...state, bezel: false } : state)),
      500,
    );
    textTimer.current = setTimeout(() => setFlash(undefined), 800);
  };
  /** Flashes the side a key sought to, with the step it took (the shortcut catalog's, so the hint cannot differ). */
  const showSeek = (forward: boolean, seconds: number): void => {
    clearTimeout(seekTimer.current);
    setSeekHint({ side: forward ? "forward" : "back", seconds, seq: ++flashes.current });
    seekTimer.current = setTimeout(() => setSeekHint(undefined), 650);
  };
  const keydown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.defaultPrevented
    )
      return;
    const target = event.target as HTMLElement,
      el = video.current;
    if (!el) return;
    // The keys are the Keyboard Shortcuts tab's own (shortcut-catalog.ts), so the list and the player cannot differ.
    const action = playerKeyAction(event.key, {
      onButton: target instanceof HTMLButtonElement,
      onVolume: Boolean(target.closest(`#${id}-volume`)),
      onSeek: Boolean(target.closest(`#${id}-seek`)),
    });
    if (!action) return;
    if (action.kind === "toggle") toggle(true);
    else if (action.kind === "seekBy") {
      seekTo(el.currentTime + action.seconds);
      if (action.flash) showSeek(action.flash === "forward", Math.abs(action.seconds));
    } else if (action.kind === "volume") nudgeVolume(action.by);
    else if (action.kind === "seekTo")
      seekTo(action.to === "start" ? 0 : Number.isFinite(el.duration) ? el.duration : el.currentTime);
    else if (action.kind === "mute") mute();
    else props.current.fullScreen();
    event.preventDefault();
    event.stopPropagation();
    wake();
  };
  const point = (x: number): void => {
    pointerX.current = x;
    const el = video.current,
      box = seekArea.current?.getBoundingClientRect();
    if (!el || !box || box.width <= 0 || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const fraction = Math.min(1, Math.max(0, (x - box.left) / box.width));
    peek.current?.point(fraction, fraction * el.duration);
  };
  const silent = media.muted || media.volume === 0,
    percent = `${Math.round((silent ? 0 : media.volume) * 100)}%`,
    reading = `${formatDuration(media.time)} / ${formatDuration(media.duration)}`;
  const BezelIcon =
    flash?.kind === "play"
      ? Play
      : flash?.kind === "pause"
        ? Pause
        : flash?.kind === "muted"
          ? VolumeX
          : flash?.kind === "down"
            ? Volume1
            : Volume2;
  return (
    <TooltipProvider delay={600}>
      <div
        ref={root}
        className={`pc${media.playing ? "" : " pc-paused"}${idle ? " pc-idle" : ""}`}
        aria-busy={loading || undefined}
        onKeyDownCapture={keydown}
        onPointerMove={() => flushSync(wake)}
        onPointerDown={wake}
        onFocus={wake}
        onPointerLeave={rest}
      >
        <video
          ref={assignVideo}
          id={id === "video" ? "video" : undefined}
          src={source || undefined}
          crossOrigin={crossOrigin}
          playsInline
          disablePictureInPicture
          tabIndex={-1}
          onClick={() => toggle(true)}
          onDoubleClick={(event) => {
            event.preventDefault();
            onDoubleClick();
          }}
        />
        {/* Drawn only: assistive technology hears the player busy (aria-busy) instead of a second status or progress bar. */}
        <div className="pc-spinner" aria-hidden="true" hidden={!loading}>
          <span />
        </div>
        <div
          key={`bezel-${flash?.seq ?? 0}`}
          className="pc-bezel"
          data-kind={flash?.kind}
          aria-hidden="true"
          hidden={!flash?.bezel}
        >
          <BezelIcon />
        </div>
        <div
          key={`text-${flash?.seq ?? 0}`}
          className="pc-bezel-text"
          aria-hidden="true"
          hidden={!flash?.text}
        >
          {flash?.percent}
        </div>
        {(["back", "forward"] as const).map((side) => (
          <div
            key={`${side}-${seekHint?.side === side ? seekHint.seq : 0}`}
            className={`pc-seek-hint pc-seek-${side}`}
            aria-hidden="true"
            hidden={seekHint?.side !== side}
          >
            <div className="pc-seek-arrows">
              {[0, 1, 2].map((index) => (
                <span key={index} className="pc-seek-arrow">
                  <SeekArrow />
                </span>
              ))}
            </div>
            <div className="pc-seek-label">
              {side === "forward" ? "+" : "−"}
              {seekHint?.side === side && translate("{value} s", language, { value: seekHint.seconds })}
            </div>
          </div>
        ))}
        <div className="pc-top" hidden={!title}>
          <div className="flex gap-3 items-start">
            <div className="pc-heading-text">
              <p className="pc-title">{title}</p>
              <p className="pc-meta player-meta" hidden={!meta}>
                {meta}
              </p>
              <p className="pc-error player-error" hidden={!error}>
                {error}
              </p>
            </div>
            {close}
          </div>
        </div>
        <div className="pc-bottom" hidden={!controls}>
          <div
            ref={seekArea}
            className="pc-seek-area"
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse") return;
              pointerX.current = event.clientX;
              setPeeking(true);
            }}
            onPointerMove={(event) => {
              if (event.pointerType === "mouse") point(event.clientX);
            }}
            onPointerLeave={() => setPeeking(false)}
          >
          {peeking && source && <FramePeek ref={peek} source={source} />}
          <Slider
            id={`${id}-seek`}
            className="pc-seek"
            controlClassName="py-[var(--seek-padding)]"
            variant="seek"
            growOnHover
            value={[media.time]}
            min={0}
            max={media.duration || 1}
            step={0.1}
            thumbProps={{
              "aria-label": t("Playback position"),
              "aria-valuetext": reading,
            }}
            onPointerDownCapture={(event) => {
              if (event.button !== 0) return;
              // Start before the control's track press changes the value; bubbling here would overwrite its target.
              scrubbing.current = true;
              scrubTime.current = media.time;
            }}
            onPointerUp={() => {
              scrubbing.current = false;
              sync();
            }}
            onPointerCancel={() => {
              scrubbing.current = false;
              sync();
            }}
            onValueChange={(value) => {
              const time = Array.isArray(value) ? (value[0] ?? 0) : value;
              scrubTime.current = time;
              seekTo(time);
            }}
            onValueCommitted={() => {
              scrubbing.current = false;
              sync();
            }}
          />
          </div>
          <div className="pc-row">
            <ControlTooltip label={t(media.playing ? "Pause" : "Play")}>
              <Button
                variant="media"
                size={large ? "icon-xl" : "icon-media"}
                id={`${id}-play`}
                aria-label={t(media.playing ? "Pause" : "Play")}
                data-mark={media.playing ? "pause" : "play"}
                onClick={() => toggle()}
              >
                {media.playing ? <Pause /> : <Play />}
              </Button>
            </ControlTooltip>
            <div className="pc-volume group/volume">
              <ControlTooltip label={t(silent ? "Unmute" : "Mute")}>
                <Button
                  variant="media"
                  size={large ? "icon-xl" : "icon-media"}
                  id={`${id}-mute`}
                  aria-label={t(silent ? "Unmute" : "Mute")}
                  data-mark={silent ? "muted" : "volume"}
                  onClick={mute}
                >
                  {silent ? <VolumeX /> : <Volume2 />}
                </Button>
              </ControlTooltip>
              <Slider
                id={`${id}-volume`}
                className={
                  large
                    ? "pc-level data-[orientation=horizontal]:w-0 group-hover/volume:data-[orientation=horizontal]:w-[88px] group-focus-within/volume:data-[orientation=horizontal]:w-[88px]"
                    : "pc-level data-[orientation=horizontal]:w-0 group-hover/volume:data-[orientation=horizontal]:w-16 group-focus-within/volume:data-[orientation=horizontal]:w-16"
                }
                variant="media"
                thumbAlignment="center"
                min={0}
                max={1}
                step={0.05}
                value={[silent ? 0 : media.volume]}
                thumbProps={{
                  "aria-label": t("Volume"),
                  "aria-valuetext": percent,
                }}
                onValueChange={(value) =>
                  volumeTo(Array.isArray(value) ? (value[0] ?? 0) : value)
                }
              />
            </div>
            <span className="pc-time">{reading}</span>
            <span className="flex-1" />
            {trailing}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
