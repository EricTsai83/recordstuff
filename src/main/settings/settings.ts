/**
 * Persistent preferences: output folder, recording display, hiding the menu bar and Dock from it, quality, countdown
 * and its tick, shortcut, the menu bar icon's left click, notifications, update
 * checks, language and appearance, the recordings' file name pattern and the Recordings tab's layout.
 * See docs/system-design/desktop.md for the schema and reset rules.
 * Writes replace the file atomically (`writeFileAtomic`), so a crash or power
 * loss mid-write leaves the previous file. Any read problem falls back to the
 * default and logs; a file that exists but cannot be used (unreadable, broken,
 * or from a newer version) is kept as `settings.json.unreadable` (then `.1`,
 * `.2`… when that name is taken) before the first write, so a later save never
 * replaces the user's choices with defaults.
 *
 * Only the current format is read. An older numeric version starts with all
 * defaults and is rewritten once at startup, keeping the original under
 * `.reset-backup`. Failed writes retain the original and retry on launch or
 * the next save. Newer formats are never overwritten.
 * Missing or invalid fields within the current format use their defaults.
 */
import { isAppearance, isLibraryLayout, isTrayClick, type Appearance, type LibraryLayout, type TrayClick } from "../../shared/appearance";
import { DEFAULT_FILE_NAME_TEMPLATE, canonicalFileNameTemplate } from "../../shared/file-name";
import { DEFAULT_DISPLAY_PREFERENCE, isDisplayPreference, type DisplayPreference } from "../../shared/display";
import { DEFAULT_CAMERA_LAYOUT, copyCameraLayout, isCameraLayout, isCameraPosition, isDisplayKey, withPosition, type CameraLayout, type CameraPosition } from "../../shared/camera-layout";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_QUALITY, isQualitySettings, type QualitySettings } from "../../shared/quality";
import { DEFAULT_STUDIO_PREVIEW, isStudioPreviewRate, isStudioPreviewSettings, isStudioView, type StudioPreviewSettings } from "../../shared/studio-port";
import { DEFAULT_COUNTDOWN, DEFAULT_COUNTDOWN_SOUND, isCountdownSeconds, type CountdownSeconds } from "../../shared/countdown";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "../../shared/i18n";
import { DEFAULT_AUDIO_VOLUME, isAudioVolume, isLegacyGain, isVolume, volumeFromDb, type AudioVolume } from "../../shared/audio-volume";
import { DEFAULT_HOTKEY, canonicalHotkeySettings, type HotkeySettings } from "../../shared/hotkey";
import { stableVersion } from "../../shared/version";
import { keepFile } from "../lib/file-backup";
import { writeFileAtomic } from "../lib/atomic-file";
import { SerialQueue } from "../lib/serial-queue";
import { errnoCode } from "../lib/errors";

export const SETTINGS_VERSION = 4;
/** Names tried for keeping an unusable file aside: `.unreadable`, then `.unreadable.1` and on. */
export const KEPT_UNUSABLE_NAMES = 100;

/** Only a published stable version can have been announced. */
function isNotifiedVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && stableVersion(value) !== undefined;
}
/** When an update check was last attempted, in epoch milliseconds; read from the file and accepted by `setUpdates` alike. */
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The settings that are on or off, each saved through `setSwitch`. */
type SwitchSetting = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings];

