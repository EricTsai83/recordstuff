/**
 * The icons Settings rows and section headings carry, by group and section id, and the About links' marks.
 */
import { AppWindow, AudioLines, Bell, Camera, CircleAlert, Clapperboard, Circle, Compass, Scissors, Eye, EyeOff, FileText, Film, FlipHorizontal2, Folder, Gauge, Globe, HardDrive, Info, Keyboard, Maximize, Mic, Monitor, MousePointerClick, Move, MoveHorizontal, MoveVertical, Palette, PanelBottomDashed, PanelTopDashed, Play, Power, RefreshCw, ScreenShare, Settings2, SquareRoundCorner, Sun, Timer, Volume2, Wallpaper, Webcam } from "lucide-react";

const icons = {
  screen: Monitor,
  hideMenuBar: PanelTopDashed,
  hideDock: PanelBottomDashed,
  hideDesktop: Wallpaper,
  hideTaskbar: EyeOff,
  outputFolder: Folder,
  fileName: FileText,
  countdown: Timer,
  countdownSound: Volume2,
  microphone: Mic,
  microphoneDevice: AudioLines,
  microphoneLevel: Gauge,
  camera: Camera,
  cameraDevice: Webcam,
  cameraWidth: MoveHorizontal,
  cameraHeight: MoveVertical,
  cameraRounding: SquareRoundCorner,
  cameraMirror: FlipHorizontal2,
  cameraPreview: Move,
  studioCamera: Camera,
  cameraShown: Eye,
  systemAudio: Volume2,
  microphoneAudio: Mic,
  studioControls: Circle,
  videoQuality: Gauge,
  resolutionCap: Monitor,
  frameRate: Gauge,
  trayClick: Monitor,
  hotkey: Keyboard,
  notifications: Bell,
  language: Globe,
  appearance: Sun,
  updateChecks: Globe,
  updates: Globe,
  log: FileText,
  localData: CircleAlert,
  about: Info,
};
/** A settings section is named by its icon and heading; the sections have no order, so nothing numbers them. */
const sectionIcons = {
  source: ScreenShare,
  countdown: Timer,
  audio: Mic,
  camera: Camera,
  studioCamera: Camera,
  studioControls: Circle,
  studioAudio: AudioLines,
  video: Clapperboard,
  controls: MousePointerClick,
  display: Palette,
  storage: HardDrive,
  updates: RefreshCw,
  setup: Compass,
  "shortcutList:global": Globe,
  "shortcutList:window": AppWindow,
  "shortcutList:recordings": Film,
  "shortcutList:player": Play,
  "shortcutList:fullScreen": Maximize,
  "shortcutList:editor": Scissors,
};
export function SectionIcon({ id }: { id: string }) {
  const Icon = sectionIcons[id as keyof typeof sectionIcons];
  return Icon ? <Icon className="section-icon flex-none size-4 text-primary" aria-hidden="true" /> : null;
}

export function GroupIcon({ id }: { id: string }) {
  const Icon = icons[id as keyof typeof icons] ?? Settings2;
  return <Icon className="row-icon" aria-hidden="true" />;
}
export function ActionIcon({ id }: { id: string }) {
  if (id === "source") return (
    // The same GitHub mark as the website's GitHubMark.astro; Lucide's installed set has no brand icons.
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 007.86 10.93c.58.1.79-.25.79-.56v-2c-3.2.69-3.88-1.37-3.88-1.37-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.68 1.25 3.33.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.67 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.18a10.96 10.96 0 015.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.57.23 2.73.11 3.02.74.8 1.18 1.83 1.18 3.08 0 4.41-2.7 5.38-5.27 5.66.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0023.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
  const Icon = id === "quit" ? Power : Globe;
  return <Icon aria-hidden="true" />;
}
