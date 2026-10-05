/** Main owns committed preferences, diagnostics and authorized choice ids. */
import { SETTINGS_SHORTCUT_RESERVED, acceleratorKeys, describeAccelerator, isSettingsShortcut, validateAccelerator } from "../shared/hotkey";
import { browserPlatform, isCloseChord, shortcutCandidate, shortcutModifiers } from "./shortcut-capture";
import { infoPlacement } from "./info-placement";
import { glyph } from "./glyph";
import { controlButton, mark, playbackOf, playerControls, type PlayerControls, type PlayerLabels } from "./player-controls";
import { documentLanguage, isLanguage, phrases, sentences, translate, type PlainMessageKey } from "../shared/i18n";
import { REVIEWED_FAILURES_KEPT, persistsHistory } from "../shared/recording-result";
import { SHORTCUT_CAPTURE_TIMEOUT_MS, type LibraryItemView, type RecordingResultView, type SettingsBridge, type SettingsGroup, type SettingsTab, type SettingsView } from "../shared/settings-panel";
import type { FullScreenChoice, PlaybackState } from "../shared/video-player";

declare global { interface Window { settings: SettingsBridge } }
const form = document.querySelector<HTMLFormElement>("#settings")!;
const heading = document.querySelector<HTMLHeadingElement>("#title")!;
const hint = document.querySelector<HTMLParagraphElement>("#hint")!;
const statusCard = document.querySelector<HTMLElement>("#status")!;
const feedback = document.querySelector<HTMLParagraphElement>("#feedback")!;
const startupLanguage = ((v: string | null) => isLanguage(v) ? v : undefined)(new URLSearchParams(location.search).get("lang"));
let view: SettingsView | undefined;
/** A new window opens on the recordings, the app's home (2026-10-04). */
let selectedTab: SettingsTab = "library";
let renderedStructure = "";
/** The tab the current panel was built for, so switching can store where it was left. */
let renderedTab: SettingsTab | undefined;
/**
 * Each tab's scroll offset for the life of the window (plan 047): stored when
 * the user switches away, restored once the tab's panel is complete; a tab
 * opened for the first time starts at the top.
 */
const tabScroll = new Map<SettingsTab, number>();
const resultStates = new Map<string, { open: boolean; acknowledged: boolean }>();
/**
 * Where each pending result action started. Focus returns from this intent,
 * not from `document.activeElement` surviving the wait; `moved` records that
 * the user went elsewhere or the window lost focus meanwhile.
 */
const resultIntents = new Map<string, { action: string; control: string; moved: boolean }>();
const resultErrors = new Set<string>();
let resultFocus = 0;
let requestId = 0;
let pending = 0;
let saving: { group: string; choice: string; control: string } | undefined;
let arming = false;
/** The page asked main to end the shortcut editor; any other end (timeout, recording start) is announced. */
let closingCapture = false;
let captureGeneration = 0;
let preview = "";
/** The preview's keys, one box each: modifiers and the key, never the characters of a name like F12 or Ctrl. */
let previewParts: string[] = [];
let candidateToConfirm: string | undefined;
/** Main keeps a new window hidden until this page has painted something to show. */
let reportedReady = false;
/** Once, after the frame holding the first content: the first `requestAnimationFrame` runs before that frame, the second after it. */
function reportReady(): void {
  if (reportedReady) return;
  reportedReady = true;
  requestAnimationFrame(() => requestAnimationFrame(() => { void window.settings.ready().catch(() => {}); }));
}
/** The first read failed and its error is shown in `#feedback`, made visible. */
let startupFailed = false;
/** `editor`: the shortcut editor refused the key just pressed; the error belongs to that editor and closes with it. */
let failure: { group: string; choice?: string; text: string; baseline?: string; refused?: true; editor?: true } | undefined;
const text = (key: PlainMessageKey): string => translate(key, view?.language);
/** The shortcut editor's time limit, as main arms it (`SHORTCUT_CAPTURE_TIMEOUT_MS`). */
const captureText = (key: "Press a combination and Confirm within {seconds} seconds; Esc cancels" | "Timed out after {seconds} seconds; the shortcut is unchanged. Choose Custom shortcut… to try again."): string =>
  translate(key, view?.language, { seconds: SHORTCUT_CAPTURE_TIMEOUT_MS / 1000 });
const controlId = (group: SettingsGroup): string => `setting-${group.id}`;
/** A failure row's `<details>`; its summary adds `-summary`. */
const resultDomId = (id: string): string => `recording-result-${encodeURIComponent(id)}`;
/** The shortcut editor's own buttons: their outcome returns focus to the shortcut select. */
const isCaptureControl = (control: string): boolean => control === "shortcut-capture" || control === "shortcut-confirm";
/** A group's retry or recovery button; it hides once it worked, so focus falls back to the group. */
const isRecoveryControl = (control: string): boolean => /-(retry|recovery)$/.test(control);
const shortcutGroup = (): SettingsGroup | undefined => view?.groups.find(g => g.kind === "shortcut");
/** Main's platform; before the first view (a failed read) the page must still close. */
const platform = (): string => shortcutGroup()?.platform ?? browserPlatform();
document.documentElement.dataset.platform = platform();
function setText(element: Element, value: string): void { if (element.textContent !== value) element.textContent = value; }
/** Like `setText`: an attribute rewritten with its own value would still be a DOM mutation, once per card on every push. */
function setAttr(element: Element, name: string, value: string): void { if (element.getAttribute(name) !== value) element.setAttribute(name, value); }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", value = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; el.textContent = value; return el;
}
/** Marks a repeated announcement; screen readers do not speak a trailing no-break space. */
const REPEAT_MARK = "\u00A0";
/** The message `#feedback` announces, without the repeat mark. */
const announced = (): string => (feedback.textContent ?? "").replace(/\u00A0$/, "");
/**
 * A live region speaks only when its text changes, so the same message again (a retry that
 * failed again, a second refused key) toggles the repeat mark to be heard again. While the
 * player is open its own region speaks: a modal dialog makes the rest of the page, `#feedback`
 * included, inert and silent.
 */
function announce(value: string): void {
  const target = player?.open && playerFeedback ? playerFeedback : feedback;
  const current = target.textContent ?? "";
  if (value && current.replace(/\u00A0$/, "") === value) target.textContent = current === value ? `${value}${REPEAT_MARK}` : value;
  else setText(target, value);
}
function committed(group: SettingsGroup | undefined): string { return group?.choices.find(c => c.checked)?.id ?? ""; }
function setDisabled(el: HTMLButtonElement | HTMLSelectElement | HTMLInputElement, unavailable: boolean, busy: boolean): void {
  if (el.disabled !== (unavailable || busy)) el.disabled = unavailable || busy;
  el.classList.toggle("saving-disabled", !unavailable && busy);
}
/**
 * An action button that is busy stays focusable and ignores activation: native
 * disabled would drop the focus of the button just pressed to the page (plan 053).
 * Only an unavailable action is natively disabled.
 */
function setActionDisabled(el: HTMLButtonElement, unavailable: boolean, busy: boolean): void {
  setDisabled(el, unavailable, false);
  setAttr(el, "aria-disabled", String(unavailable || busy));
  el.classList.toggle("saving-disabled", !unavailable && busy);
}
const inactive = (el: HTMLElement): boolean => el.getAttribute("aria-disabled") === "true";
function button(id: string, handler: () => void): HTMLButtonElement {
  const el = node("button"); el.type = "button"; el.id = id; el.addEventListener("click", handler); return el;
}
function localFailure(group: string, message: string): void {
  failure = { group, text: message }; announce(message); draw();
}
async function capture(armed: boolean, restore = false): Promise<void> {
  if (armed && (!shortcutGroup()?.enabled || saving || arming || shortcutGroup()?.capturing)) return;
  const generation = ++captureGeneration;
  arming = armed;
  preview = ""; previewParts = [];
  candidateToConfirm = undefined;
  if (armed) { failure = undefined; announce(""); }
  else closingCapture = true;
  draw();
  try {
    const next = await window.settings.capture(armed);
    if (generation !== captureGeneration) return;
    arming = false;
    render(next);
    if (armed && shortcutGroup()?.capturing) document.getElementById("shortcut-capture")?.focus({ preventScroll: true });
    else if (armed) localFailure("hotkey", text("Could not edit the shortcut. Try again."));
    if (!armed && restore && document.hasFocus()) document.getElementById("setting-hotkey")?.focus({ preventScroll: true });
  } catch {
    if (generation !== captureGeneration) return;
    arming = false;
    localFailure("hotkey", text("Could not edit the shortcut. Try again."));
  } finally {
    if (!armed && generation === captureGeneration) closingCapture = false;
  }
}
/** An action (a link, a folder, a system pane) saves nothing: its retry repeats the action and is labelled so. */
function isAction(group: SettingsGroup, choice: string | undefined): boolean {
  return group.kind === "actions" || Boolean(group.actions?.some(action => action.id === choice));
}
function setPreview(accelerator: string, platform: string): void {
  preview = describeAccelerator(accelerator, platform);
  previewParts = acceleratorKeys(accelerator, platform);
}
/**
 * What stands for a group when its focused retry or recovery button hides. A
 * select or switch carries the group's id; a radio group and a row of action
 * buttons take no focus themselves, so the checked radio or the retried action does.
 */