export interface Settings {
  version: typeof SETTINGS_VERSION;
  outputDir: string;
  quality: QualitySettings;
  language: Language;
  appearance: Appearance;
  hotkey: HotkeySettings;
  /** `notifiedVersion`: the newest version the user was told about, so a launch announces each version once. */
  updates: { enabled: boolean; lastAttempt: number; notifiedVersion?: string };
  /** Whether the app sends any notification at all; the OS permission is separate. */
  notifications: boolean;
  display: DisplayPreference;
  /** Whether macOS recordings leave out the menu bar, the Dock, desktop icons and widgets (plan 076, D6); off by default. */
  hideSystemUi: boolean;
  /**
   * Whether macOS recordings are editable (plan 087): the screen, each sound and the camera on tracks of their own, so
   * the camera's place and the volumes are chosen after recording and an export renders them; off by default.
   */
  editableRecording: boolean;
  /** Seconds before capture begins; 0 is Off (plan 040). */
  countdown: CountdownSeconds;
  /** A tick with each countdown digit (plan 046); kept while the countdown is Off. */
  countdownSound: boolean;
  /**
   * Mix the microphone into the recording's track (plan 074). On by default since 2026-10-26 (the maintainer's decision),
   * turned off when macOS refuses it (input-access.ts); a settings file saves every field, so this reaches new installs only.
   */
  microphone: boolean;
  /** The chosen input, by the id the engine listed and the name it had then; absent is the system default input. */
  microphoneDevice?: MicrophoneDevicePreference;
  /** System audio's and the microphone's volumes in percent (plan 075, D21; audio-volume.ts); 100 leaves them as they are. */
  audioVolume: AudioVolume;
  /** Compose the camera into recordings (plan 075, D10); on by default and turned off when refused, as the microphone. */
  camera: boolean;
  /** The camera bubble's size, rounding, mirror and position on each display (plan 075, D1–D3, D8; camera-layout.ts). */
  cameraLayout: CameraLayout;
  /** The chosen camera, as the microphone's (D9); absent is the system default camera. */
  cameraDevice?: CameraDevicePreference;
  /** The Recording Studio's preview rate and view (plan 092, D1, D3); Off by default, so opening the Studio costs nothing. */
  studioPreview: StudioPreviewSettings;
  /** The icon's left click. */
  trayClick: TrayClick;
  /** How new recordings are named (file-name.ts); the default gives the names every recording had before the choice. */
  fileNameTemplate: string;
  /** The Recordings tab's grid or list. */
  libraryLayout: LibraryLayout;
  /** Whether a grid card's hover preview plays its sound; off until the card's speaker turns it on (2026-10-14). */
  libraryPreviewSound: boolean;
  /** Categories (the output folder's subfolders, by name) the selector lists first as favorites (2026-10-09). */
  libraryFavorites: string[];
  /** The category the tab last showed (2026-10-09): absent for every recording, `null` for Uncategorized. */
  libraryShown?: string | null;
  /**
   * The first-launch guide was finished or set aside (2026-10-26): a new install starts without it, so the guide opens;
   * a file written before the guide existed reads as done, so no existing user meets it.
   */
  onboardingDone: boolean;
}

interface MicrophoneDevicePreference {
  id: string;
  label: string;
}

/** A stored input: a non-empty id within a bound, and the name shown while it is not connected. */
function isMicrophoneDevicePreference(value: unknown): value is MicrophoneDevicePreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { id, label } = value as Record<string, unknown>;
  return typeof id === "string" && id.length > 0 && id.length <= 512 && typeof label === "string" && label.length <= 512;
}

/** A camera chosen by its unique ID and the name it had then (plan 075, D9), stored as a microphone is. */
type CameraDevicePreference = MicrophoneDevicePreference;
const isCameraDevicePreference = isMicrophoneDevicePreference;

export interface SettingsStoreOptions {
  filePath: string;
  defaultOutputDir: string;
  log?: (message: string) => void;
  /** Which combinations a saved shortcut may use; tests pin it. */
  platform?: NodeJS.Platform;
}

export interface ParsedSettings {
  settings: Settings;
  /** Fields that were missing or invalid and replaced by defaults. */
  warnings: string[];
}

/** Every default in one place: a fresh or unreadable file, and each field a file lacks or spoils. */
export function defaultSettings(outputDir: string): Settings {
  return {
    version: SETTINGS_VERSION,
    outputDir,
    quality: DEFAULT_QUALITY,
    language: DEFAULT_LANGUAGE,
    appearance: "system",
    hotkey: DEFAULT_HOTKEY,
    updates: { enabled: true, lastAttempt: 0 },
    notifications: true,
    display: DEFAULT_DISPLAY_PREFERENCE,
    // Off: an update must not change what existing recordings show, and what is on screen is what users expect.
    hideSystemUi: false,
    // Off: an ordinary recording plays everywhere as it was recorded; an editable one needs an export first.
    editableRecording: false,
    countdown: DEFAULT_COUNTDOWN,
    countdownSound: DEFAULT_COUNTDOWN_SOUND,
    microphone: true,
    audioVolume: { ...DEFAULT_AUDIO_VOLUME },
    camera: true,
    cameraLayout: copyCameraLayout(DEFAULT_CAMERA_LAYOUT),
    studioPreview: { ...DEFAULT_STUDIO_PREVIEW },
    // A new install opens the menu, as menu bar icons do; recording is one choice away or on the shortcut.
    trayClick: "menu",
    fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
    libraryLayout: "grid",
    libraryPreviewSound: false,
    libraryFavorites: [],
    onboardingDone: false,
  };
}

