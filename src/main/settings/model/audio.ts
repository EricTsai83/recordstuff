/**
 * The audio rows: the microphone switch, its input device and level, and the Recording Studio's inputs with their
 * faders (plan 075, D21).
 */
import { translate as t, type PlainMessageKey } from "../../../shared/i18n";
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, DEFAULT_AUDIO_VOLUME } from "../../../shared/audio-volume";
import type { MicrophoneDevice } from "../../../shared/protocol";
import type { AppAction, AppContext } from "../../app/ui-model";
import { type Group, group, relaunchChoice, switchChoices } from "./group";

/**
 * The microphone (plan 074): off by default and locked while recording. Turning it on asks macOS for access then and
 * there (actions.ts), so the prompt follows the user's own click; a denial keeps the setting and is shown here with
 * the pane that changes it, since a recording would be refused before its countdown.
 */
export function microphoneGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  const microphone = ctx.microphone ?? { enabled: false };
  const result: Group = { ...group("microphone", t("Microphone", language), enabled,
    switchChoices(language, microphone.enabled, (value) => ({ setMicrophone: value }))),
  // An editable recording keeps the microphone on a track of its own (plan 087), so the note says so rather than
  // "one track" (Codex's computer-use round of 2026-10-26 found the two notes contradicting each other).
  info: t(ctx.editableRecording
    ? "Kept on a track of its own while Editable recordings is on, so its volume can be set after recording. Use headphones so the microphone does not record your speakers a second time."
    : "Mixed with system audio into one track. Use headphones so the microphone does not record your speakers a second time.", language) };
  if (ctx.platform !== "darwin") return result;
  const refused = microphone.access === "denied" || microphone.access === "restricted";
  // Off because macOS refused it (a refusal turns the switch off, 2026-10-26): said, with the pane that allows it,
  // so it does not read as a preference turned off (native round of the same day).
  if (!microphone.enabled && refused) {
    result.note = t("macOS does not allow the microphone. Allow RecordStuff in System Settings to turn it on.", language);
    result.noteKind = "status";
    result.actions = [{ id: "openSettings", label: t("Open microphone settings…", language), enabled: true, checked: false,
      action: "openMicrophoneSettings" satisfies AppAction }];
  }
  if (!microphone.enabled) return result;
  if (refused) {
    result.diagnostics = [{ kind: "current", heading: t("Microphone access is off", language),
      reason: t("Recordings leave the microphone out until it is allowed.", language),
      guidance: t("Allow RecordStuff in System Settings → Privacy & Security → Microphone, or turn Microphone off.", language) }];
    result.actions = [{ id: "openSettings", label: t("Open microphone settings…", language), enabled: true, checked: false,
      action: "openMicrophoneSettings" satisfies AppAction }, relaunchChoice(language)];
  } else if (microphone.access === "not-determined") {
    result.note = t("macOS asks for microphone access when you next record.", language);
    result.noteKind = "status";
  }
  return result;
}

/**
 * The recording's inputs under the Studio's preview (D19; plan 097, D6): each one's level, for the session in progress
 * only; the microphone's while the session takes it, or before one while its switch is on. A plain recording's also say
 * whether the input is recorded (Don't record, the mute until plan 097) and its fader; an editable recording's are the
 * level alone, since it records every input as it comes.
 */
export function studioAudioGroups(ctx: AppContext, type: "plain" | "editable"): Group[] {
  const language = ctx.language;
  const session = ctx.audioSession;
  const row = (id: string, label: PlainMessageKey, source: "system" | "microphone", muted: boolean): Group => ({
    ...group(id, t(label, language), session !== undefined, type === "editable" ? [] : [
      { id: "mute", label: t("Don't record", language), enabled: true, checked: muted, action: { setAudioMuted: { source, muted: true } } },
      { id: "unmute", label: t("Record", language), enabled: true, checked: !muted, action: { setAudioMuted: { source, muted: false } } },
    ]),
    control: "meter", meter: { source },
    ...(muted && type === "plain" ? { problem: t(source === "system" ? "System audio not recorded" : "Microphone not recorded", language) } : {}),
  });
  // Each input's fader (D21): a setting, so offered before, during and between plain recordings alike.
  const fader = (id: AudioVolumeGroup, label: PlainMessageKey): Group[] => {
    if (type === "editable") return [];
    const source = AUDIO_VOLUME_GROUPS[id];
    const value = (ctx.audioVolume ?? DEFAULT_AUDIO_VOLUME)[source];
    return [{ ...group(id, t("{label} volume", language, { label: t(label, language) }), true, [{ id: String(value), label: `${value}%`,
      enabled: true, checked: true, action: { setAudioVolume: { source, volume: value } } }]),
      control: "slider", slider: { min: 0, max: AUDIO_VOLUME_MAX, step: AUDIO_VOLUME_STEP, value, unit: "percent", scale: "volume" } }];
  };
  const rows = [row("systemAudio", "System audio", "system", session?.systemMuted ?? false), ...fader("systemGain", "System audio")];
  if (session ? session.microphone : ctx.microphone?.enabled) {
    rows.push(row("microphoneAudio", "Microphone", "microphone", session?.microphone?.muted ?? false), ...fader("microphoneGain", "Microphone"));
  }
  return rows;
}