function groupControl(groupId: string, choice?: string): HTMLElement | null {
  const id = `setting-${groupId}`;
  const own = document.getElementById(id);
  if (own?.matches("select, input")) return own;
  const row = document.getElementById(`${id}-row`);
  return row?.querySelector<HTMLElement>(".segments input:checked")
    ?? (choice ? document.getElementById(`${id}-${choice}`) : null)
    ?? row?.querySelector<HTMLElement>(".controls button, .controls input") ?? null;
}
function retryAllowed(group: SettingsGroup): boolean {
  return Boolean(failure?.choice && failure.group === group.id && group.enabled &&
    failure.baseline === committed(group) && group.choices.some(c => c.id === failure?.choice && c.enabled));
}
/** Drawn like the ⓘ, so the warning looks the same on every platform instead of following the font's ⚠. */
function warningIcon(): SVGSVGElement {
  return glyph("0 0 16 16", { fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round", "stroke-linejoin": "round" },
    { d: "M8 1.9 14.8 13.6H1.2L8 1.9ZM8 6.2v3.4M8 11.6v.1" });
}
/** A film frame: the Recordings tab, and a card or empty folder with nothing better to show. */
const FILM = "M3 5.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 9h18M7.5 3.5 9.5 9M13 3.5l2 5.5M10 13v4.5l4-2.25Z";
/**
 * Line icons on a 24-unit grid, drawn with the text colour: one per row, tab and empty state, so
 * a row is found by its shape before its label is read. Each entry is stroked paths, then filled ones.
 */
const ICONS: Record<string, [string, string?]> = {
  screen: ["M4 3.5h16a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2ZM8 21h8M12 17v4"],
  outputFolder: ["M20 20a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 4.4a2 2 0 0 0-1.7-.9H4a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2Z"],
  countdown: ["M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"],
  countdownSound: ["M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"],
  videoQuality: ["M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9ZM19 2.5v4M17 4.5h4M5 17.5v3M3.5 19h3"],
  resolutionCap: ["M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3M9 9h6v6H9z"],
  frameRate: ["M22 12h-4l-3 8L9 4l-3 8H2"],
  trayClick: ["M9 9l5 12 1.8-5.2L21 14ZM7.2 2.2 8 5.1M5.1 8l-2.9-.8M14 4.1 12 6M6 12l-1.9 2"],
  hotkey: ["M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"],
  notifications: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a2 2 0 0 0 3.4 0"],
  language: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"],
  appearance: ["M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19Z", "M12 2.5a9.5 9.5 0 0 1 0 19Z"],
  // Appearance's three segments (2026-10-05): the screen for the system's choice, the sun and the moon.
  "appearance-system": ["M4 4h16a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 17H4a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 4 4ZM8.5 21h7M12 17v4"],
  "appearance-light": ["M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"],
  "appearance-dark": ["M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"],
  updateChecks: ["M21 12a9 9 0 0 0-15.5-6.2L3 8.5M3 3.5v5h5M3 12a9 9 0 0 0 15.5 6.2L21 15.5M21 20.5v-5h-5"],
  log: ["M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8ZM14 2.5V8h5.5M8.5 13h7M8.5 17h7M8.5 9h2"],
  updates: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"],
  "tab-library": [FILM],
  play: ["", "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"],
  film: [FILM],
  // The card menu's actions: the folder above, out to another app, and the Trash.
  "file-reveal": ["M20 20a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 4.4a2 2 0 0 0-1.7-.9H4a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2Z"],
  "file-open": ["M14 3.5h6.5V10M20.5 3.5 11 13M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"],
  "file-trash": ["M3.5 6h17M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6M5.5 6l1 13.6A1.5 1.5 0 0 0 8 21h8a1.5 1.5 0 0 0 1.5-1.4L18.5 6M10 10.5v6M14 10.5v6"],
  more: ["", "M5.2 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0ZM10.4 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0ZM15.6 12a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0Z"],
  "tab-recording": ["M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19Z", "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"],
  "tab-general": ["M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"],
  "tab-failures": ["M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"],
  empty: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 12.5l2.7 2.7L16 9.8"],
};
function icon(name: string, className = "icon"): SVGSVGElement | undefined {
  const paths = ICONS[name];
  if (!paths) return undefined;
  const [stroked, filled] = paths;
  return glyph("0 0 24 24", { class: className },
    ...(stroked ? [{ d: stroked, fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round" }] : []),
    ...(filled ? [{ d: filled, fill: "currentColor" }] : []));
}
/**
 * The status card, only when there is something to say (2026-10-04): a recording, a countdown or a save,
 * with the lock `hint` explaining the dimmed settings, or a problem with its fix. Ready says nothing.
 */
function updateStatus(current: SettingsView): void {
  const value = current.status;
  statusCard.hidden = !value || value.tone === "ready";
  if (!value) return;
  statusCard.dataset.tone = value.tone;
  setText(document.getElementById("status-title")!, value.title);
  const detail = document.getElementById("status-detail")!;
  setText(detail, value.detail);
  detail.hidden = !value.detail || Boolean(current.hint);
  // The card's own fix has no row to show its failure under: it says so here as well as aloud, until the next action.
  const error = document.getElementById("status-error");
  if (error) {
    const statusFailed = failure?.group === "status";
    setText(error, statusFailed ? failure!.text : "");
    error.hidden = !statusFailed;
  }
  const action = document.getElementById("status-action") as HTMLButtonElement;
  action.hidden = !value.action;
  if (value.action) {
    action.dataset.action = value.action.id;
    setText(action, value.action.label);
    setActionDisabled(action, false, Boolean(saving));
  }
  const secondary = document.getElementById("status-secondary") as HTMLButtonElement | null;
  if (secondary) {
    secondary.hidden = !value.secondaryAction;
    if (value.secondaryAction) {
      secondary.dataset.action = value.secondaryAction.id;
      setText(secondary, value.secondaryAction.label);
      setActionDisabled(secondary, false, Boolean(saving));
    }
  }
}
function updateDiagnostic(container: HTMLElement, group: SettingsGroup): void {
  const area = container.querySelector<HTMLElement>(".diagnostics")!;
  // Reuse the region: a push must not replace focused recovery/retry buttons.
  const content = area.querySelector<HTMLElement>(".diagnostic-content")!;
  const items = group.diagnostics ?? [];
  const signature = JSON.stringify(items);
  if (content.dataset.signature !== signature) {
    content.dataset.signature = signature;
    content.replaceChildren(...items.map(item => {
      const block = node("div", `diagnostic ${item.kind}`);
      const title = node("strong", "diagnostic-heading");
      title.append(warningIcon(), item.heading);
      block.append(title, node("p", "", item.reason), node("p", "guidance", item.guidance));
      return block;
    }));
  }
  const error = area.querySelector<HTMLElement>(".save-error")!;
  const activeFailure = failure?.group === group.id ? failure : undefined;
  error.hidden = !activeFailure;
  const actionFailure = activeFailure !== undefined && isAction(group, activeFailure.choice);
  // A combination the editor or main refused saved nothing, and the recovery is another key, not the same choice again.
  const refusedKey = activeFailure?.refused === true && group.kind === "shortcut";
  setText(error.querySelector("strong")!, text(refusedKey ? "Shortcut unavailable" : actionFailure ? "Action failed" : "Change was not saved"));
  setText(error.querySelector("p")!, activeFailure?.text ?? "");
  const recovery = area.querySelector<HTMLButtonElement>(".recovery")!;
  const canRecover = group.recovery && group.choices.some(c => c.id === group.recovery?.choice && c.enabled);
  const hadRecoveryFocus = document.activeElement === recovery;
  recovery.hidden = !canRecover;
  setText(recovery, group.recovery?.label ?? "");
  setActionDisabled(recovery, !group.enabled, Boolean(saving));
  const retry = area.querySelector<HTMLButtonElement>(".retry")!;
  const hadRetryFocus = document.activeElement === retry;
  retry.hidden = !retryAllowed(group);
  setText(retry, text(actionFailure ? "Retry" : "Retry save"));
  setActionDisabled(retry, !group.enabled, Boolean(saving));
  const guidance = area.querySelector<HTMLElement>(".reselect")!;
  // "Choose the setting again" applies to a value; a failed action already says to try again.
  guidance.hidden = !activeFailure || actionFailure || refusedKey || retryAllowed(group);
  setText(guidance, text("Choose the setting again to retry."));
  area.hidden = !items.length && !activeFailure;
  if (((hadRecoveryFocus && recovery.hidden) || (hadRetryFocus && retry.hidden)) && document.hasFocus())
    groupControl(group.id, saving?.group === group.id ? saving.choice : failure?.choice)?.focus({ preventScroll: true });
}
function updateRows(groups: SettingsGroup[]): void {
  // A section's footnote comes from whichever of its groups carries one.
  const footnotes = new Map<Element, string>();
  for (const group of groups) {
    const section = document.getElementById(`${controlId(group)}-row`)?.closest(".section");
    if (section && !footnotes.has(section)) footnotes.set(section, "");
    if (section && group.footnote) footnotes.set(section, group.footnote);
  }
  for (const [section, value] of footnotes) {
    const footnote = section.querySelector<HTMLElement>(":scope > .section-footnote");
    if (footnote) { setText(footnote, value); footnote.hidden = !value; }
  }
  for (const group of groups) {
    const container = document.getElementById(`${controlId(group)}-row`)!;
    const label = container.querySelector<HTMLElement>(".group-label")!;
    setText(label, group.label);
    label.hidden = !group.label;
    const note = container.querySelector<HTMLElement>(".note")!;
    setText(note, group.note ?? ""); note.hidden = !group.note;
    const info = document.getElementById(`${controlId(group)}-info`)!;
    const infoButton = document.getElementById(`${controlId(group)}-info-button`)!;
    if (!group.info && openInfo?.popover === info) hideInfo();
    setText(info, group.info ?? ""); info.hidden = infoButton.hidden = !group.info;
    setAttr(infoButton, "aria-label", translate("More about {label}", view?.language, { label: group.label }));
    // Each control's state is decided once and written only when it changes: a disabled flag flipped off and on
    // again on every push would still reach assistive technology as changes.
    const othersSaving = Boolean(saving && saving.group !== group.id);
    for (const el of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input")) {
      if (el instanceof HTMLSelectElement) {
        setDisabled(el, !group.enabled, othersSaving);
        // Reconcile menu options locally: a new custom key or display must not
        // recreate the panel, its neighbouring controls, or their focus.
        // Custom shortcut… waits while a save runs or the editor is arming or listening.
        const custom = { id: "custom", label: text("Custom shortcut…"), enabled: !saving && !arming && !group.capturing, checked: false };
        const choices = [...group.choices, ...(group.kind === "shortcut" ? [custom] : [])];
        const ids = new Set(choices.map(choice => choice.id));
        for (const option of Array.from(el.options)) if (!ids.has(option.value)) option.remove();
        choices.forEach((choice, index) => {
          let option = Array.from(el.options).find(item => item.value === choice.id);
          if (!option) { option = node("option"); option.value = choice.id; }
          if (el.options[index] !== option) el.insertBefore(option, el.options[index] ?? null);
          setText(option, choice.label);
          if (option.disabled !== !choice.enabled) option.disabled = !choice.enabled;
        });
        if (el.value !== committed(group)) el.value = committed(group);
      } else if (group.control === "switch") {
        el.checked = committed(group) === "on";
        el.value = committed(group);
        setDisabled(el, !group.enabled || !group.choices.find(c => c.id === (el.checked ? "off" : "on"))?.enabled, othersSaving);
      } else {
        const choice = group.choices.find(c => c.id === el.value)!;
        el.checked = choice.checked;
        setDisabled(el, !group.enabled || !choice.enabled, othersSaving);
        if (group.iconChoices) { setAttr(el, "aria-label", choice.label); setAttr(el.parentElement!, "title", choice.label); }
        else setText(el.nextElementSibling!, choice.label);
      }
    }
    const actions = group.kind === "actions" ? group.choices : group.actions ?? [];
    const actionParent = group.kind === "actions" ? container.querySelector<HTMLElement>(".controls")! : container;
    for (const el of actionParent.querySelectorAll<HTMLButtonElement>(":scope > button[data-action]")) {
      if (!actions.some(choice => choice.id === el.dataset.action)) el.remove();
    }
    for (const choice of actions) {
      let el = document.getElementById(`${controlId(group)}-${choice.id}`) as HTMLButtonElement | null;
      if (!el) { el = actionButton(group, choice); actionParent.append(el); }
      if (group.id === "about") {
        setAttr(el, "aria-label", choice.label); setAttr(el, "title", choice.label);
      } else setText(el, choice.label);
      setActionDisabled(el, !group.enabled || !choice.enabled, Boolean(saving) || choice.busy === true);
    }
    setAttr(container, "aria-busy", String(saving?.group === group.id));
    const applying = container.querySelector<HTMLElement>(".applying")!;
    setText(applying, saving?.group === group.id && !actions.some(choice => choice.id === saving?.choice) ? text("Applying…") : "");
    updateDiagnostic(container, group);
    if (group.kind === "shortcut") {
      const edit = container.querySelector<HTMLSelectElement>("#setting-hotkey")!;
      const area = container.querySelector<HTMLElement>(".capture-area")!;
      const field = container.querySelector<HTMLButtonElement>("#shortcut-capture")!;
      const wasFocused = area.contains(document.activeElement);
      area.hidden = !group.capturing;
      field.disabled = !group.enabled;
      const display = preview || text("Press a combination");
      if (field.dataset.preview !== display) {
        field.dataset.preview = display;
        const indicator = node("span", "listening-indicator"); indicator.setAttribute("aria-hidden", "true");
        for (let index = 0; index < 3; index++) indicator.append(node("span"));
        field.replaceChildren(indicator, ...(preview ? previewParts.map(key => node("kbd", "", key)) : [document.createTextNode(display)]));
        field.setAttribute("aria-label", sentences([display, text("Escape to cancel")], view?.language));
      }
      const help = container.querySelector<HTMLElement>(".capture-help")!;
      // Its own flag, so the description list below names the time limit only while the editor shows it.
      help.hidden = area.hidden;
      setText(help, captureText("Press a combination and Confirm within {seconds} seconds; Esc cancels"));
      const timeout = container.querySelector<HTMLElement>(".capture-timeout")!;
      timeout.hidden = !group.captureTimedOut;
      setText(timeout, group.captureTimedOut ? captureText("Timed out after {seconds} seconds; the shortcut is unchanged. Choose Custom shortcut… to try again.") : "");
      const confirm = container.querySelector<HTMLButtonElement>("#shortcut-confirm")!;
      setText(confirm, text("Confirm"));
      confirm.disabled = !group.enabled || !candidateToConfirm;
      setAttr(confirm, "aria-disabled", String(Boolean(saving) || confirm.disabled));
      confirm.tabIndex = candidateToConfirm ? 0 : -1;
      const cancel = container.querySelector<HTMLButtonElement>("#shortcut-cancel")!;
      setText(cancel, text("Cancel")); cancel.disabled = Boolean(saving); cancel.tabIndex = 0;
      if (wasFocused && area.hidden && document.hasFocus()) edit.focus({ preventScroll: true });
    }
    // Only what is shown: a hidden region still lends its text, stale failure copy included, to a description.
    // Status changes use the single announcer below, not duplicate live regions.
    const description = [`${controlId(group)}-help`, `${controlId(group)}-note`, `${controlId(group)}-info`, `${controlId(group)}-diagnostics`, `${controlId(group)}-timeout`]
      .filter(id => document.getElementById(id)?.hidden === false).join(" ");
    for (const el of container.querySelectorAll<HTMLElement>("select, input, button[data-action], #shortcut-capture")) {
      if (description) setAttr(el, "aria-describedby", description); else if (el.hasAttribute("aria-describedby")) el.removeAttribute("aria-describedby");
    }
  }
}
/** The About actions' marks: a globe for the website, the GitHub mark for the source, a power sign for Quit. */
function aboutIcon(choiceId: string): SVGSVGElement {
  if (choiceId === "website") return glyph("0 0 24 24", { fill: "none", stroke: "currentColor", "stroke-width": "1.6" },
    { d: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" });
  if (choiceId === "quit") return glyph("0 0 24 24", { fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round" },
    { d: "M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0" });
  return glyph("0 0 24 24", { fill: "currentColor" },
    { d: "M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.54v-2.07c-3.1.67-3.76-1.31-3.76-1.31-.51-1.28-1.24-1.62-1.24-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.14 1.71 1.14 1 .1.74 1.89 3.26 1.2.1-.73.4-1.23.71-1.51-2.48-.28-5.08-1.24-5.08-5.52 0-1.22.44-2.22 1.14-3-.11-.28-.5-1.41.11-2.94 0 0 .93-.3 3.05 1.14a10.6 10.6 0 0 1 5.55 0c2.12-1.44 3.05-1.14 3.05-1.14.61 1.53.22 2.66.11 2.94.71.78 1.14 1.78 1.14 3 0 4.29-2.61 5.23-5.1 5.51.4.35.75 1.02.75 2.06v3.05c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z" });
}
function actionButton(group: SettingsGroup, choice: SettingsGroup["choices"][number]): HTMLButtonElement {
  const id = `${controlId(group)}-${choice.id}`;
  const el = button(id, () => { if (!inactive(el)) void choose(group.id, choice.id, id); });
  el.dataset.action = choice.id;
  if (group.id === "about") el.append(aboutIcon(choice.id));
  return el;
}
/**
 * A group's secondary explanation: an ⓘ button beside the label and the
 * popover it shows. Hover and keyboard focus show it while they last; a click
 * pins it until another click, Escape or focus leaving. The popover sits in
 * the top layer, so the scrolling panel cannot clip it, and its text still
 * describes the control through `aria-describedby`.
 */
let openInfo: { button: HTMLButtonElement; popover: HTMLElement; pinned: boolean } | undefined;
/** Pending close after the pointer left the button or its explanation; entering either again cancels it. */
let infoLeave: ReturnType<typeof setTimeout> | undefined;
function showInfo(button: HTMLButtonElement, popover: HTMLElement, pinned: boolean): void {
  clearTimeout(infoLeave);
  if (openInfo && openInfo.popover !== popover) hideInfo();
  openInfo = { button, popover, pinned: pinned || (openInfo?.pinned ?? false) };
  button.setAttribute("aria-expanded", "true");
  if (!popover.matches(":popover-open")) popover.showPopover?.();
  placeInfo();
}
/** Placed by `infoPlacement`, above the button when it fits. A button scrolled out of the panel closes it instead. */
function placeInfo(): void {
  if (!openInfo) return;
  const { button, popover } = openInfo;
  const anchor = button.getBoundingClientRect();
  const panel = button.closest("#settings-panel")?.getBoundingClientRect();
  if (panel && (anchor.bottom < panel.top || anchor.top > panel.bottom)) { hideInfo(); return; }
  const { left, top, side, bridge } = infoPlacement(anchor, popover.getBoundingClientRect(), { width: innerWidth, height: innerHeight });
  popover.style.left = `${left}px`; popover.style.top = `${top}px`; popover.dataset.side = side;
  popover.style.setProperty("--bridge-left", `${bridge.left}px`); popover.style.setProperty("--bridge-width", `${bridge.width}px`);
}
function hideInfo(): boolean {
  clearTimeout(infoLeave);
  if (!openInfo) return false;
  const { button, popover } = openInfo;
  openInfo = undefined;
  button.setAttribute("aria-expanded", "false");
  if (popover.matches(":popover-open")) popover.hidePopover?.();
  return true;
}
function infoParts(id: string): [HTMLButtonElement, HTMLElement] {
  const popover = node("div", "info-popover"); popover.id = `${id}-info`;
  popover.setAttribute("popover", "manual"); popover.setAttribute("role", "tooltip");
  const info = button(`${id}-info-button`, () => {
    if (openInfo?.popover === popover && openInfo.pinned) hideInfo(); else showInfo(info, popover, true);
  });
  info.className = "info-button"; info.setAttribute("aria-describedby", popover.id); info.setAttribute("aria-expanded", "false");
  info.append(glyph("0 0 16 16", { fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round" },
    { d: "M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0ZM8 7.2v4M8 4.9v.1" }));
  // The explanation is hoverable too (WCAG 1.4.13): the pointer may cross the gap onto it, and keyboard focus keeps it open.
  const leave = (): void => {
    clearTimeout(infoLeave);
    infoLeave = setTimeout(() => {
      // Chromium reports a leave, and no enter, when the pointer crosses from the ::before bridge onto the
      // explanation itself, so only a pointer over neither one closes it; a real leave follows and closes it then.
      if (info.matches(":hover") || popover.matches(":hover")) return;
      if (openInfo?.popover === popover && !openInfo.pinned && document.activeElement !== info) hideInfo();
    }, 120);
  };
  info.addEventListener("mouseenter", () => showInfo(info, popover, false));
  info.addEventListener("mouseleave", leave);
  popover.addEventListener("mouseenter", () => { if (openInfo?.popover === popover) clearTimeout(infoLeave); });
  popover.addEventListener("mouseleave", leave);
  info.addEventListener("focus", () => showInfo(info, popover, false));
  info.addEventListener("blur", () => { if (openInfo?.popover === popover) hideInfo(); });
  return [info, popover];
}
function row(group: SettingsGroup): HTMLElement {
  const id = controlId(group);
  const container = node("div", "row"); container.id = `${id}-row`;
  const line = node("div", "row-line");
  // Buttons and a radio group have no single control a label could point at: the group is named by it instead.
  const label = group.kind === "actions" || group.control === "segmented" ? node("span", "group-label") : node("label", "group-label");
  if (label instanceof HTMLLabelElement) label.htmlFor = id;
  label.id = `${id}-label`;
  const controls = node("div", "controls");
  if (group.kind === "actions") { controls.setAttribute("role", "group"); controls.setAttribute("aria-labelledby", label.id); }
  const title = node("div", "group-title");
  const rowIcon = icon(group.id, "row-icon");
  title.append(...(rowIcon ? [rowIcon] : []), label, ...infoParts(id));
  line.append(title, controls); container.append(line);
  if (group.kind === "actions") {
    for (const choice of group.choices) controls.append(actionButton(group, choice));
  } else if (group.control === "switch") {
    const input = node("input", "switch"); input.type = "checkbox"; input.id = id; input.setAttribute("role", "switch");
    input.addEventListener("change", () => void choose(group.id, input.checked ? "on" : "off", id)); controls.append(input);
  } else if (group.control === "segmented") {
    const segments = node("div", "segments"); segments.id = id; segments.setAttribute("role", "radiogroup"); segments.setAttribute("aria-labelledby", label.id);
    for (const choice of group.choices) {
      const item = node("label", "segment");
      const input = node("input"); input.type = "radio"; input.name = id; input.id = `${id}-${choice.id}`; input.value = choice.id;
      input.addEventListener("change", () => { if (input.checked) void choose(group.id, choice.id, input.id); });
      // An icon segment shows its mark; its label names the radio and is its tooltip (`updateRows`).
      const face = node("span");
      if (group.iconChoices) { item.classList.add("segment-icon"); const choiceIcon = icon(`${group.id}-${choice.id}`, "segment-glyph"); if (choiceIcon) face.append(choiceIcon); }
      item.append(input, face); segments.append(item);
    }
    controls.append(segments);
  } else {
    // Its options, including the shortcut's Custom entry, come from `updateRows`, which `draw` runs next.
    const select = node("select"); select.id = id;
    select.addEventListener("change", () => {
      if (group.kind === "shortcut" && select.value === "custom") {
        select.value = committed(shortcutGroup()!);
        void capture(true);
      } else void choose(group.id, select.value, id);
    });
    // The menu draws its own chevron: the wrapper carries it, since a select has no pseudo-elements.
    const menu = node("span", "select"); menu.append(select); controls.append(menu);
  }
  if (group.kind === "shortcut") {
    const area = node("div", "capture-area");
    const field = button("shortcut-capture", () => {});
    field.addEventListener("keydown", event => {
      if (!shortcutGroup()?.capturing) return;
      const p = platform();
      if (isCloseChord(event, p)) return; // Not a candidate: the document handler closes.
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (candidateToConfirm) return; // Tab reaches Confirm, then Cancel.
        void capture(false);
        // Native traversal must skip the button that this async exit hides.
        container.querySelector<HTMLButtonElement>("#shortcut-cancel")!.tabIndex = -1;
        return;
      }
      event.preventDefault(); event.stopPropagation();
      if (saving || event.repeat) return;
      if (event.key === "Escape") { void capture(false, true); return; }
      if (candidateToConfirm && event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        void choose(group.id, candidateToConfirm, "shortcut-capture"); return;
      }
      const candidate = shortcutCandidate(event, p);
      // Releasing or pressing a modifier must not erase a complete preview.
      if (candidate === undefined && candidateToConfirm) return;
      candidateToConfirm = undefined;
      setPreview(candidate ?? shortcutModifiers(event, p).join("+"), p);
      if (candidate === undefined) { draw(); return; }
      const result = validateAccelerator(candidate, p);
      // The Settings shortcut is refused here like the other reserved combinations, so the editor stays open; main refuses it too.
      const error = result.error ?? (isSettingsShortcut(result.accelerator, p) ? SETTINGS_SHORTCUT_RESERVED : undefined);
      if (error) {
        // A key the editor cannot use has no name to show (only the internal "Unsupported"): keep the held modifiers.
        setPreview(shortcutModifiers(event, p).join("+"), p);
        failure = { group: group.id, text: translate(error, view?.language), refused: true, editor: true };
        announce(failure.text); draw(); return;
      }
      candidateToConfirm = result.accelerator;
      failure = undefined;
      announce(sentences([preview, text("Confirm to save")], view?.language));
      draw();
    });
    field.addEventListener("keyup", event => {
      if (!shortcutGroup()?.capturing || saving || candidateToConfirm) return;
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
        const p = platform();
        setPreview(shortcutModifiers(event, p).join("+"), p); draw();
      }
    });
    // A user-driven focus move runs this microtask before the new element is
    // focused, while `activeElement` is still the body, so the destination is
    // read from `relatedTarget`: Tab or VoiceOver moving to Confirm stays in
    // the editor. Without one (a click on the page, another window) the
    // element that holds focus afterwards decides, as before.
    area.addEventListener("focusout", (event) => {
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : undefined;
      queueMicrotask(() => {
        if (shortcutGroup()?.capturing && !saving && !area.contains(next ?? document.activeElement)) void capture(false);
      });
    });
    const confirm = button("shortcut-confirm", () => {
      if (candidateToConfirm && shortcutGroup()?.capturing && !saving)
        void choose(group.id, candidateToConfirm, "shortcut-confirm");
    });
    // A mouse-down would move focus before the click fires. Keep the current
    // focus so the explicit confirmation arrives while the editor holds it.
    confirm.addEventListener("mousedown", event => { if (event.button === 0) event.preventDefault(); });
    const help = node("p", "capture-help"); help.id = `${controlId(group)}-help`;
    area.append(field, confirm, button("shortcut-cancel", () => void capture(false, true)), help); container.append(area);
    const timeout = node("p", "capture-timeout"); timeout.id = `${controlId(group)}-timeout`; timeout.hidden = true;
    container.append(timeout);
  }
  const diagnostics = node("div", "diagnostics"); diagnostics.id = `${id}-diagnostics`;
  const error = node("div", "save-error diagnostic"); error.append(node("strong"), node("p"));
  const recovery = button(`${id}-recovery`, () => {
    const current = view?.groups.find(g => g.id === group.id);
    if (current?.recovery && !saving && !inactive(recovery)) void choose(group.id, current.recovery.choice, recovery.id);
  }); recovery.className = "recovery";
  const retry = button(`${id}-retry`, () => {
    const current = view?.groups.find(g => g.id === group.id);
    if (current && retryAllowed(current) && failure?.choice && !saving && !inactive(retry)) void choose(group.id, failure.choice, retry.id);
  }); retry.className = "retry";
  diagnostics.append(node("div", "diagnostic-content"), error, recovery, retry, node("p", "reselect"));
  const note = node("p", "note"); note.id = `${id}-note`;
  container.append(diagnostics, note);
  for (const choice of group.actions ?? []) container.append(actionButton(group, choice));
  container.append(node("span", "applying visually-hidden"));
  return container;
}
/** Moves `node` to `index` inside `parent` only when it is elsewhere, so a focused row keeps focus. */
function place(parent: Element, node: Element, index: number): void {
  if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
}
/**
 * Items under one heading per consecutive day, in order (the failure rows and the recordings alike): each day's
 * section is found again by its heading, so its rows or cards move only when their day changes; `fill` places the
 * day's items in its content; a day with nothing left goes.
 */
function placeDays<T extends { day: string }>(days: HTMLElement, items: readonly T[], classes: { section: string; content: string },
  fill: (content: HTMLElement, dayItems: T[]) => void): void {
  const groups: Array<{ day: string; items: T[] }> = [];
  for (const item of items) {
    if (groups.at(-1)?.day !== item.day) groups.push({ day: item.day, items: [] });
    groups.at(-1)!.items.push(item);
  }
  const sections = new Map([...days.querySelectorAll<HTMLElement>(`:scope > .${classes.section}`)].map(section => [section.dataset.day!, section]));
  for (const [index, group] of groups.entries()) {
    let section = sections.get(group.day);
    sections.delete(group.day);
    if (!section) {
      section = node("section", classes.section); section.dataset.day = group.day;
      section.append(node("h2", "result-day-heading", group.day), node("div", classes.content));
    }
    place(days, section, index);
    fill(section.querySelector<HTMLElement>(`.${classes.content}`)!, group.items);
  }
  for (const section of sections.values()) section.remove();
}
/** Row headers in reading order, across day groups. */
function resultHeaders(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#recording-results .recording-result > summary")];
}
/** Opens one row and closes every other; a pending save or action keeps its own state by id. */
function openOnly(id: string | undefined): void {
  for (const [key, state] of resultStates) state.open = key === id;
  for (const area of document.querySelectorAll<HTMLDetailsElement>("#recording-results .recording-result")) {
    const open = area.dataset.resultId === id;
    if (area.open !== open) area.open = open;
  }
}
/**
 * The Recording failures tab (plan 047): a status line, then rows grouped by
 * day on the window background, newest first, then the retention footnote.
 * Every row starts collapsed and only one is open at a time; an explicit entry
 * opens its target without acknowledging it.
 */
function updateRecordingResult(focusRequested: boolean): void {
  const results = view?.recordingResults ?? [];
  const panel = document.getElementById("settings-panel")!;
  let list = document.getElementById("recording-results");
  if (selectedTab !== "failures") {
    list?.remove();
    return;
  }
  const status = view?.recordingHistoryStatus ?? "";
  if (!list) {
    list = node("section"); list.id = "recording-results";
    list.setAttribute("aria-labelledby", "tab-failures");
    list.append(node("p", "result-history-status"), node("p", "result-empty"), node("div", "result-days"), node("p", "result-history-note section-footnote"));
    panel.append(list);
  }
  let more = list.querySelector<HTMLButtonElement>(".history-more");
  if (!more) {
    more = button("history-more", () => {
      // Not native disabled: that would drop the focus it has to body, as would the hide after the last page.
      if (more!.getAttribute("aria-disabled") === "true") return;
      more!.setAttribute("aria-disabled", "true");
      const known = new Set(view?.recordingResults?.map(r => r.id));
      void window.settings.choose("history", "more").then(result => {
        const hadFocus = document.activeElement === more;
        render(result.view);
        if (!hadFocus || !more!.hidden || !document.hasFocus()) return;
        const loaded = view?.recordingResults?.find(r => !known.has(r.id)) ?? view?.recordingResults?.at(-1);
        if (loaded) document.getElementById(`${resultDomId(loaded.id)}-summary`)?.focus({ preventScroll: true });
      })
        .catch(() => announce(text("Could not complete this action. Try again.")))
        .finally(() => { more!.removeAttribute("aria-disabled"); });
    });
    more.className = "history-more";
    list.append(more);
  }
  more.hidden = !view?.recordingResultsRemaining;
  setText(more, text("Show more failures"));
  const statusLine = list.querySelector<HTMLElement>(".result-history-status")!;
  statusLine.hidden = !status; setText(statusLine, status);
  const empty = list.querySelector<HTMLElement>(".result-empty")!;
  empty.hidden = Boolean(results.length || status);
  if (empty.dataset.text !== text("No recording failures.")) {
    empty.dataset.text = text("No recording failures.");
    empty.replaceChildren(icon("empty", "empty-icon")!, node("span", "", text("No recording failures.")));
  }
  const note = list.querySelector<HTMLElement>(".result-history-note")!;
  note.hidden = !results.length;
  setText(note, translate("Keeps unreviewed failures and the {count} most recently reviewed. Removing a record does not delete its file.",
    view?.language, { count: REVIEWED_FAILURES_KEPT }));
  const days = list.querySelector<HTMLElement>(".result-days")!;
  const focusId = (results.find(r => !r.acknowledged) ?? results[0])?.id;
  // Taken before any row moves: moving a focused node drops its focus (review of plan 047), so it is given back below.
  const focused = days.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
  // A removed focused row hands focus to the next row that stays (null: none after it, so the last row),
  // not to its old position, which other rows removed or added in the same update would shift.
  let focusAfterRemoval: string | null | undefined;
  const ids = new Set(results.map(r => r.id));
  const previousRows = [...days.querySelectorAll<HTMLDetailsElement>(".recording-result")];
  for (const [position, area] of previousRows.entries()) {
    if (!ids.has(area.dataset.resultId!)) {
      if (focused && area.contains(focused)) {
        focusAfterRemoval = previousRows.slice(position + 1).find(next => ids.has(next.dataset.resultId!))?.dataset.resultId ?? null;
      }
      area.remove(); resultStates.delete(area.dataset.resultId!); resultErrors.delete(area.dataset.resultId!);
    }
  }
  if (!results.length) {
    const hadFocus = focusAfterRemoval !== undefined || list.contains(document.activeElement);
    days.replaceChildren(); resultStates.clear();
    if (hadFocus || focusRequested) document.getElementById(`tab-${selectedTab}`)?.focus({ preventScroll: true });
    return;
  }
  /** Rows whose action had focus before this update; a button replaced or a collapse returns it to the header. */
  const actionFocus = new Set<HTMLDetailsElement>();
  placeDays(days, results, { section: "result-day", content: "result-rows" }, (rows, dayResults) => {
    for (const [index, result] of dayResults.entries()) {
      const domId = resultDomId(result.id);
      let area = document.getElementById(domId) as HTMLDetailsElement | null;
      let state = resultStates.get(result.id);
      if (!state) { state = { open: false, acknowledged: result.acknowledged }; resultStates.set(result.id, state); }
      if (!state.acknowledged && result.acknowledged) state.open = false;
      state.acknowledged = result.acknowledged;
      if (!area) area = resultRow(result.id, domId, state);
      else if (focused && area.querySelector(".result-actions")!.contains(focused)) actionFocus.add(area);
      place(rows, area, index);
      fillRow(area, result);
    }
  });
  // A row that moved to another day group, such as across midnight, keeps the focus it had. This only gives
  // DOM focus back to the element that held it, so it also runs in an inactive window, where it activates nothing.
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  if (focusRequested && focusId) openOnly(focusId);
  for (const area of days.querySelectorAll<HTMLDetailsElement>(".recording-result")) {
    const state = resultStates.get(area.dataset.resultId!);
    if (state && area.open !== state.open) area.open = state.open;
    if (actionFocus.has(area) && (!area.open || !area.contains(document.activeElement)))
      area.querySelector<HTMLElement>(":scope > summary")!.focus({ preventScroll: true });
  }
  if (focusRequested && focusId) {
    const target = document.getElementById(resultDomId(focusId));
    target?.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }
  if (focusAfterRemoval !== undefined) {
    // The row that took the removed one's place, or the new last row; brought into view.
    const next = (focusAfterRemoval === null ? undefined
      : document.getElementById(resultDomId(focusAfterRemoval))?.querySelector<HTMLElement>(":scope > summary"))
      ?? resultHeaders().at(-1);
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest" });
  }
}
/** A collapsed row: its header is the focus target, its details sit indented under the title. */
function resultRow(id: string, domId: string, state: { open: boolean }): HTMLDetailsElement {
  const area = node("details", "recording-result"); area.id = domId; area.dataset.resultId = id;
  const summary = node("summary"); summary.id = `${domId}-summary`;
  const line = node("span", "result-line");
  const unread = node("span", "result-unread"); unread.setAttribute("aria-hidden", "true");
  line.append(unread, node("span", "visually-hidden result-unread-label"), node("span", "result-reason"), node("span", "result-time"), node("span", "result-chevron"));
  line.querySelector(".result-chevron")!.setAttribute("aria-hidden", "true");
  summary.append(line, node("span", "result-outcome"));
  summary.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); area.open = !area.open;
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const headers = resultHeaders();
    const index = headers.indexOf(summary);
    const next = event.key === "Home" ? 0 : event.key === "End" ? headers.length - 1
      : Math.min(headers.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    headers[next]?.focus();
    headers[next]?.scrollIntoView({ block: "nearest" });
  });
  const details = node("div", "result-details");
  // Not live regions: `#feedback` is the one announcer (a row action's failure and a save warning go through it).
  const persistence = node("p", "result-persistence");
  const error = node("p", "result-error");
  const technical = node("details", "result-technical"); technical.append(node("summary"), node("pre"));
  // `toggle` does not bubble to the row, and the panel's own size does not change when its content grows.
  technical.addEventListener("toggle", updateScrollHint);
  details.append(node("p", "result-guidance"), node("p", "result-file"), persistence, node("div", "result-actions"),
    node("p", "result-saving"), error, technical);
  area.append(summary, details);
  area.addEventListener("toggle", () => {
    if (!area.isConnected) return;
    state.open = area.open;
    // One open row at a time.
    if (area.open) openOnly(id);
    updateScrollHint();
  });
  return area;
}
function fillRow(area: HTMLDetailsElement, result: RecordingResultView): void {
  const domId = area.id;
  area.classList.toggle("unread", !result.acknowledged);
  area.querySelector<HTMLElement>(".result-unread")!.hidden = result.acknowledged;
  const unreadLabel = area.querySelector<HTMLElement>(".result-unread-label")!;
  unreadLabel.hidden = result.acknowledged; setText(unreadLabel, text("Unread, "));
  setText(area.querySelector(".result-reason")!, result.reason);
  setText(area.querySelector(".result-time")!, result.time);
  setText(area.querySelector(".result-outcome")!, result.outcome);
  const persistence = area.querySelector<HTMLElement>(".result-persistence")!;
  persistence.hidden = !result.persistenceWarning; setText(persistence, result.persistenceWarning ?? "");
  const file = area.querySelector<HTMLElement>(".result-file")!;
  file.hidden = !result.fileName; setText(file, result.fileName ?? "");
  setText(area.querySelector(".result-guidance")!, result.guidance);
  const actions = area.querySelector<HTMLElement>(".result-actions")!;
  for (const old of actions.querySelectorAll<HTMLButtonElement>("button")) {
    if (!result.actions.some(action => old.dataset.action === action.id)) old.remove();
  }
  const intent = resultIntents.get(result.id);
  const busy = Boolean(intent || result.saving);
  setAttr(area, "aria-busy", String(busy));
  for (const [position, action] of result.actions.entries()) {
    const actionDomId = `${domId}-${action.id}`;
    let el = document.getElementById(actionDomId) as HTMLButtonElement | null;
    if (!el) {
      const actionId = action.id, offeredId = result.id;
      el = button(actionDomId, () => void chooseResult(offeredId, actionId, actionDomId));
      el.dataset.action = actionId;
    }
    place(actions, el, position);
    setText(el, action.label);
    setActionDisabled(el, !action.enabled, busy);
  }
  const savingLine = area.querySelector<HTMLElement>(".result-saving")!;
  const savingText = result.saving || (intent && persistsHistory(intent.action) ? text("Saving this change…") : "");
  savingLine.hidden = !savingText; setText(savingLine, savingText);
  const error = area.querySelector<HTMLElement>(".result-error")!;
  error.hidden = !resultErrors.has(result.id);
  setText(error, error.hidden ? "" : text("Could not complete this action. Try again."));
  const technical = area.querySelector<HTMLDetailsElement>(".result-technical")!;
  // The full path moved here from the row (plan 047); the file name stays above.
  const technicalText = [result.file, result.detail].filter(Boolean).join("\n");
  technical.hidden = !technicalText;
  setText(technical.querySelector("summary")!, text("Technical details"));
  setText(technical.querySelector("pre")!, technicalText);
}

/**
 * The sidebar's foot (2026-10-05): Quit RecordStuff alone, a row with its words like the tabs above it. The credit,
 * the version and the two links stay in General's own footer at every width, so the foot no longer stacks them.
 */
const sidebarAbout = document.getElementById("sidebar-about") as HTMLElement | null;
function updateSidebarAbout(current: SettingsView): void {
  if (!sidebarAbout) return;
  const quit = current.groups.find(group => group.id === "about")?.choices.find(choice => choice.id === "quit");
  sidebarAbout.hidden = !quit;
  if (!quit) return;
  const about = current.groups.find(group => group.id === "about")!;
  // A quit that failed says so where it was clicked: General's About row, which shows the same failure, hides its
  // own Quit beside a sidebar. A link's failure stays in that row, beside the link. `#feedback` announces both.
  const error = sidebarAbout.querySelector<HTMLElement>(".sidebar-error");
  const quitFailed = failure?.group === "about" && failure.choice === "quit";
  if (error) { setText(error, quitFailed ? failure!.text : ""); error.hidden = !quitFailed; }
  const id = "sidebar-about-quit";
  let link = document.getElementById(id) as HTMLButtonElement | null;
  if (!link) {
    link = button(id, () => { if (!inactive(link!)) void choose("about", "quit", id); });
    link.className = "sidebar-quit";
    link.append(aboutIcon("quit"), node("span", "sidebar-quit-label"));
    // Before the error line, so a failure reads under the row it came from.
    sidebarAbout.prepend(link);
  }
  setText(link.querySelector(".sidebar-quit-label")!, quit.label);
  setActionDisabled(link, !about.enabled || !quit.enabled, Boolean(saving));
}
/**
 * The Recordings tab (2026-10-04): the output folder's videos as cards grouped by day, newest first.
 * A card plays in the page's own player, and drags out as the file itself into another app. Cards are
 * kept by id, so a refresh after a save or a focus change neither reloads thumbnails nor moves focus.
 */
/**
 * The Recordings section while another tab is open: kept out of the document rather than dropped, so coming back
 * reconciles the same cards instead of building them again and fetching and decoding every thumbnail anew.
 */
let libraryArea: HTMLElement | undefined;
/**
 * The last of the tab's file actions (a card's, or the header's Show in Finder) when it failed, shown under the header
 * until the next one starts: `announce` alone reaches only a screen reader, and a sighted user would see nothing change.
 */
let libraryError: string | undefined;
function updateLibrary(): void {
  const library = view?.library;
  const panel = document.getElementById("settings-panel")!;
  let area = document.getElementById("library") ?? libraryArea;
  // The card menu lives in the top layer, outside the tab: it leaves with its cards, or its items would act on a hidden recording.
  if (selectedTab !== "library") { closeClipMenu(false); libraryArea = area ?? undefined; area?.remove(); return; }
  libraryArea = undefined;
  if (area && !area.isConnected) panel.append(area);
  if (!area) {
    area = node("section"); area.id = "library"; area.setAttribute("aria-labelledby", "tab-library");
    const head = node("div", "library-head");
    const reveal = button("library-reveal", () => { if (!inactive(reveal)) void revealFolder(reveal); });
    head.append(node("p", "library-summary"), reveal);
    const empty = node("div", "library-empty");
    empty.append(icon("film", "empty-icon")!, node("p", "library-empty-title"), node("p", "library-empty-detail"));
    area.append(head, node("p", "library-error"), node("p", "library-status"), empty, node("div", "library-days"));
    panel.append(area);
  }
  const items = library?.items ?? [];
  const summary = area.querySelector<HTMLElement>(".library-summary")!;
  setText(summary, library?.summary ?? ""); summary.hidden = !library?.summary;
  const reveal = area.querySelector<HTMLButtonElement>("#library-reveal")!;
  // The header's Show in Finder is the Output folder row's own: it follows that choice, which a recording does not lock,
  // and says what main named it there.
  const folderGroup = view?.groups.find(group => group.id === "outputFolder");
  const folderReveal = folderGroup?.choices.find(choice => choice.id === "reveal");
  setText(reveal, folderReveal?.label ?? text(platform() === "darwin" ? "Show in Finder" : "Open folder"));
  setActionDisabled(reveal, !folderGroup?.enabled || !folderReveal?.enabled, Boolean(saving));
  const error = area.querySelector<HTMLElement>(".library-error")!;
  setText(error, libraryError ?? ""); error.hidden = !libraryError;
  const status = area.querySelector<HTMLElement>(".library-status")!;
  setText(status, library?.status ?? ""); status.hidden = !library?.status;
  const empty = area.querySelector<HTMLElement>(".library-empty")!;
  empty.hidden = Boolean(items.length || library?.status || !library);
  setText(empty.querySelector(".library-empty-title")!, text("No recordings yet"));
  setText(empty.querySelector(".library-empty-detail")!, translate("Recordings saved to {path} appear here.", view?.language, { path: library?.folder ?? "" }));
  const days = area.querySelector<HTMLElement>(".library-days")!;
  const focused = days.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
  const ids = new Set(items.map(item => item.id));
  // The card that held focus, or whose recording plays in the focused player: when it leaves the folder (moved to the
  // Trash here, deleted in Finder), the card after it takes its place, else the one before, as a removed failure row's does.
  const previousCards = [...days.querySelectorAll<HTMLElement>(".clip")];
  const playing = player?.open && player.contains(document.activeElement) ? player.dataset.id : undefined;
  const leaving = previousCards.findIndex(card => !ids.has(card.dataset.id!) && ((focused && card.contains(focused)) || card.dataset.id === playing));
  const remaining = (cards: HTMLElement[]): string | undefined => cards.find(card => ids.has(card.dataset.id!))?.dataset.id;
  const successor = leaving < 0 ? undefined
    : remaining(previousCards.slice(leaving + 1)) ?? remaining(previousCards.slice(0, leaving).reverse()) ?? null;
  for (const card of previousCards) if (!ids.has(card.dataset.id!)) card.remove();
  placeDays(days, items, { section: "library-day", content: "library-grid" }, (grid, dayItems) => {
    for (const [position, item] of dayItems.entries()) {
      const card = document.getElementById(`clip-${item.id}`) ?? clipCard(item.id);
      place(grid, card, position);
      fillClip(card, item);
    }
  });
  // The player's or the menu's recording left the folder (moved to the Trash here or elsewhere); closing the player
  // hands focus back to its card, which is gone, so the successor below is chosen after it.
  if (player?.open && !ids.has(player.dataset.id ?? "")) player.close();
  // Also while the window is inactive (deleted in Finder): the page keeps its own focus for when the user comes back,
  // and focusing inside an inactive window does not bring it forward (review batch 3).
  if (successor !== undefined) {
    (successor === null ? document.getElementById("tab-library") : document.querySelector<HTMLElement>(`#clip-${successor} .clip-open`))
      ?.focus({ preventScroll: true });
  } else if (focused && !focused.isConnected) document.getElementById("tab-library")?.focus({ preventScroll: true });
  else if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  if (clipMenu?.id && !ids.has(clipMenu.id)) {
    const inMenu = clipMenu.el.contains(document.activeElement);
    closeClipMenu(false);
    if (inMenu) document.getElementById("tab-library")?.focus({ preventScroll: true });
  }
}
/**
 * The header's Show in Finder is the Output folder row's own action, whose failure that row shows on another tab:
 * this tab says it too, as the latest of its file actions.
 */
async function revealFolder(control: HTMLButtonElement): Promise<void> {
  const before = requestId;
  await choose("outputFolder", "reveal", control.id);
  // Refused while another save ran: nothing happened, so the line keeps what it said.
  if (requestId === before) return;
  libraryError = failure?.group === "outputFolder" && failure.choice === "reveal" ? failure.text : undefined;
  updateLibrary();
}
const libraryItem = (id: string): LibraryItemView | undefined => view?.library?.items.find(item => item.id === id);
function clipCard(id: string): HTMLElement {
  const card = node("div", "clip"); card.id = `clip-${id}`; card.dataset.id = id; card.draggable = true;
  const open = button(`clip-${id}-open`, () => { const item = libraryItem(id); if (item) openPlayer(item); });
  open.className = "clip-open";
  const thumb = node("span", "clip-thumb");
  const image = node("img"); image.alt = ""; image.loading = "lazy"; image.decoding = "async";
  image.addEventListener("error", () => thumb.classList.add("no-thumb"));
  image.addEventListener("load", () => thumb.classList.remove("no-thumb"));
  const play = node("span", "clip-play"); play.setAttribute("aria-hidden", "true"); play.append(icon("play", "play-icon")!);
  const fallback = icon("film", "clip-fallback")!;
  thumb.append(fallback, image, node("span", "clip-duration"), play);
  const label = node("span", "clip-text");
  label.append(node("span", "clip-title"), node("span", "clip-meta"));
  open.append(thumb, label);
  // What can be done with the file, before it is opened (2026-10-04): this button, or a right-click on the card.
  const more = button(`clip-${id}-more`, () => toggleClipMenu(id, more));
  // `aria-controls` names the menu only while it is open for this card: until the first one opens it does not exist.
  more.className = "clip-more"; more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
  more.append(icon("more", "more-icon")!);
  card.append(open, more);
  card.addEventListener("contextmenu", event => { event.preventDefault(); openClipMenu(id, more, { x: event.clientX, y: event.clientY }); });
  card.addEventListener("animationend", () => card.classList.remove("arrived"));
  // Without motion the outline does not fade; it goes once the user moves on.
  card.addEventListener("focusout", () => card.classList.remove("arrived"));
  // The file itself leaves the window: main starts a native drag with it, so any app that takes files can take it.
  card.addEventListener("dragstart", event => {
    event.preventDefault();
    // Its reply is the view main now counts as delivered (settings-window.ts `deliver`), so it is drawn like any other.
    void window.settings.choose(`recordingFile:${id}`, "drag").then(result => render(result.view), () => {});
  });
  return card;
}
function fillClip(card: HTMLElement, item: LibraryItemView): void {
  // Every push draws the tab again, each second of a countdown too: a card whose item and language are unchanged has
  // nothing to look up or word, which across a folder of hundreds of recordings is most of the work.
  const filled = `${view?.language ?? ""}\n${JSON.stringify(item)}`;
  if (card.dataset.filled === filled) return;
  card.dataset.filled = filled;
  const image = card.querySelector("img")!;
  if (image.getAttribute("src") !== item.thumbnail) {
    // A new version of the file gets its own try: a hidden lazy image might never load, keeping the film icon for good.
    image.parentElement!.classList.remove("no-thumb");
    image.src = item.thumbnail;
  }
  const duration = card.querySelector<HTMLElement>(".clip-duration")!;
  setText(duration, item.duration ?? ""); duration.hidden = !item.duration;
  setText(card.querySelector(".clip-title")!, item.title);
  // The length is on the thumbnail already; under it goes the size (desktop.md#recordings). The button's name keeps both.
  setText(card.querySelector(".clip-meta")!, item.size);
  setAttr(card, "title", sentences([item.name, text("Drag into another app to share.")], view?.language));
  setAttr(card.querySelector(".clip-open")!, "aria-label", translate("Play {title}", view?.language, { title: phrases([item.day, item.title, item.duration, item.size].filter((part): part is string => Boolean(part)), view?.language) }));
  // Its own tooltip, too: without one the card's, about dragging, shows over the button that opens the actions.
  const more = card.querySelector<HTMLElement>(".clip-more")!;
  const moreLabel = translate("More actions for {title}", view?.language, { title: phrases([item.day, item.title], view?.language) });
  setAttr(more, "aria-label", moreLabel); setAttr(more, "title", moreLabel);
}
type FileAction = "reveal" | "open" | "trash";
/**
 * A card's file actions (2026-10-04): Show in Finder, Open in the default app and Move to Trash, chosen
 * before the recording is opened. One menu in the top layer serves every card; arrows and the pointer move through it,
 * Escape closes it and gives focus back, and a click elsewhere or the window losing focus closes it; a scroll carries it
 * along with its card, and closes it once the card leaves the panel.
 */
let clipMenu: { el: HTMLElement; id?: string; anchor?: HTMLButtonElement; offset?: { x: number; y: number } } | undefined;
function clipMenuElement(): HTMLElement {
  if (clipMenu) return clipMenu.el;
  const el = node("div", "clip-menu"); el.id = "clip-menu"; el.setAttribute("role", "menu"); el.setAttribute("popover", "manual");
  for (const action of ["reveal", "open", "trash"] as const) {
    const item = button(`clip-menu-${action}`, () => {
      const id = clipMenu?.id, anchor = clipMenu?.anchor;
      if (id && anchor) void fileAction(id, action, anchor);
    });
    item.setAttribute("role", "menuitem"); item.tabIndex = -1; item.dataset.action = action;
    item.append(icon(`file-${action}`, "menu-icon")!, node("span", "menu-label"));
    // Set apart from the others, as Finder does: the one action that takes the file away.
    if (action === "trash") { const line = node("div", "menu-separator"); line.setAttribute("role", "separator"); el.append(line); }
    el.append(item);
  }
  // The pointer takes the highlight with it, as in a native menu: one item is lit, and the arrows go on from there.
  el.addEventListener("pointermove", event => {
    const item = (event.target as Element).closest<HTMLButtonElement>("[role=menuitem]");
    if (item && item !== document.activeElement) item.focus({ preventScroll: true });
  });
  el.addEventListener("keydown", event => {
    const items = [...el.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
    if (to !== undefined) { event.preventDefault(); items[to]!.focus(); return; }
    // Escape and Tab belong to the menu, before the page's own Escape closes the window.
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); closeClipMenu(true); }
  });
  document.body.append(el);
  clipMenu = { el };
  return el;
}
function toggleClipMenu(id: string, anchor: HTMLButtonElement): void {
  // Open while it has an anchor: the popover is manual, so nothing but `closeClipMenu` hides it.
  if (clipMenu?.id === id && clipMenu.anchor) closeClipMenu(true);
  else openClipMenu(id, anchor);
}
/** Under the ⋯ button, or at the pointer for a right-click, kept inside the window. */
function openClipMenu(id: string, anchor: HTMLButtonElement, at?: { x: number; y: number }): void {
  if (!libraryItem(id)) return;
  const el = clipMenuElement();
  closeClipMenu(false);
  const mac = platform() === "darwin";
  setText(el.querySelector("#clip-menu-reveal .menu-label")!, text(mac ? "Show in Finder" : "Open folder"));
  setText(el.querySelector("#clip-menu-open .menu-label")!, text("Open"));
  setText(el.querySelector("#clip-menu-trash .menu-label")!, text(mac ? "Move to Trash" : "Move to Recycle Bin"));
  // One menu serves every card: it takes the name of the ⋯ button it opened from, "More actions for Today, 2:02 PM".
  el.setAttribute("aria-labelledby", anchor.id);
  el.showPopover?.();
  const box = anchor.getBoundingClientRect(), size = el.getBoundingClientRect();
  // Kept relative to the ⋯ button, so the menu moves with its card when the panel scrolls.
  const offset = at ? { x: at.x - box.left, y: at.y - box.top } : { x: box.width - size.width, y: box.height + 4 };
  clipMenu = { el, id, anchor, offset };
  placeClipMenu();
  // A card out of the panel closes the menu as it is placed: nothing is left to expand or focus (review pass 1, F3).
  if (clipMenu.anchor !== anchor) return;
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", el.id);
  el.querySelector<HTMLButtonElement>("[role=menuitem]")!.focus({ preventScroll: true });
}
/** Beside its card, flipped above it when there is no room below and kept inside the window; a card scrolled out of the panel closes it. */
function placeClipMenu(): void {
  if (!clipMenu?.anchor || !clipMenu.offset) return;
  const { el, anchor, offset } = clipMenu;
  // A rebuilt panel took the card away: there is nothing left to place the menu by.
  if (!anchor.isConnected) { closeClipMenu(false); return; }
  const box = anchor.getBoundingClientRect(), size = el.getBoundingClientRect();
  // The whole card decides: a right-click can land on its visible part while ⋯ is scrolled out of the panel.
  const card = (anchor.closest(".clip") ?? anchor).getBoundingClientRect();
  const panel = anchor.closest("#settings-panel")?.getBoundingClientRect();
  if (panel && (card.bottom < panel.top || card.top > panel.bottom)) { closeClipMenu(true); return; }
  const x = box.left + offset.x, y = box.top + offset.y;
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - size.width - 8))}px`;
  // Flipped above when there is no room below; either way never above the window's top (review pass 2, P2-1).
  el.style.top = `${Math.max(8, y + size.height + 8 > innerHeight ? Math.min(y, box.top) - size.height - 4 : y)}px`;
}
function closeClipMenu(restoreFocus: boolean): void {
  if (!clipMenu?.anchor) return;
  const { el, anchor } = clipMenu;
  clipMenu = { el };
  anchor.setAttribute("aria-expanded", "false");
  anchor.removeAttribute("aria-controls");
  el.hidePopover?.();
  if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
}
document.addEventListener("pointerdown", event => {
  if (clipMenu?.anchor && !clipMenu.el.contains(event.target as Node) && !clipMenu.anchor.contains(event.target as Node)) closeClipMenu(false);
}, true);
document.addEventListener("scroll", placeClipMenu, true);
window.addEventListener("resize", placeClipMenu);
// Focus inside a hidden menu would fall to the page, where the next Escape closes the window: it goes back to the ⋯ button.
window.addEventListener("blur", () => closeClipMenu(true));
/** Cards whose file action main has not answered yet: on a slow volume a second Move to Trash would find the file gone. */
const fileActionsPending = new Set<string>();
/**
 * Runs a card's file action and says how it went. Focus waits on the card's ⋯ button, so a recording that left
 * the folder hands it to its neighbour when the reply is rendered (`updateLibrary`).
 */
async function fileAction(id: string, action: FileAction, anchor: HTMLButtonElement): Promise<void> {
  closeClipMenu(false);
  anchor.focus({ preventScroll: true });
  // The first choice stands; its answer is what the card then says.
  if (fileActionsPending.has(id)) return;
  fileActionsPending.add(id);
  libraryError = undefined;
  let problem: string | undefined;
  try {
    const result = await window.settings.choose(`recordingFile:${id}`, action);
    render(result.view);
    if (!result.applied) problem = libraryItem(id) ? (result.failure ?? text("Could not complete this action. Try again.")) : text("This recording is no longer in the folder.");
    else if (action === "trash") announce(text(platform() === "darwin" ? "Moved to the Trash" : "Moved to the Recycle Bin"));
  } catch {
    problem = text("Could not complete this action. Try again.");
  } finally {
    fileActionsPending.delete(id);
  }
  libraryError = problem;
  // Drawn even when nothing failed, so a message an earlier action left goes.
  updateLibrary();
  if (problem) announce(problem);
}
/** The in-page player: a modal dialog with the video and Close, closed by Escape, Close or the recording leaving; closing stops and releases the file. */
let player: HTMLDialogElement | undefined;
/** The player's announcer, inside the dialog (see `announce`). */
let playerFeedback: HTMLElement | undefined;
let playerControlsUi: PlayerControls | undefined;
/** Four arrows pointing out: full screen, as the full-screen window's way out points in. */
const FULL_SCREEN_MARK = "M4 9V4h5v1.8H5.8V9ZM15 4h5v5h-1.8V5.8H15ZM18.2 15H20v5h-5v-1.8h3.2ZM4 15h1.8v3.2H9V20H4Z";
const CLOSE_MARK = "M6.3 5 12 10.7 17.7 5 19 6.3 13.3 12l5.7 5.7-1.3 1.3-5.7-5.7L6.3 19 5 17.7l5.7-5.7L5 6.3Z";
const playerLabels = (): PlayerLabels => ({ play: text("Play"), pause: text("Pause"), mute: text("Mute"), unmute: text("Unmute"), volume: text("Volume"), position: text("Playback position") });
function openPlayer(item: LibraryItemView): void {
  closeClipMenu(false);
  if (!player) {
    player = node("dialog", "player"); player.setAttribute("aria-labelledby", "player-title");
    const video = node("video"); video.playsInline = true;
    // The page's own controls (player-controls.ts): opening focuses the picture, so Space plays and pauses.
    video.autofocus = true;
    // A double-click plays full screen, in a window of its own (playFullScreen), as YouTube's does.
    video.addEventListener("dblclick", event => { event.preventDefault(); void playFullScreen(); });
    // The title over the top edge with Close beside it, as YouTube's full screen shows its title (2026-10-05).
    const heading = node("div", "pc-heading");
    const info = node("div", "pc-heading-text");
    const title = node("p", "pc-title"); title.id = "player-title";
    info.append(title, node("p", "pc-meta player-meta"), node("p", "pc-error player-error"));
    // Watching is all the player does (2026-10-04): the file's actions are on its card, before it is opened.
    const close = controlButton("player-close"); close.addEventListener("click", () => player!.close()); close.append(mark(CLOSE_MARK));
    heading.append(info, close);
    const fullScreen = controlButton("player-fullscreen"); fullScreen.addEventListener("click", () => void playFullScreen()); fullScreen.append(mark(FULL_SCREEN_MARK));
    playerControlsUi = playerControls(video, { id: "player", labels: playerLabels(), top: heading, trailing: [fullScreen], fullScreen: () => void playFullScreen() });
    playerFeedback = node("p", "visually-hidden"); playerFeedback.setAttribute("role", "status"); playerFeedback.setAttribute("aria-live", "polite");
    player.append(playerControlsUi.root, playerFeedback);
    player.addEventListener("close", () => { video.pause(); video.removeAttribute("src"); video.load(); });
    // While the full-screen window is on its way (shown once its first frame is drawn), this window still takes
    // clicks and keys: a play here would sound alongside it for the whole full screen, so it stops at once.
    video.addEventListener("play", () => { if (fullScreenPending) video.pause(); });
    // A file that left the folder since it was listed, a damaged one, or a format Chromium cannot decode: say so, and
    // where Open is. Closing empties the source on purpose, which is not a failure to report.
    video.addEventListener("error", () => {
      if (!player?.open || !video.getAttribute("src")) return;
      const message = text("This recording cannot be played here. Choose Open from its ⋯ menu to play it in another app.");
      const error = player.querySelector<HTMLElement>(".player-error")!;
      setText(error, message); error.hidden = false;
      announce(message);
    });
    // Escape closing the player starts the pause in which further Escapes close nothing (see `escapeClosed`). Chromium
    // can close it on Escape without a keydown the page sees (2026-10-04, right after a fullscreen), so it is
    // marked here, where both ways arrive.
    player.addEventListener("cancel", () => { escapeClosed = performance.now(); });
    // A click on the backdrop, outside the dialog's own box, closes it. Only a press that began there: a press on the
    // video or the title released over the backdrop also arrives as a click on the dialog, its common ancestor.
    let pressedOnBackdrop = false;
    player.addEventListener("pointerdown", event => { pressedOnBackdrop = event.target === player; });
    player.addEventListener("click", event => { if (event.target === player && pressedOnBackdrop) player!.close(); });
    document.body.append(player);
  }
  player.dataset.id = item.id;
  setText(player.querySelector("#player-title")!, phrases([item.day, item.title], view?.language));
  setText(player.querySelector(".player-meta")!, [item.name, item.duration, item.size].filter(Boolean).join(" · "));
  player.querySelector<HTMLElement>(".player-error")!.hidden = true;
  setText(playerFeedback!, "");
  for (const [id, label] of [["player-close", text("Close")], ["player-fullscreen", text("Full screen")]] as const) {
    const el = player.querySelector<HTMLElement>(`#${id}`)!;
    setAttr(el, "aria-label", label); setAttr(el, "title", label);
  }
  playerControlsUi!.relabel(playerLabels());
  const video = player.querySelector("video")!;
  video.src = item.video;
  player.showModal();
  playerControlsUi!.wake();
  void video.play().catch(() => {});
}
/** Whether a full-screen play is under way: the player waits for it, and a second request is not sent. */
let fullScreenPending = false;
/** How many times RecordStuff was hidden: a full screen that ends after a hide leaves the player paused. */
let hideCount = 0;
/**
 * Plays the player's recording full screen in a window of its own (2026-10-05): this window keeps its size. The
 * video here pauses meanwhile; main answers once the viewer has left, with where the video was, and the player
 * carries on from there, playing if it was. A player closed or showing another recording by then is left alone.
 */