/** How many favorites are kept: far more than a selector's first group shows, and a bound on a hand-edited file. */
const MAX_LIBRARY_FAVORITES = 200;
/**
 * A category name as stored: any name the library could list (review F3), however it was made, which is looser than the
 * rules a new or renamed category follows (file-name.ts `folderNameProblem`): one path segment, not hidden, within a
 * file name's 255 bytes. Whether it is listed now is checked where it is used.
 */
const isCategoryName = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  !/[/\\\u0000]/.test(value) && !value.startsWith(".") && new TextEncoder().encode(value).length <= 255;
const isFavorites = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_LIBRARY_FAVORITES &&
  value.every(isCategoryName) && new Set(value).size === value.length;
const isShown = (value: unknown): value is string | null => value === null || isCategoryName(value);

/**
 * `undefined` when the file as a whole is unusable (not an object, unknown
 * version, bad outputDir). A bad `quality` block alone keeps the outputDir
 * and reports a warning: the user's folder choice must survive a broken
 * quality field.
 */
export function parseSettings(text: string, platform: NodeJS.Platform = process.platform): ParsedSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  if (version !== SETTINGS_VERSION) return undefined;
  const outputDir = record["outputDir"];
  if (typeof outputDir !== "string" || outputDir.length === 0 || !path.isAbsolute(outputDir)) {
    return undefined;
  }
  const warnings: string[] = [];
  /** A missing value falls back silently; a present but unsupported one also warns. */
  const field = <T>(key: string, valid: (value: unknown) => value is T, fallback: T, warning: string, source: Record<string, unknown> = record): T => {
    const value = source[key];
    if (valid(value)) return value;
    if (value !== undefined) warnings.push(warning);
    return fallback;
  };
  const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
  let quality: QualitySettings = DEFAULT_QUALITY;
  if (isQualitySettings(record["quality"])) {
    quality = {
      videoQuality: record["quality"].videoQuality,
      resolutionCap: record["quality"].resolutionCap,
      frameRate: record["quality"].frameRate,
    };
  } else {
    warnings.push("quality is missing or has unsupported values: using defaults");
  }
  const defaults = defaultSettings(outputDir);
  const appearance = field("appearance", isAppearance, defaults.appearance, `appearance is unsupported: using ${defaults.appearance}`);
  const language = field("language", isLanguage, DEFAULT_LANGUAGE, "language is unsupported: using English");
  let hotkey: HotkeySettings = DEFAULT_HOTKEY;
  const storedHotkey = canonicalHotkeySettings(record["hotkey"], platform);
  if (storedHotkey) {
    hotkey = storedHotkey;
  } else {
    warnings.push("hotkey is missing or has unsupported values: using the default shortcut");
  }
  const rawUpdates = record["updates"];
  const isRecord = typeof rawUpdates === "object" && rawUpdates !== null && !Array.isArray(rawUpdates);
  if (rawUpdates !== undefined && !isRecord) warnings.push("updates is not an object: using defaults");
  const u = isRecord ? rawUpdates as Record<string, unknown> : {};
  const updates = {
    enabled: field("enabled", isBoolean, defaults.updates.enabled, `updates.enabled is not a boolean: using ${defaults.updates.enabled ? "on" : "off"}`, u),
    lastAttempt: field("lastAttempt", isTimestamp, defaults.updates.lastAttempt, `updates.lastAttempt is invalid: using ${defaults.updates.lastAttempt}`, u),
  };
  const notifiedVersion = field<string | undefined>("notifiedVersion", isNotifiedVersion, undefined, "updates.notifiedVersion is invalid: announcing the next newer version", u);
  const notifications = field("notifications", isBoolean, defaults.notifications, `notifications is not a boolean: using ${defaults.notifications ? "on" : "off"}`);
  const display = field("display", isDisplayPreference, DEFAULT_DISPLAY_PREFERENCE, "display is invalid: using primary display");
  const hideSystemUi = field("hideSystemUi", isBoolean, defaults.hideSystemUi, `hideSystemUi is not a boolean: using ${defaults.hideSystemUi ? "on" : "off"}`);
  const editableRecording = field("editableRecording", isBoolean, defaults.editableRecording, `editableRecording is not a boolean: using ${defaults.editableRecording ? "on" : "off"}`);
  const countdown = field("countdown", isCountdownSeconds, DEFAULT_COUNTDOWN, `countdown is unsupported: using ${DEFAULT_COUNTDOWN} seconds`);
  const countdownSound = field("countdownSound", isBoolean, DEFAULT_COUNTDOWN_SOUND, `countdownSound is not a boolean: using ${DEFAULT_COUNTDOWN_SOUND ? "on" : "off"}`);
  const microphone = field("microphone", isBoolean, defaults.microphone, `microphone is not a boolean: using ${defaults.microphone ? "on" : "off"}`);
  const microphoneDevice = field<MicrophoneDevicePreference | undefined>("microphoneDevice", isMicrophoneDevicePreference, undefined,
    "microphoneDevice is invalid: using the system default input");
  // Saved in whole dB as `audioGain` before 2026-10-21: taken as the nearest percent, and saved so from the next save on.
  const legacyGain = record["audioVolume"] === undefined && isLegacyGain(record["audioGain"]) ? record["audioGain"] : undefined;
  const audioVolume = legacyGain ? { system: volumeFromDb(legacyGain.system), microphone: volumeFromDb(legacyGain.microphone) }
    : field("audioVolume", isAudioVolume, defaults.audioVolume, "audioVolume is invalid: using 100% for both inputs");
  const camera = field("camera", isBoolean, defaults.camera, `camera is not a boolean: using ${defaults.camera ? "on" : "off"}`);
  const cameraLayout = field("cameraLayout", isCameraLayout, defaults.cameraLayout, "cameraLayout is invalid: using the default bubble");
  const cameraDevice = field<CameraDevicePreference | undefined>("cameraDevice", isCameraDevicePreference, undefined, "cameraDevice is invalid: using the system default camera");
  // Off was a rate until 2026-10-25 (Live preview is now the picture's one switch): read as Power saving, without a warning.
  const storedPreview = record["studioPreview"] as { rate?: unknown; view?: unknown } | undefined;
  if (storedPreview && typeof storedPreview === "object" && storedPreview.rate === "off") record["studioPreview"] = { ...storedPreview, rate: "power" };
  // Screen only was a view until plan 097 (2026-10-27): read as the composed picture, without a warning.
  const migratedPreview = record["studioPreview"] as { view?: unknown } | undefined;
  if (migratedPreview && typeof migratedPreview === "object" && migratedPreview.view === "screen") record["studioPreview"] = { ...migratedPreview, view: "composed" };
  const studioPreview = field("studioPreview", isStudioPreviewSettings, defaults.studioPreview, "studioPreview is invalid: using Power saving and the recorded picture");
  const trayClick = field("trayClick", isTrayClick, defaults.trayClick, `trayClick is unsupported: using ${defaults.trayClick}`);
  // Only a pattern stored as it would be saved: trimmed and usable.
  const isTemplate = (value: unknown): value is string => typeof value === "string" && canonicalFileNameTemplate(value) === value;
  const fileNameTemplate = field("fileNameTemplate", isTemplate, defaults.fileNameTemplate, `fileNameTemplate is unsupported: using ${defaults.fileNameTemplate}`);
  const libraryLayout = field("libraryLayout", isLibraryLayout, defaults.libraryLayout, `libraryLayout is unsupported: using ${defaults.libraryLayout}`);
  const libraryPreviewSound = field("libraryPreviewSound", isBoolean, defaults.libraryPreviewSound, `libraryPreviewSound is not a boolean: using ${defaults.libraryPreviewSound ? "on" : "off"}`);
  const libraryFavorites = field("libraryFavorites", isFavorites, defaults.libraryFavorites, "libraryFavorites is invalid: using none");
  const libraryShown = field<string | null | undefined>("libraryShown", isShown, undefined, "libraryShown is invalid: showing every recording");
  // Absent in every file written before the guide: done, so only a new install, which has no file, sees it.
  const onboardingDone = field("onboardingDone", isBoolean, true, "onboardingDone is not a boolean: the guide stays closed");
  return { settings: { appearance, display, hideSystemUi, editableRecording, version: SETTINGS_VERSION, outputDir, quality, language, hotkey,
    updates: notifiedVersion === undefined ? updates : { ...updates, notifiedVersion }, notifications, countdown, countdownSound,
    microphone, ...(microphoneDevice === undefined ? {} : { microphoneDevice: { id: microphoneDevice.id, label: microphoneDevice.label } }),
    audioVolume: { system: audioVolume.system, microphone: audioVolume.microphone },
    camera, cameraLayout: copyCameraLayout(cameraLayout), ...(cameraDevice === undefined ? {} : { cameraDevice: { id: cameraDevice.id, label: cameraDevice.label } }),
    studioPreview: { rate: studioPreview.rate, view: studioPreview.view }, trayClick,
    fileNameTemplate, libraryLayout, libraryPreviewSound, libraryFavorites, ...(libraryShown === undefined ? {} : { libraryShown }), onboardingDone }, warnings };
}