/** The faders' groups and the input each sets (D21). */
export const AUDIO_VOLUME_GROUPS = { systemGain: "system", microphoneGain: "microphone" } as const;
type AudioVolumeGroup = keyof typeof AUDIO_VOLUME_GROUPS;
export const isAudioVolumeGroup = (id: unknown): id is AudioVolumeGroup => typeof id === "string" && Object.hasOwn(AUDIO_VOLUME_GROUPS, id);

/** The choice id of the system default input; device ids come from the engine. */
const DEFAULT_MICROPHONE = "systemDefault";

/**
 * Which input (plan 074): the system default, named after the device it is now, or one the engine listed. A chosen
 * input that is not connected stays selected and says so: the engine records the default input until it is back.
 * While a recording records the microphone it stays open and switches it (plan 079, D3); Search for devices lists the
 * inputs again at once (D2), between recordings.
 */
export function microphoneDeviceGroup(ctx: AppContext, unlocked: boolean): Group {
  const language = ctx.language;
  const microphone = ctx.microphone ?? { enabled: false };
  const switching = !unlocked && ctx.audioSession?.microphone !== undefined;
  const devices = (microphone.devices ?? []).filter((device) => device.id !== DEFAULT_MICROPHONE);
  const current = devices.find((device) => device.default);
  const stored = microphone.device;
  // A MacBook's own microphone with the lid closed (plan 089, D2): listed and opened, but it hears nothing.
  const named = (device: MicrophoneDevice): string => device.lidClosed ? t("{label} — Lid closed", language, { label: device.name }) : device.name;
  const choices: Group["choices"] = [{
    id: DEFAULT_MICROPHONE, label: current ? t("System default ({name})", language, { name: named(current) }) : t("System default", language),
    enabled: true, checked: stored === undefined, action: { setMicrophoneDevice: null },
  }, ...devices.map((device) => ({
    id: device.id, label: named(device), enabled: true, checked: stored?.id === device.id,
    action: { setMicrophoneDevice: { id: device.id, label: device.name } } satisfies AppAction,
  }))];
  // Not listed: missing when the inputs are known, or not yet known at all.
  const missing = stored !== undefined && !devices.some((device) => device.id === stored.id);
  if (missing) choices.push({ id: stored.id,
    label: microphone.devices ? t("{label} — Not connected", language, { label: stored.label }) : stored.label,
    enabled: !microphone.devices, checked: true, action: { setMicrophoneDevice: stored } });
  const result = group("microphoneDevice", t("Input device", language), (unlocked && microphone.enabled) || switching, choices);
  // What the next recording would open: the chosen input, else the system default it falls back to. Not while one
  // records: it keeps the device it opened whatever the default becomes, and the engine tells its silence itself.
  const used = stored === undefined || missing ? current : devices.find((device) => device.id === stored.id);
  const lid = used?.lidClosed && microphone.enabled && !switching
    ? t("{label} hears nothing while the lid is closed. Choose another input, or open the lid.", language, { label: used.name }) : undefined;
  if (missing && microphone.devices) {
    const fallback = t("Recordings use the system default input until {label} is connected.", language, { label: stored.label });
    // Chinese sentences follow one another without a space.
    result.note = lid ? `${fallback}${language === "zh-TW" ? "" : " "}${lid}` : fallback;
    result.noteKind = "status";
  } else if (lid) {
    result.note = lid;
    result.noteKind = "status";
  } else if (switching) {
    result.note = t("Switches this recording's microphone at once.", language);
    result.noteKind = "status";
  }
  if (microphone.enabled) {
    result.actions = [{ id: "search", label: t(microphone.searching ? "Searching…" : "Search for devices", language),
      enabled: unlocked && !microphone.searching, checked: false, action: "searchMicrophones" satisfies AppAction }];
  }
  return result;
}

/**
 * The input level (plan 079, D1): the chosen input's level between recordings, read by the engine as a recording would,
 * while the microphone is on and macOS allows it; while recording the Recording Studio shows the recording's own.
 */
export function microphoneLevelGroup(ctx: AppContext, unlocked: boolean): Group | undefined {
  const language = ctx.language;
  const microphone = ctx.microphone;
  if (!microphone?.enabled || (microphone.access !== undefined && microphone.access !== "granted")) return undefined;
  const result: Group = { ...group("microphoneLevel", t("Input level", language), unlocked, []), control: "inputMeter",
    info: t("Speak to check that the microphone hears you. Nothing is recorded.", language) };
  if (!unlocked) {
    result.note = t("While recording, the Recording Studio shows the level.", language);
    result.noteKind = "status";
  }
  return result;
}
