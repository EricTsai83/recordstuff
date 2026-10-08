import { useCallback, useEffect, useRef } from "react";
import { Minimize } from "lucide-react";
import { Player } from "../player/player";
import { ControlTooltip } from "../components/control-tooltip";
import { Button } from "../components/ui/button";
import { documentLanguage, translate, isLanguage } from "../../shared/i18n";
import {
  VIDEO_QUERY,
  type PlaybackState,
  type VideoBridge,
} from "../../shared/video-player";
import { browserPlatform, isCloseChord } from "../lib/shortcut-capture";
import { playbackOf } from "../player/player-state";
import { useDarkClass } from "../lib/color-scheme";

declare global {
  interface Window {
    video?: VideoBridge;
  }
}
export function VideoApp() {
  const query = useRef(new URLSearchParams(location.search)).current,
    queried = query.get(VIDEO_QUERY.language),
    language = isLanguage(queried) ? queried : "en";
  const video = useRef<HTMLVideoElement | null>(null),
    ready = useRef(false),
    left = useRef(false),
    frames = useRef<number[]>([]),
    listeners = useRef<Array<() => void>>([]);
  const number = (key: string, fallback: number): number => {
    const raw = query.get(key)?.trim(),
      value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : fallback;
  };
  useDarkClass();
  const start = useRef<PlaybackState>({
    time: Math.max(0, number(VIDEO_QUERY.time, 0)),
    playing: query.get(VIDEO_QUERY.playing) === "1",
    volume: Math.min(1, Math.max(0, number(VIDEO_QUERY.volume, 1))),
    muted: query.get(VIDEO_QUERY.muted) === "1",
  }).current;
  const sayReady = useCallback(() => {
    if (ready.current) return;
    ready.current = true;
    window.video?.ready();
    if (start.playing && !left.current)
      void video.current?.play().catch(() => {});
    video.current?.focus({ preventScroll: true });
  }, [start]);
  const drawn = useCallback(() => {
    frames.current.push(
      requestAnimationFrame(() => {
        frames.current.push(requestAnimationFrame(sayReady));
      }),
    );
  }, [sayReady]);
  const metadata = useCallback(
    (element: HTMLVideoElement) => {
      const listen = (type: string): void => {
        element.addEventListener(type, drawn, { once: true });
        listeners.current.push(() => element.removeEventListener(type, drawn));
      };
      if (start.time > 0 && start.time < element.duration) {
        listen("seeked");
        element.currentTime = start.time;
      } else if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
        drawn();
      else listen("loadeddata");
    },
    [drawn, start],
  );
  const assign = useCallback(
    (element: HTMLVideoElement | null) => {
      video.current = element;
      if (element) {
        element.volume = start.volume;
        element.muted = start.muted;
      }
    },
    [start],
  );
  const leave = useCallback(() => {
    const element = video.current;
    if (left.current || !element) return;
    left.current = true;
    // Left before the recording's length was known (shown after the ready timeout, or a file that will not load): the
    // start position was never applied, so the player gets back where it came from instead of 0:00, paused.
    const state =
      element.readyState >= HTMLMediaElement.HAVE_METADATA
        ? playbackOf(element)
        : { ...start, volume: element.volume, muted: element.muted };
    element.pause();
    window.video?.exit(state);
  }, [start]);
  useEffect(() => {
    document.documentElement.lang = documentLanguage(language);
    document.documentElement.dataset.surface = "video";
    const keys = (event: KeyboardEvent): void => {
      if (
        (event.key === "Escape" && !event.repeat) ||
        isCloseChord(event, browserPlatform())
      ) {
        event.preventDefault();
        leave();
      }
      if (event.key === "Tab")
        document.documentElement.dataset.input = "keyboard";
    };
    const pointer = (): void => {
      delete document.documentElement.dataset.input;
    };
    document.addEventListener("keydown", keys);
    document.addEventListener("pointerdown", pointer);
    return () => {
      document.removeEventListener("keydown", keys);
      document.removeEventListener("pointerdown", pointer);
      for (const frame of frames.current) cancelAnimationFrame(frame);
      for (const cleanup of listeners.current) cleanup();
      video.current?.pause();
    };
  }, [language, leave]);
  const label = translate("Exit full screen", language);
  return (
    <Player
      id="video"
      source={query.get(VIDEO_QUERY.src) ?? ""}
      title={query.get(VIDEO_QUERY.title) ?? ""}
      language={language}
      videoRef={assign}
      onError={sayReady}
      onMetadata={metadata}
      onDoubleClick={leave}
      fullScreen={leave}
      large
      trailing={
        <ControlTooltip label={label}>
          <Button
            variant="media"
            size="icon-xl"
            id="exit"
            aria-label={label}
            onClick={leave}
          >
            <Minimize />
          </Button>
        </ControlTooltip>
      }
    />
  );
}