export class SettingsStore {
  private settings: Settings;
  /** Writes are serialized: each next value is built from the last committed one (review F2). */
  private readonly queue = new SerialQueue();
  private readonly filePath: string;
  private readonly log: (message: string) => void;
  private readonly platform: NodeJS.Platform;
  /** The folder a fresh or unreadable file falls back to; the one folder opening may create (plan 033). */
  readonly defaultOutputDir: string;
  /** The file on disk exists but could not be used; the first write moves it aside instead of replacing it. */
  private unusableOnDisk = false;
  private newerOnDisk = false;
  private resetPending = false;
  private resetBackedUp = false;

  constructor(options: SettingsStoreOptions) {
    this.filePath = options.filePath;
    this.log = options.log ?? (() => undefined);
    this.platform = options.platform ?? process.platform;
    this.defaultOutputDir = options.defaultOutputDir;
    this.settings = this.load(options.defaultOutputDir);
  }

  /** Startup only: use the same queue as edits, and never manufacture a file for a fresh install. */
  async resetOlderFormat(): Promise<void> {
    if (this.resetPending) await this.save(current => current);
  }

  get display(): DisplayPreference { return { ...this.settings.display }; }

  setDisplay(display: DisplayPreference): Promise<void> {
    if (!isDisplayPreference(display)) return Promise.reject(new Error("invalid display preference"));
    const snapshot = { ...display };
    return this.save((current) => ({ ...current, display: snapshot }));
  }

