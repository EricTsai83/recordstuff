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
  ChevronRight,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Slider } from "../components/ui/slider";
import { VIDEO_TIMING, formatDuration } from "../../shared/video-player";
import { translate, type Language } from "../../shared/i18n";
import { playbackOf } from "./player-state";

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
}
interface MediaView {
  playing: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
}
interface Flash {
  kind: "up" | "down" | "muted";
  percent: string;
  bezel: boolean;
  text: boolean;
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
    [seekHint, setSeekHint] = useState<"back" | "forward" | undefined>(
      undefined,
    );
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
  useEffect(
    () => () => {
      for (const timer of [idleTimer, bezelTimer, textTimer, seekTimer])
        clearTimeout(timer.current);
      video.current?.pause();
    },
    [],
  );
  const toggle = (): void => {
    const el = video.current;
    if (el) {
      if (playbackOf(el).playing) el.pause();
      else void el.play().catch(() => {});
    }
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
    });
    bezelTimer.current = setTimeout(
      () => setFlash((state) => (state ? { ...state, bezel: false } : state)),
      500,
    );
    textTimer.current = setTimeout(() => setFlash(undefined), 800);
  };
  const showSeek = (forward: boolean): void => {
    clearTimeout(seekTimer.current);
    setSeekHint(forward ? "forward" : "back");
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
      key = event.key.length === 1 ? event.key.toLowerCase() : event.key,
      onButton = target instanceof HTMLButtonElement;
    const onVolume = Boolean(target.closest(`#${id}-volume`)),
      onSeek = Boolean(target.closest(`#${id}-seek`)),
      el = video.current;
    if (!el) return;
    if ((key === " " && !onButton) || key === "k") toggle();
    else if ((key === "ArrowLeft" || key === "ArrowRight") && !onVolume) {
      seekTo(el.currentTime + (key === "ArrowLeft" ? -5 : 5));
      showSeek(key === "ArrowRight");
    } else if ((key === "ArrowUp" || key === "ArrowDown") && !onVolume)
      nudgeVolume(key === "ArrowUp" ? 0.05 : -0.05);
    else if (onSeek && ["PageUp", "PageDown", "Home", "End"].includes(key))
      seekTo(
        key === "PageUp"
          ? el.currentTime + 10
          : key === "PageDown"
            ? el.currentTime - 10
            : key === "Home"
              ? 0
              : Number.isFinite(el.duration)
                ? el.duration
                : el.currentTime,
      );
    else if (key === "m") mute();
    else if (key === "f") props.current.fullScreen();
    else return;
    event.preventDefault();
    event.stopPropagation();
    wake();
  };
  const silent = media.muted || media.volume === 0,
    percent = `${Math.round((silent ? 0 : media.volume) * 100)}%`,
    reading = `${formatDuration(media.time)} / ${formatDuration(media.duration)}`;
  const BezelIcon =
    flash?.kind === "muted"
      ? VolumeX
      : flash?.kind === "down"
        ? Volume1
        : Volume2;
  return (
    <div
      ref={root}
      className={`pc${media.playing ? "" : " pc-paused"}${idle ? " pc-idle" : ""}`}
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
        playsInline
        disablePictureInPicture
        tabIndex={-1}
        onClick={toggle}
        onDoubleClick={(event) => {
          event.preventDefault();
          onDoubleClick();
        }}
      />
      <div
        className="pc-bezel"
        data-kind={flash?.kind}
        aria-hidden="true"
        hidden={!flash?.bezel}
      >
        <BezelIcon />
      </div>
      <div className="pc-bezel-text" aria-hidden="true" hidden={!flash?.text}>
        {flash?.percent}
      </div>
      {(["back", "forward"] as const).map((side) => (
        <div
          key={side}
          className={`pc-seek-hint pc-seek-${side}`}
          aria-hidden="true"
          hidden={seekHint !== side}
        >
          <div className="pc-seek-arrows">
            {[0, 1, 2].map((index) => (
              <span key={index} className="pc-seek-arrow">
                <ChevronRight />
              </span>
            ))}
          </div>
          <div className="pc-seek-label">
            {side === "forward" ? "+" : "−"}
            {translate("{value} s", language, { value: 5 })}
          </div>
        </div>
      ))}
      <div className="pc-top" hidden={!title}>
        <div className="pc-heading">
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
      <div className="pc-bottom">
        <Slider
          id={`${id}-seek`}
          className="pc-seek"
          value={[media.time]}
          min={0}
          max={media.duration || 1}
          step={0.1}
          thumbProps={{
            "aria-label": t("Playback position"),
            "aria-valuetext": reading,
          }}
          onPointerDown={() => {
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
        <div className="pc-row">
          <Button
            variant="media"
            size="icon"
            id={`${id}-play`}
            aria-label={t(media.playing ? "Pause" : "Play")}
            title={t(media.playing ? "Pause" : "Play")}
            data-mark={media.playing ? "pause" : "play"}
            onClick={toggle}
          >
            {media.playing ? <Pause /> : <Play />}
          </Button>
          <div className="pc-volume">
            <Button
              variant="media"
              size="icon"
              id={`${id}-mute`}
              aria-label={t(silent ? "Unmute" : "Mute")}
              title={t(silent ? "Unmute" : "Mute")}
              data-mark={silent ? "muted" : "volume"}
              onClick={mute}
            >
              {silent ? <VolumeX /> : <Volume2 />}
            </Button>
            <Slider
              id={`${id}-volume`}
              className="pc-level"
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
          <span className="pc-spacer" />
          {trailing}
        </div>
      </div>
    </div>
  );
}