async function playFullScreen(): Promise<void> {
  const shown = player;
  const id = shown?.dataset.id;
  if (!shown?.open || !id || fullScreenPending) return;
  const video = shown.querySelector("video")!;
  const state = playbackOf(video);
  fullScreenPending = true;
  video.pause();
  // Without a state handed back (ended by main, as when RecordStuff is hidden), the player stays paused where it was.
  let end: PlaybackState = { ...state, playing: false };
  const hides = hideCount;
  try {
    const result = await window.settings.choose(`recordingFile:${id}`, { action: "fullscreen", state } satisfies FullScreenChoice);
    render(result.view);
    end = result.playback ?? end;
  } catch {
    // Not played full screen: the player simply goes on.
  } finally {
    fullScreenPending = false;
  }
  if (!shown.open || shown.dataset.id !== id) return;
  // Hidden meanwhile, even while the fullscreen faded out after the viewer left it: nothing starts unseen.
  if (hideCount !== hides) end = { ...end, playing: false };
  // The Escapes that ended it, pressed again, close nothing here (main also drops them for a second).
  escapeClosed = performance.now();
  video.volume = end.volume; video.muted = end.muted;
  video.currentTime = end.time;
  if (end.playing) void video.play().catch(() => {});
  video.focus({ preventScroll: true });
}
/** A tab label's trailing unread count, "Failures (2)" or 「失敗（2）」: the name, the opening bracket, the count, the closing one. */
const UNREAD_COUNT = /^(.*?)(\s?[（(])(\d+)([)）])$/;
/** The tab's name without its count, as the page title shows it. */
const tabName = (label: string): string => UNREAD_COUNT.exec(label)?.[1] ?? label;
/**
 * A tab's icon and label; an unread count, "Failures (2)", becomes a badge. The parentheses stay
 * in the text, visually hidden, so the label reads and matches as main wrote it.
 */