  get hideSystemUi(): boolean { return this.settings.hideSystemUi; }

  setHideSystemUi(enabled: boolean): Promise<void> {
    return this.setSwitch("hideSystemUi", enabled, "hide system UI");
  }

  get editableRecording(): boolean { return this.settings.editableRecording; }

  setEditableRecording(enabled: boolean): Promise<void> {
    return this.setSwitch("editableRecording", enabled, "editable recording");
  }

  get outputDir(): string {
    return this.settings.outputDir;
  }

  get quality(): QualitySettings {
    return { ...this.settings.quality };
  }

  get countdown(): CountdownSeconds { return this.settings.countdown; }

  setCountdown(countdown: CountdownSeconds): Promise<void> {
    if (!isCountdownSeconds(countdown)) return Promise.reject(new Error(`unsupported countdown: ${JSON.stringify(countdown)}`));
    return this.save((current) => ({ ...current, countdown }));
  }

  get countdownSound(): boolean { return this.settings.countdownSound; }

  setCountdownSound(enabled: boolean): Promise<void> {
    return this.setSwitch("countdownSound", enabled, "countdown sound");
  }

  get microphone(): boolean { return this.settings.microphone; }

  setMicrophone(enabled: boolean): Promise<void> {
    return this.setSwitch("microphone", enabled, "microphone");
  }

  get microphoneDevice(): MicrophoneDevicePreference | undefined {
    const device = this.settings.microphoneDevice;
    return device ? { ...device } : undefined;
  }

  /** `null` is the system default input. */
  setMicrophoneDevice(device: MicrophoneDevicePreference | null): Promise<void> {
    if (device !== null && !isMicrophoneDevicePreference(device)) return Promise.reject(new Error(`unsupported microphone device: ${JSON.stringify(device)}`));
    const snapshot = device === null ? undefined : { id: device.id, label: device.label };
    return this.save(({ microphoneDevice: _previous, ...current }) => (snapshot ? { ...current, microphoneDevice: snapshot } : current));
  }

  get audioVolume(): AudioVolume { return { ...this.settings.audioVolume }; }

  /** One input's volume (D21), in whole percent within the fader's range. */
  setAudioVolume(source: keyof AudioVolume, volume: number): Promise<void> {
    if ((source !== "system" && source !== "microphone") || !isVolume(volume)) return Promise.reject(new Error(`unsupported audio volume: ${JSON.stringify({ source, volume })}`));
    return this.save((current) => ({ ...current, audioVolume: { ...current.audioVolume, [source]: volume } }));
  }

