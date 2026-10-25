/**
 * The shape every Settings row shares: how a group is made, which rows are switches or segments, and the sections
 * and tabs rows are drawn in.
 */
import { translate as t, type Language, type PlainMessageKey } from "../../../shared/i18n";
import type { SettingsChoice, SettingsGroup } from "../../../shared/settings-panel";
import type { AppAction, AppContext } from "../../app/ui-model";

/** A group as main knows it: exactly the wire shape plus the action per choice. */
export interface Group extends SettingsGroup {
  choices: Array<SettingsGroup["choices"][number] & { action: AppAction }>;
  actions?: Array<SettingsChoice & { action: AppAction }>;
}

export function group(
  id: string,
  label: string,
  enabled: boolean,
  choices: Group["choices"],
  note?: string,
): Group {
  const section = SECTIONS[id] ?? id;
  return { id, label, enabled, choices, tab: STUDIO_SECTIONS.has(section) ? "studio" : RECORDING_SECTIONS.has(section) ? "recording"
    : TROUBLESHOOTING_SECTIONS.has(section) ? "failures" : "general",
    control: SWITCHES.has(id) ? "switch" : SEGMENTED.has(id) ? "segmented" : "menu",
    ...(ICON_SEGMENTS.has(id) ? { iconChoices: true } : {}),
    section, noteKind: "explanation", ...(note === undefined ? {} : { note }) };
}

/** Rows drawn as an on/off switch, and as a row of segments; any other choice row is a menu. */
const SWITCHES = new Set(["notifications", "updateChecks", "countdownSound", "hideSystemUi", "editableRecording", "microphone", "camera", "studioCamera", "cameraShown", "cameraMirror"]);
const SEGMENTED = new Set(["countdown", "videoQuality", "language", "appearance"]);
/** Segments drawn as icons, each named by its label: Appearance's three, one click each (2026-10-05, formerly a menu). */
const ICON_SEGMENTS = new Set(["appearance"]);
/** A row's tab follows its section, so a section is never split. */
const RECORDING_SECTIONS = new Set(["source", "countdown", "audio", "camera", "video"]);
const TROUBLESHOOTING_SECTIONS = new Set(["diagnostics", "cleanup"]);
/** The Recording Studio's (plan 075, D19): what is watched and changed around a recording. */
const STUDIO_SECTIONS = new Set(["studioPreview", "studioCamera", "studioAudio", "studioControls"]);
/** Related rows share an inset list; a section's first row carries its heading. */
const SECTIONS: Record<string, string> = {
  screen: "source", hideSystemUi: "source", outputFolder: "source", fileName: "source", editableRecording: "source",
  countdown: "countdown", countdownSound: "countdown",
  microphone: "audio", microphoneDevice: "audio", microphoneLevel: "audio",
  camera: "camera", cameraDevice: "camera", cameraStudio: "camera",
  studioControls: "studioControls", cameraPreview: "studioPreview", studioPreviewRate: "studioPreview", studioPreviewView: "studioPreview", studioLive: "studioPreview", systemAudio: "studioAudio", microphoneAudio: "studioAudio",
  systemGain: "studioAudio", microphoneGain: "studioAudio",
  studioCamera: "studioCamera", cameraShown: "studioCamera", cameraWidth: "studioCamera", cameraHeight: "studioCamera",
  cameraRounding: "studioCamera", cameraMirror: "studioCamera",
  videoQuality: "video", resolutionCap: "video", frameRate: "video",
  trayClick: "controls", hotkey: "controls", notifications: "controls",
  language: "display", appearance: "display",
  updateChecks: "updates", updates: "updates",
  log: "diagnostics", localData: "cleanup",
  setupGuide: "setup",
};
const SECTION_HEADINGS: Record<string, PlainMessageKey> = {
  source: "Source and output",
  countdown: "Before recording",
  audio: "Audio",
  camera: "Camera",
  studioCamera: "Camera",
  studioAudio: "Audio",
  studioControls: "Recording controls",
  video: "Video",
  controls: "Controls and notifications",
  display: "Language and appearance",
  updates: "Updates",
  setup: "Getting started",
  diagnostics: "Diagnostic tools",
  cleanup: "Reset and cleanup",
};

/** On, then Off, for a switch whose action carries the chosen value. */
export function switchChoices(language: Language, current: boolean, action: (value: boolean) => AppAction): Group["choices"] {
  return [true, false].map((value) => ({
    id: value ? "on" : "off", label: t(value ? "On" : "Off", language), enabled: true, checked: value === current, action: action(value),
  }));
}

/**
 * Beside a denial: macOS answers a running app's access question as it first did until the app restarts, so access
 * allowed in System Settings shows only after a relaunch (075's permission round, 2026-10-18), as for screen recording.
 */
export function relaunchChoice(language: AppContext["language"]): SettingsChoice & { action: AppAction } {
  return { id: "relaunch", label: t("Already allowed? Relaunch RecordStuff", language), enabled: true, checked: false, action: "relaunch" satisfies AppAction };
}

export function withSectionHeadings(groups: Group[], language: Language): Group[] {
  return groups.map((group, index) => {
    const heading = group.section === undefined ? undefined : SECTION_HEADINGS[group.section];
    return heading && groups[index - 1]?.section !== group.section ? { ...group, sectionHeading: t(heading, language) } : group;
  });
}