function tabLabel(el: HTMLElement, id: string, label: string): void {
  if (el.dataset.label === label) return;
  el.dataset.label = label;
  const count = UNREAD_COUNT.exec(label);
  const tabIcon = icon(`tab-${id}`, "tab-icon");
  const name = node("span", "tab-name", count ? count[1] : label);
  el.replaceChildren(...(tabIcon ? [tabIcon] : []), name);
  if (count) el.append(node("span", "visually-hidden", count[2]), node("span", "tab-badge", count[3]), node("span", "visually-hidden", count[4]));
}
/** The sidebar lists the tabs in a column (settings.css, from 600 px): assistive technology is told which axis. */
const sidebarLayout = matchMedia("(min-width: 600px)");
function updateTabOrientation(): void {
  const tablist = form.querySelector('[role="tablist"]');
  if (tablist) setAttr(tablist, "aria-orientation", sidebarLayout.matches ? "vertical" : "horizontal");
}
sidebarLayout.addEventListener("change", updateTabOrientation);
function updateScrollHint(): void {
  const panel = document.getElementById("settings-panel");
  const hint = document.getElementById("scroll-hint");
  if (panel && hint) hint.hidden = panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 2;
}
let scrollObserver: ResizeObserver | undefined;
function draw(): void {
  if (!view) return;
  const current = view;
  // An explicit entry (tray or notification) selects its tab once per token: failures (plan 047) unless it names another.
  const focusRequested = (current.resultFocus ?? 0) > resultFocus;
  resultFocus = current.resultFocus ?? 0;
  const entryTab = current.entryTab ?? "failures";
  // A view without the open tab (an older main, a fixture's own view) opens its first one instead of nothing.
  if (!current.tabs.some(tab => tab.id === selectedTab) && current.tabs[0]) selectedTab = current.tabs[0].id;
  // An entry's destination is behind the player's modal, where nothing can take focus: the player closes first.
  if (focusRequested && player?.open) player.close();
  if (focusRequested) {
    // Like a tab click: the editor leaves with its tab, and main must not keep both shortcuts suspended.
    if (selectedTab !== entryTab && (shortcutGroup()?.capturing || arming)) void capture(false);
    selectedTab = entryTab;
  }
  document.documentElement.lang = documentLanguage(current.language);
  // The status card's lock hint is about the settings: the stylesheet leaves it out beside the recordings and failures.
  if (document.documentElement.dataset.tab !== selectedTab) document.documentElement.dataset.tab = selectedTab;
  // macOS insets the window controls in the page's top edge, which then leaves room for them.
  const platformName = shortcutGroup()?.platform;
  if (platformName && document.documentElement.dataset.platform !== platformName) document.documentElement.dataset.platform = platformName;
  if (document.title !== current.title) document.title = current.title;
  setText(heading, current.title); setText(hint, current.hint); hint.hidden = !current.hint;
  updateStatus(current);
  updateSidebarAbout(current);
  const groups = current.groups.filter(g => g.tab === selectedTab);
  /** Set when the panel was rebuilt: the offset it gets once everything above its content has settled. */
  let restoreScroll: number | undefined;
  const structure = JSON.stringify([selectedTab, current.tabs.map(t => t.id), groups.map(g => [g.id, g.kind, g.control, g.section, g.control === "segmented" ? g.choices.map(c => c.id) : null])]);
  if (structure !== renderedStructure) {
    renderedStructure = structure;
    // The rebuild removes the open explanation's nodes without a leave or blur, so its state goes first.
    hideInfo();
    const active = document.activeElement;
    const restore = active instanceof HTMLElement && form.contains(active) ? active.id : "";
    const scroll = document.getElementById("settings-panel")?.scrollTop ?? 0;
    // Switching away stores the old tab's position; returning brings it back, a first visit starts at the top.
    if (renderedTab && renderedTab !== selectedTab) tabScroll.set(renderedTab, scroll);
    const target = renderedTab === selectedTab ? scroll : tabScroll.get(selectedTab) ?? 0;
    renderedTab = selectedTab;
    const tabs = node("div", "tabs"); tabs.setAttribute("role", "tablist");
    for (const tab of current.tabs) {
      const activate = (): void => {
        if (shortcutGroup()?.capturing || arming) void capture(false);
        selectedTab = tab.id; draw(); document.getElementById(`tab-${tab.id}`)?.focus();
      };
      const el = button(`tab-${tab.id}`, activate);
      el.setAttribute("role", "tab"); el.setAttribute("aria-selected", String(selectedTab === tab.id)); el.setAttribute("aria-controls", "settings-panel"); el.tabIndex = selectedTab === tab.id ? 0 : -1;
      el.addEventListener("keydown", event => {
        // Both axes: the tabs are a row in a narrow window and a column in the sidebar.
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = current.tabs.findIndex(t => t.id === selectedTab);
        const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
        const next = event.key === "Home" ? 0 : event.key === "End" ? current.tabs.length - 1 : (index + (forward ? 1 : -1) + current.tabs.length) % current.tabs.length;
        document.getElementById(`tab-${current.tabs[next]!.id}`)?.click();
      }); tabs.append(el);
    }
    const panel = node("div"); panel.id = "settings-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `tab-${selectedTab}`);
    // The open tab's name over its content, where the sidebar layout has no tab strip above it; not a heading
    // of its own, since the tab already names the panel.
    const pageTitle = node("p", "page-title"); pageTitle.id = "page-title"; pageTitle.setAttribute("aria-hidden", "true"); panel.append(pageTitle);
    let section: HTMLElement | undefined; let previous: string | undefined;
    for (const group of groups) {
      const sectionId = group.section ?? group.id;
      if (!section || sectionId !== previous) {
        section = node("section", group.id === "about" ? "section about" : "section");
        const title = node("h2", "section-heading"); title.id = `${controlId(group)}-section-heading`;
        const footnote = node("p", "section-footnote"); footnote.hidden = true;
        section.append(title, node("div", "inset-list"), footnote); panel.append(section); previous = sectionId;
      }
      section.querySelector(".inset-list")!.append(row(group));
    }
    const viewport = node("div", "settings-viewport");
    const scrollHint = node("div", "scroll-hint"); scrollHint.id = "scroll-hint";
    scrollHint.setAttribute("aria-hidden", "true"); scrollHint.hidden = true;
    viewport.append(panel, scrollHint);
    panel.addEventListener("scroll", updateScrollHint, { passive: true });
    scrollObserver?.disconnect();
    scrollObserver = new ResizeObserver(updateScrollHint);
    scrollObserver.observe(panel);
    // The recordings outlive the panel they were drawn in (`libraryArea`); `updateLibrary` places them below.
    libraryArea ??= document.getElementById("library") ?? undefined;
    // The status card follows the tabs in the page's order, as the sidebar draws it under them (its grid row) and a
    // narrow window above the content: the first Tab reaches the tabs, not a card drawn at the sidebar's foot.
    form.replaceChildren(tabs, statusCard, viewport);
    updateRows(groups);
    if (restore && document.hasFocus()) {
      const destination = isCaptureControl(restore) && !shortcutGroup()?.capturing ? "setting-hotkey" : restore;
      const focusTarget = document.getElementById(destination);
      if (focusTarget && !focusTarget.closest("[hidden]")) focusTarget.focus({ preventScroll: true });
      else if (isRecoveryControl(restore)) groupControl(restore.replace(/^setting-|-(recovery|retry)$/g, ""))?.focus({ preventScroll: true });
    }
    // Rows first; the offset is applied below, once the panel, failure rows and recordings included, is complete.
    updateRecordingResult(false);
    updateLibrary();
    restoreScroll = target;
  } else updateRows(groups);
  setAttr(form.querySelector('[role="tablist"]')!, "aria-label", current.title);
  updateTabOrientation();
  for (const tab of current.tabs) {
    const el = document.getElementById(`tab-${tab.id}`)!;
    tabLabel(el, tab.id, tab.label);
    if (tab.accessibleLabel) setAttr(el, "aria-label", tab.accessibleLabel); else if (el.hasAttribute("aria-label")) el.removeAttribute("aria-label");
  }
  const openTab = current.tabs.find(tab => tab.id === selectedTab);
  if (openTab) setText(document.getElementById("page-title")!, tabName(openTab.label));
  for (const group of groups) {
    const title = document.getElementById(`${controlId(group)}-section-heading`);
    if (title) { setText(title, group.sectionHeading ?? ""); title.hidden = !group.sectionHeading; }
  }
  // After the headings above settle, so scroll anchoring cannot shift the restored offset; an entry's own scroll wins.
  if (restoreScroll !== undefined) document.getElementById("settings-panel")!.scrollTop = restoreScroll;
  // A rebuilt panel filled its failure rows and recordings above; only an entry still has focus to place in them.
  if (restoreScroll === undefined || focusRequested) {
    updateRecordingResult(focusRequested);
    updateLibrary();
  }
  // A saved recording's entry lands on its card, outlined for a moment, without playing it.
  if (focusRequested && entryTab === "library" && current.libraryFocus) {
    const card = document.getElementById(`clip-${current.libraryFocus}`);
    if (card) {
      card.scrollIntoView({ block: "nearest" });
      card.querySelector<HTMLElement>(".clip-open")?.focus({ preventScroll: true });
      card.classList.remove("arrived"); void card.offsetWidth; card.classList.add("arrived");
    }
  } else if (focusRequested && entryTab === "library") document.getElementById("tab-library")?.focus({ preventScroll: true });
  // The shortcut entry lands on the card's control, as the failures entry lands on its row.
  // An editor already open there keeps its own focus.
  if (focusRequested && entryTab === "general" && !shortcutGroup()?.capturing && !arming) document.getElementById("setting-hotkey")?.focus();
  updateScrollHint();
}
/**
 * A shortcut card's note and diagnostics as its editor opened: main hides them
 * while the editor is open, and the same ones returning when it closes are not news.
 */