  get camera(): boolean { return this.settings.camera; }

  setCamera(enabled: boolean): Promise<void> {
    return this.setSwitch("camera", enabled, "camera");
  }

  get cameraLayout(): CameraLayout { return copyCameraLayout(this.settings.cameraLayout); }

  /** The bubble's size, rounding and mirror; its positions are `setCameraPosition`'s. */
  setCameraLayout(layout: Omit<CameraLayout, "positions">): Promise<void> {
    const candidate = { ...layout, positions: [] };
    if (!isCameraLayout(candidate)) return Promise.reject(new Error(`unsupported camera layout: ${JSON.stringify(layout)}`));
    const { width, height, rounding, mirror } = candidate;
    return this.save((current) => ({ ...current, cameraLayout: { ...copyCameraLayout(current.cameraLayout), width, height, rounding, mirror } }));
  }

  /** Where the bubble is on the display `displayKey` names (a display id, or PRIMARY_DISPLAY_KEY). */
  setCameraPosition(displayKey: string, position: CameraPosition): Promise<void> {
    if (!isDisplayKey(displayKey) || !isCameraPosition(position)) {
      return Promise.reject(new Error(`unsupported camera position: ${JSON.stringify({ displayKey, position })}`));
    }
    const snapshot = { x: position.x, y: position.y };
    return this.save((current) => ({ ...current, cameraLayout: withPosition(current.cameraLayout, displayKey, snapshot) }));
  }

  get cameraDevice(): CameraDevicePreference | undefined {
    const device = this.settings.cameraDevice;
    return device ? { ...device } : undefined;
  }

  /** `null` is the system default camera. */
  setCameraDevice(device: CameraDevicePreference | null): Promise<void> {
    if (device !== null && !isCameraDevicePreference(device)) return Promise.reject(new Error(`unsupported camera device: ${JSON.stringify(device)}`));
    const snapshot = device === null ? undefined : { id: device.id, label: device.label };
    return this.save(({ cameraDevice: _previous, ...current }) => (snapshot ? { ...current, cameraDevice: snapshot } : current));
  }

  get trayClick(): TrayClick { return this.settings.trayClick; }

  setTrayClick(trayClick: TrayClick): Promise<void> {
    if (!isTrayClick(trayClick)) return Promise.reject(new Error(`unsupported tray click: ${JSON.stringify(trayClick)}`));
    return this.save((current) => ({ ...current, trayClick }));
  }

  get fileNameTemplate(): string { return this.settings.fileNameTemplate; }

  setFileNameTemplate(template: string): Promise<void> {
    const canonical = canonicalFileNameTemplate(template);
    if (canonical === undefined) return Promise.reject(new Error(`unsupported file name template: ${JSON.stringify(template)}`));
    return this.save((current) => ({ ...current, fileNameTemplate: canonical }));
  }

  get libraryLayout(): LibraryLayout { return this.settings.libraryLayout; }

  setLibraryLayout(libraryLayout: LibraryLayout): Promise<void> {
    if (!isLibraryLayout(libraryLayout)) return Promise.reject(new Error(`unsupported library layout: ${JSON.stringify(libraryLayout)}`));
    return this.save((current) => ({ ...current, libraryLayout }));
  }

  get studioPreview(): StudioPreviewSettings { return { ...this.settings.studioPreview }; }

  /** The Studio's preview rate or view (plan 092). */
  setStudioPreview(change: { rate?: unknown; view?: unknown }): Promise<void> {
    if ((change.rate !== undefined && !isStudioPreviewRate(change.rate)) || (change.view !== undefined && !isStudioView(change.view)) || (change.rate === undefined && change.view === undefined)) {
      return Promise.reject(new Error(`unsupported Studio preview: ${JSON.stringify(change)}`));
    }
    const { rate, view } = change as { rate?: StudioPreviewSettings["rate"]; view?: StudioPreviewSettings["view"] };
    return this.save((current) => ({ ...current, studioPreview: {
      rate: rate ?? current.studioPreview.rate,
      view: view ?? current.studioPreview.view,
    } }));
  }

  get libraryPreviewSound(): boolean { return this.settings.libraryPreviewSound; }

  get onboardingDone(): boolean { return this.settings.onboardingDone; }

  setOnboardingDone(done: boolean): Promise<void> {
    return this.setSwitch("onboardingDone", done, "onboarding state");
  }

  setLibraryPreviewSound(enabled: boolean): Promise<void> {
    return this.setSwitch("libraryPreviewSound", enabled, "preview sound");
  }

  get libraryFavorites(): string[] { return [...this.settings.libraryFavorites]; }

  /** Adds or removes one favorite category; the order is the order they were added in. */
  setLibraryFavorite(name: string, favorite: boolean): Promise<void> {
    if (!isCategoryName(name)) return Promise.reject(new Error(`unsupported category: ${JSON.stringify(name)}`));
    return this.save((current) => {
      const rest = current.libraryFavorites.filter(entry => entry !== name);
      return { ...current, libraryFavorites: favorite ? [...rest, name].slice(-MAX_LIBRARY_FAVORITES) : rest };
    });
  }

  get libraryShown(): string | null | undefined { return this.settings.libraryShown; }

  /** The category the tab shows now: `undefined` for every recording, `null` for Uncategorized. */
  setLibraryShown(shown: string | null | undefined): Promise<void> {
    if (shown !== undefined && !isShown(shown)) return Promise.reject(new Error(`unsupported category: ${JSON.stringify(shown)}`));
    return this.save(({ libraryShown: _, ...current }) => (shown === undefined ? current : { ...current, libraryShown: shown }));
  }

  /** A category renamed in the app keeps its favorite and stays shown under its new name. */
  renameLibraryCategory(from: string, to: string): Promise<void> {
    if (!isCategoryName(to)) return Promise.reject(new Error(`unsupported category: ${JSON.stringify(to)}`));
    return this.save((current) => ({
      ...current,
      libraryFavorites: current.libraryFavorites.map(entry => entry === from ? to : entry).filter((entry, index, all) => all.indexOf(entry) === index),
      ...(current.libraryShown === from ? { libraryShown: to } : {}),
    }));
  }

  /** A category deleted in the app is no longer a favorite, nor the one shown. */
  forgetLibraryCategory(name: string): Promise<void> {
    return this.save(({ libraryShown, ...current }) => ({
      ...current,
      libraryFavorites: current.libraryFavorites.filter(entry => entry !== name),
      ...(libraryShown === undefined || libraryShown === name ? {} : { libraryShown }),
    }));
  }

  get appearance(): Appearance { return this.settings.appearance; }

  setAppearance(appearance: Appearance): Promise<void> {
    if (!isAppearance(appearance)) return Promise.reject(new Error("unsupported appearance"));
    return this.save(current => ({ ...current, appearance }));
  }

  get language(): Language {
    return this.settings.language;
  }

  get updates(): Settings["updates"] { return { ...this.settings.updates }; }