const beforeCapture = new Map<string, string>();
const captureNews = (group: SettingsGroup): string => JSON.stringify([group.note, group.diagnostics]);
function render(next: SettingsView): void {
  if (next.revision !== undefined && view?.revision !== undefined && next.revision < view.revision) return;
  const previous = view;
  const returned = new Set<string>();
  let endedByMain = false;
  for (const group of next.groups) {
    const old = previous?.groups.find(o => o.id === group.id);
    if (group.capturing && !old?.capturing) beforeCapture.set(group.id, old ? captureNews(old) : "");
    else if (!group.capturing && old?.capturing) {
      if (beforeCapture.get(group.id) === captureNews(group)) returned.add(group.id);
      beforeCapture.delete(group.id);
      // Cancelled, timed out or saved: a key the closed editor refused is no longer what the card is about.
      if (failure?.group === group.id && failure.editor) failure = undefined;
      // Main ended it (its time limit, a recording starting) while the user may still be typing a combination.
      if (!closingCapture && !(saving && isCaptureControl(saving.control))) endedByMain = true;
    }
  }
  if (!next.groups.some(group => group.kind === "shortcut" && group.capturing)) { candidateToConfirm = undefined; preview = ""; previewParts = []; }
  view = next;
  if (startupFailed) {
    // A later push drew the panel after all: the read's error is no longer true, and the region is an announcer again.
    startupFailed = false;
    feedback.classList.add("visually-hidden");
    announce("");
  }
  const focusedBefore = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
  draw();
  // A push can hide the status card or remove a row's action while it has focus (a problem solved from the tray, an
  // action main no longer offers): the tab keeps the place, so the next Tab does not start over and the next Escape
  // does not close the window. A choice's own reply is left to `choose`, which knows the row that stands for it.
  if (focusedBefore && !pending && document.hasFocus() && (!focusedBefore.isConnected || focusedBefore.closest("[hidden]"))
    && (document.activeElement === document.body || document.activeElement === focusedBefore))
    document.getElementById(`tab-${selectedTab}`)?.focus({ preventScroll: true });
  reportReady();
  if (previous) {
    // Only news is read out: a language switch retranslates every note and row without changing them.
    const sameLanguage = previous.language === next.language;
    const say = (parts: string[]): string => sentences(parts.filter(Boolean), next.language);
    const changes = next.groups.filter(g => sameLanguage && g.tab === selectedTab && !returned.has(g.id)).flatMap(g => {
      const old = previous.groups.find(o => o.id === g.id);
      const messages: string[] = [];
      // A status note a diagnostic also states as its reason is read once, with the diagnostic.
      const reasons = new Set((g.diagnostics ?? []).map(d => d.reason));
      // A finished action (the update check) is news even when its result repeats the last one.
      const finished = Boolean(old?.choices.some(c => c.busy)) && !g.choices.some(c => c.busy);
      if (g.noteKind === "status" && g.note && (old?.note !== g.note || finished) && !reasons.has(g.note)) messages.push(g.note);
      if (JSON.stringify(old?.diagnostics) !== JSON.stringify(g.diagnostics)) messages.push(...(g.diagnostics ?? []).map(d => say([d.heading, d.reason, d.guidance])));
      return messages;
    });
    if (endedByMain && document.hasFocus()) changes.unshift(next.groups.some(g => g.captureTimedOut)
      ? captureText("Timed out after {seconds} seconds; the shortcut is unchanged. Choose Custom shortcut… to try again.")
      : text("Editing ended; the shortcut is unchanged."));
    // The history arriving from disk is not news: every row would be read out at once.
    const historyLoaded = Boolean(previous.recordingHistoryStatus) && !next.recordingHistoryStatus;
    const olds = new Map((previous.recordingResults ?? []).map(r => [r.id, r]));
    const results = sameLanguage && !historyLoaded ? next.recordingResults ?? [] : [];
    // Newest first, so a new failure precedes every known row; rows after one are older ones paged into view.
    const firstKnown = results.findIndex(r => olds.has(r.id));
    for (const [index, result] of results.entries()) {
      const old = olds.get(result.id);
      if (!old) { if (firstKnown === -1 || index < firstKnown) changes.unshift(say([result.reason, result.outcome])); }
      else if (old.outcome !== result.outcome) changes.unshift(say([result.reason, result.outcome]));
      else if (result.persistenceWarning && old.persistenceWarning !== result.persistenceWarning) changes.push(say([result.reason, result.persistenceWarning]));
    }
    // The status card is no live region (`#feedback` stays the one announcer), so a state it newly shows is read here:
    // a recording started from the shortcut, a save, a problem that appeared. Once per state, not every countdown
    // second, and not again when a diagnostic already says it; Ready, which the card does not show, says nothing.
    const status = next.status, was = previous.status;
    if (sameLanguage && status && status.tone !== "ready" && (status.tone !== was?.tone || (status.tone === "attention" && status.title !== was?.title))
      && !changes.some(change => change.includes(status.title))) changes.unshift(say([status.title, status.detail]));
    if (changes.length) announce(say(changes));
  }
}
/** Result actions run beside preference saves; only the same row refuses a duplicate. */
async function chooseResult(id: string, action: string, control: string): Promise<void> {
  const offered = view?.recordingResults?.find(r => r.id === id);
  if (!offered || resultIntents.has(id) || offered.saving) return;
  // Record the origin before anything can change focus.
  const intent = { action, control, moved: false };
  resultIntents.set(id, intent); resultErrors.delete(id);
  if (persistsHistory(action)) announce(text("Saving this change…"));
  draw();
  let applied = false;
  let offeredAfter = true;
  try {
    const result = await window.settings.choose(`recordingResult:${id}`, action);
    render(result.view); applied = result.applied;
    // A reveal whose file is gone changes the row instead: the button left with it, so there is nothing to retry.
    offeredAfter = Boolean(result.view.recordingResults?.find(r => r.id === id)?.actions.some(choice => choice.id === action));
  } catch { /* Keep the current projection; main owns the state. */ }
  resultIntents.delete(id);
  if (!applied && offeredAfter) { resultErrors.add(id); announce(text("Could not complete this action. Try again.")); }
  else if (announced() === text("Saving this change…")) announce("");
  draw();
  restoreResultFocus(id, intent);
}
/** Summary after acknowledgement, collapse or failure; the active tab after the last row. Never steals. */
function restoreResultFocus(id: string, intent: { action: string; control: string; moved: boolean }): void {
  if (intent.moved || !document.hasFocus()) return;
  const control = document.getElementById(intent.control);
  const active = document.activeElement;
  if (active && active !== document.body && active !== control) return;
  const area = document.getElementById(resultDomId(id)) as HTMLDetailsElement | null;
  if (control && area?.open && !persistsHistory(intent.action)) { control.focus({ preventScroll: true }); return; }
  const target = area?.querySelector<HTMLElement>(":scope > summary") ?? document.querySelector<HTMLElement>(".recording-result > summary")
    ?? document.getElementById(`tab-${selectedTab}`);
  target?.focus({ preventScroll: true });
}
async function choose(group: string, choice: string, control: string): Promise<void> {
  // The currently edited value can queue a newer intent; actions never duplicate.
  if (saving && (saving.group !== group || isRecoveryControl(control) || isCaptureControl(control))) return;
  const id = ++requestId;
  pending++; saving = { group, choice, control }; failure = undefined; announce(""); draw();
  let success = false;
  let returnCaptureFocus = false;
  try {
    const result = await window.settings.choose(group, choice);
    if (id !== requestId) return;
    returnCaptureFocus = isCaptureControl(control) && document.activeElement?.id === control && document.hasFocus();
    render(result.view); success = result.applied;
    if (!success) {
      failure = { group, choice, text: result.failure ?? result.view.failure, baseline: committed(result.view.groups.find(g => g.id === group)!),
        ...(result.refused ? { refused: true as const } : {}) };
      announce(failure.text);
    } else if (isCaptureControl(control) && !shortcutGroup()?.diagnostics?.length) announce(text("Shortcut saved"));
    // The status card's Use Primary display is the Screen row's recovery, offered where the problem is named.
    else if (control.endsWith("-recovery") || (control === "status-action" && choice === "primary")) announce(text("Switched to Primary display"));
  } catch {
    if (id === requestId && view) {
      failure = { group, choice, text: view.failure, baseline: committed(view.groups.find(g => g.id === group)!) }; announce(failure.text);
      if (isCaptureControl(control)) void capture(false);
    }
  } finally {
    pending--; if (!pending) saving = undefined;
    // Only move focus if the user's focus is still on the disappearing field.
    const restore = document.activeElement?.id === control && document.hasFocus();
    // A retry that succeeded is hidden, and an action main stops offering is removed
    // (the shortcut card's retry); if focus already fell to the page, it goes back to the group.
    const vanished = (): boolean => { const el = document.getElementById(control); return !el || Boolean(el.closest("[hidden]")); };
    const lost = (!document.activeElement || document.activeElement === document.body)
      && (isRecoveryControl(control) || vanished());
    draw();
    if (lost && document.hasFocus()) {
      const again = document.getElementById(control);
      // The status card hides once its fix worked and has no group row to stand for it: the tab keeps the place,
      // so the next Tab does not start over and the next Escape does not close the window.
      (again && !again.closest("[hidden]") ? again : groupControl(group, choice) ?? document.getElementById(`tab-${selectedTab}`))
        ?.focus({ preventScroll: true });
    }
    if ((restore || returnCaptureFocus) && document.hasFocus() && isCaptureControl(control) && !shortcutGroup()?.capturing)
      document.getElementById("setting-hotkey")?.focus({ preventScroll: true });
  }
}
// Keep DOM focus for keyboard/assistive navigation; pointer interaction only
// suppresses its visual ring, including Chromium's sticky native select ring.
document.addEventListener("pointerdown", event => {
  document.documentElement.dataset.input = "pointer";
  for (const intent of resultIntents.values()) if (!document.getElementById(intent.control)?.contains(event.target as Node)) intent.moved = true;
}, true);
document.addEventListener("focusin", event => {
  for (const intent of resultIntents.values()) if (event.target !== document.getElementById(intent.control)) intent.moved = true;
});
document.addEventListener("keydown", event => {
  if (["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
    document.documentElement.dataset.input = "keyboard";
}, true);
form.addEventListener("submit", event => event.preventDefault());
for (const id of ["status-action", "status-secondary"]) document.getElementById(id)?.addEventListener("click", event => {
  const el = event.currentTarget as HTMLButtonElement;
  if (!inactive(el) && el.dataset.action) void choose("status", el.dataset.action, el.id);
});
/**
 * Escapes this soon after one closed the player, or after a video's fullscreen ended, belong to that press, so
 * pressing again and again closes one thing at a time; when that last happened.
 */
const ESCAPE_SETTLE_MS = 1000;
let escapeClosed = -Infinity;
// A video plays full screen in a window of its own (video-fullscreen.ts). Should the page's own fullscreen start
// anyway, it is handed over at once, so RecordStuff's window never grows to the screen (2026-10-05).
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) return;
  void document.exitFullscreen().catch(() => {});
  void playFullScreen();
});
document.addEventListener("keydown", event => {
  // A held Escape repeats, and quick presses follow one that closed something: none of them closes the next thing,
  // so pressing again and again after a fullscreen no longer closed the player and then the window (2026-10-04).
  if (event.key === "Escape" && (event.repeat || performance.now() - escapeClosed < ESCAPE_SETTLE_MS)) { event.preventDefault(); return; }
  // The player is a modal dialog: Escape closes it, not the window.
  if (event.key === "Escape" && player?.open) return;
  if (event.key === "Escape" && (shortcutGroup()?.capturing || arming)) { event.preventDefault(); void capture(false, true); return; }
  // An open explanation closes first; the next Escape closes the window.
  if (event.key === "Escape" && hideInfo()) { event.preventDefault(); return; }
  if (event.key === "Escape" || isCloseChord(event, platform())) window.close();
});
// An inactive window shows no focus ring (plan 047), even where Chromium keeps :focus-visible.
window.addEventListener("focus", () => { delete document.documentElement.dataset.window; });
// A shown explanation follows its button through scrolling, as keyboard focus scrolls it into view, and resizing.
document.addEventListener("scroll", placeInfo, true);
window.addEventListener("resize", placeInfo);
window.addEventListener("blur", () => {
  document.documentElement.dataset.window = "inactive";
  hideInfo();
  for (const intent of resultIntents.values()) intent.moved = true;
  if (shortcutGroup()?.capturing || arming) void capture(false);
});
window.settings.onChanged(render);
// Hidden (⌘H): the player stops, and a full screen ending around then does not start it again (review 2026-10-05).
window.settings.onHidden?.(() => {
  hideCount++;
  player?.querySelector("video")?.pause();
});
void window.settings.read().then(render).catch(() => {
  // A push that already drew the panel answers what the read could not.
  if (view) return;
  startupFailed = true;
  // No view ever drew, so the page still carries the HTML's `lang`; the message is in the requested language.
  document.documentElement.lang = documentLanguage(startupLanguage);
  feedback.classList.remove("visually-hidden");
  announce(translate("This window could not load. Close it and open RecordStuff again.", startupLanguage));
  reportReady();
});