  setUpdates(patch: Partial<Settings["updates"]>): Promise<void> {
    patch = { ...patch };
    if ((patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
        (patch.lastAttempt !== undefined && !isTimestamp(patch.lastAttempt)) ||
        (patch.notifiedVersion !== undefined && !isNotifiedVersion(patch.notifiedVersion))) {
      return Promise.reject(new Error(`unsupported updates setting: ${JSON.stringify(patch)}`));
    }
    return this.save((current) => ({ ...current, updates: { ...current.updates, ...patch } }));
  }

  get notifications(): boolean { return this.settings.notifications; }

  setNotifications(enabled: boolean): Promise<void> {
    return this.setSwitch("notifications", enabled, "notifications setting");
  }

  get hotkey(): HotkeySettings {
    return { ...this.settings.hotkey };
  }

  /** Rejects (and keeps the previous choice) when the accelerator is not a valid shortcut or the write fails. */
  setHotkey(hotkey: HotkeySettings): Promise<void> {
    const canonical = canonicalHotkeySettings(hotkey, this.platform);
    if (!canonical) return Promise.reject(new Error(`unsupported shortcut: ${JSON.stringify(hotkey)}`));
    return this.save((current) => ({ ...current, hotkey: canonical }));
  }

  setLanguage(language: Language): Promise<void> {
    if (!isLanguage(language)) return Promise.reject(new Error("unsupported language"));
    return this.save((current) => ({ ...current, language }));
  }

  setOutputDir(outputDir: string): Promise<void> {
    if (!path.isAbsolute(outputDir)) return Promise.reject(new Error(`outputDir must be absolute: ${outputDir}`));
    return this.save((current) => ({ ...current, outputDir }));
  }

  /** Rejects (and keeps the previous choice) when the value is unsupported or the write fails. */
  setQuality(patch: Partial<QualitySettings>): Promise<void> {
    patch = { ...patch };
    const quality = { ...this.settings.quality, ...patch };
    if (!isQualitySettings(quality)) {
      return Promise.reject(new Error(`unsupported quality setting: ${JSON.stringify(patch)}`));
    }
    return this.save((current) => ({ ...current, quality: { ...current.quality, ...patch } }));
  }

  /**
   * Overlapping saves (two quick menu clicks, or a folder pick during a
   * quality write) would otherwise both derive from the same stale value and
   * race on the same `.tmp` path. A failed save rejects its own caller only;
   * later saves still run from the last committed settings.
   */
  private save(update: (current: Settings) => Settings): Promise<void> {
    return this.queue.run(async () => {
      const next = update(this.settings);
      await this.write(next);
      this.settings = next;
    });
  }

  /** Saves one on/off setting, refusing anything but a boolean: IPC hands main whatever a page sent. */
  private setSwitch(key: SwitchSetting, enabled: unknown, what: string): Promise<void> {
    if (typeof enabled !== "boolean") return Promise.reject(new Error(`unsupported ${what}: ${JSON.stringify(enabled)}`));
    return this.save((current) => ({ ...current, [key]: enabled }));
  }

  /** Wait for every previously accepted save before quitting. */
  async flush(): Promise<void> {
    await this.queue.drain();
  }

  private load(defaultOutputDir: string): Settings {
    const defaults = defaultSettings(defaultOutputDir);
    // Only a missing file is a new install: one that is there but unreadable, reset or newer belongs to an existing
    // user, who never meets the first-launch guide (2026-10-26).
    const fallback = { ...defaults, onboardingDone: true };
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (cause) {
      if (errnoCode(cause) !== "ENOENT") {
        this.log(`settings: cannot read ${this.filePath}: ${String(cause)}; using defaults`);
        this.unusableOnDisk = true;
        return fallback;
      }
      return defaults;
    }
    const parsed = parseSettings(text, this.platform);
    if (!parsed) {
      try {
        const version = (JSON.parse(text) as { version?: unknown } | null)?.version;
        this.newerOnDisk = typeof version === "number" && version > SETTINGS_VERSION;
        this.resetPending = Number.isSafeInteger(version) && (version as number) >= 1 && (version as number) < SETTINGS_VERSION;
      } catch { /* Broken JSON follows the existing keep-before-write contract. */ }
      this.log(`settings: ${this.filePath} is invalid or has an unknown version; using defaults`);
      this.unusableOnDisk = !this.resetPending;
      return fallback;
    }
    for (const warning of parsed.warnings) this.log(`settings: ${warning}`);
    return parsed.settings;
  }

  /**
   * The first write after an unusable load happens without the user asking
   * (the launch update check stamps its attempt), so it keeps the old file
   * first. A failed keep rejects the save and leaves the file in place.
   */
  private async write(settings: Settings): Promise<void> {
    if (this.newerOnDisk) throw new Error("Settings are from a newer app version; refusing to overwrite them");
    if (this.resetPending && !this.resetBackedUp) {
      await this.keepFile("reset-backup");
      this.resetBackedUp = true;
    }
    if (this.unusableOnDisk) {
      await this.keepUnusable();
      this.unusableOnDisk = false;
    }
    await writeFileAtomic(this.filePath, JSON.stringify(settings, null, 2) + "\n");
    this.resetPending = false;
  }

  /**
   * Links the unusable file under the first free `.unreadable` name. Unlike
   * `rename`, `link` never replaces an existing name, so a copy kept by an
   * earlier launch survives a second unusable load; the atomic write then
   * replaces only the original name. A volume that answers EEXIST for every name
   * ends the keep as a failure after `KEPT_UNUSABLE_NAMES` names, as a
   * recording's publication does, instead of holding the save queue forever.
   */
  private async keepUnusable(): Promise<void> {
    await this.keepFile("unreadable");
  }

  private async keepFile(suffix: string): Promise<void> {
    const kept = await keepFile(this.filePath, suffix, KEPT_UNUSABLE_NAMES);
    if (kept) this.log(`settings: kept the ${suffix === "unreadable" ? "unusable" : "pre-reset"} file as ${kept}`);
  }
}
