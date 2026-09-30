/** Main owns committed preferences, diagnostics and authorized choice ids. */
import { SETTINGS_SHORTCUT_RESERVED, describeAccelerator, isSettingsShortcut, validateAccelerator } from "../shared/hotkey";
import { isCloseChord, shortcutCandidate, shortcutModifiers } from "./shortcut-capture";
import { isLanguage, sentences, translate, type Language, type PlainMessageKey } from "../shared/i18n";
import { REVIEWED_FAILURES_KEPT, persistsHistory } from "../shared/recording-result";
import type { RecordingResultView, SettingsBridge, SettingsGroup, SettingsTab, SettingsView } from "../shared/settings-panel";

declare global { interface Window { settings: SettingsBridge } }
const form = document.querySelector<HTMLFormElement>("#settings")!;
const heading = document.querySelector<HTMLHeadingElement>("#title")!;
const hint = document.querySelector<HTMLParagraphElement>("#hint")!;
const feedback = document.querySelector<HTMLParagraphElement>("#feedback")!;
const startupLanguage = ((v: string | null) => isLanguage(v) ? v : undefined)(new URLSearchParams(location.search).get("lang"));
/** The BCP 47 tag assistive technology reads the page's text with. */
const documentLanguage = (language: Language | undefined): string => language === "zh-TW" ? "zh-Hant" : "en";
let view: SettingsView | undefined;
let selectedTab: SettingsTab = "recording";
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
/** The first read failed and its error is shown in `#feedback`, made visible. */
let startupFailed = false;
/** `editor`: the shortcut editor refused the key just pressed; the error belongs to that editor and closes with it. */
let failure: { group: string; choice?: string; text: string; baseline?: string; refused?: true; editor?: true } | undefined;
const text = (key: PlainMessageKey): string => translate(key, view?.language);
const controlId = (group: SettingsGroup): string => `setting-${group.id}`;
/** The shortcut editor's own buttons: their outcome returns focus to the shortcut select. */
const isCaptureControl = (control: string): boolean => control === "shortcut-capture" || control === "shortcut-confirm";
/** A group's retry or recovery button; it hides once it worked, so focus falls back to the group. */
const isRecoveryControl = (control: string): boolean => /-(retry|recovery)$/.test(control);
const shortcutGroup = (): SettingsGroup | undefined => view?.groups.find(g => g.kind === "shortcut");
/** Main's platform; before the first view (a failed read) the page must still close. */
const platform = (): string => shortcutGroup()?.platform ?? (navigator.platform.startsWith("Mac") ? "darwin" : navigator.platform);
function setText(element: Element, value: string): void { if (element.textContent !== value) element.textContent = value; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", value = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; el.textContent = value; return el;
}
/** Marks a repeated announcement; screen readers do not speak a trailing no-break space. */
const REPEAT_MARK = "\u00A0";
/** The message `#feedback` announces, without the repeat mark. */
const announced = (): string => (feedback.textContent ?? "").replace(/\u00A0$/, "");
/**
 * A live region speaks only when its text changes, so the same message again (a retry that
 * failed again, a second refused key) toggles the repeat mark to be heard again.
 */
function announce(value: string): void {
  const current = feedback.textContent ?? "";
  if (value && announced() === value) feedback.textContent = current === value ? `${value}${REPEAT_MARK}` : value;
  else setText(feedback, value);
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
  el.setAttribute("aria-disabled", String(unavailable || busy));
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
  previewParts = accelerator.split("+").filter(Boolean).map(part => describeAccelerator(part, platform));
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
      block.append(node("strong", "diagnostic-heading", `⚠ ${item.heading}`), node("p", "", item.reason), node("p", "guidance", item.guidance));
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
  for (const group of groups) {
    const container = document.getElementById(`${controlId(group)}-row`)!;
    const label = container.querySelector<HTMLElement>(".group-label")!;
    setText(label, group.label);
    label.hidden = !group.label;
    const note = container.querySelector<HTMLElement>(".note")!;
    setText(note, group.note ?? ""); note.hidden = !group.note;
    for (const el of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input")) {
      setDisabled(el, !group.enabled, Boolean(saving && saving.group !== group.id));
      if (el instanceof HTMLSelectElement) {
        // Reconcile menu options locally: a new custom key or display must not
        // recreate the panel, its neighbouring controls, or their focus.
        const choices = [...group.choices, ...(group.kind === "shortcut" ? [{ id: "custom", label: text("Custom shortcut…"), enabled: true, checked: false }] : [])];
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
        el.disabled ||= !group.choices.find(c => c.id === (el.checked ? "off" : "on"))?.enabled;
      } else {
        const choice = group.choices.find(c => c.id === el.value)!;
        el.checked = choice.checked; el.disabled ||= !choice.enabled;
        setText(el.nextElementSibling!, choice.label);
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
        el.setAttribute("aria-label", choice.label); el.title = choice.label;
      } else setText(el, choice.label);
      setActionDisabled(el, !group.enabled || !choice.enabled, Boolean(saving) || choice.busy === true);
    }
    container.setAttribute("aria-busy", String(saving?.group === group.id));
    const applying = container.querySelector<HTMLElement>(".applying")!;
    setText(applying, saving?.group === group.id && !actions.some(choice => choice.id === saving?.choice) ? text("Applying…") : "");
    updateDiagnostic(container, group);
    if (group.kind === "shortcut") {
      const edit = container.querySelector<HTMLSelectElement>("#setting-hotkey")!;
      const customOption = edit.querySelector<HTMLOptionElement>('option[value="custom"]')!;
      setText(customOption, text("Custom shortcut…"));
      customOption.disabled = Boolean(saving) || arming || Boolean(group.capturing);
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
      setText(container.querySelector(".capture-help")!, text("Press a combination, then Confirm; Esc cancels"));
      const confirm = container.querySelector<HTMLButtonElement>("#shortcut-confirm")!;
      setText(confirm, text("Confirm"));
      confirm.disabled = !group.enabled || !candidateToConfirm;
      confirm.setAttribute("aria-disabled", String(Boolean(saving) || confirm.disabled));
      confirm.tabIndex = candidateToConfirm ? 0 : -1;
      const cancel = container.querySelector<HTMLButtonElement>("#shortcut-cancel")!;
      setText(cancel, text("Cancel")); cancel.disabled = Boolean(saving); cancel.tabIndex = 0;
      if (wasFocused && area.hidden && document.hasFocus()) edit.focus({ preventScroll: true });
    }
    // Only what is shown: a hidden region still lends its text, stale failure copy included, to a description.
    // Status changes use the single announcer below, not duplicate live regions.
    const description = [`${controlId(group)}-note`, `${controlId(group)}-diagnostics`]
      .filter(id => document.getElementById(id)?.hidden === false).join(" ");
    for (const el of container.querySelectorAll<HTMLElement>("select, input, button[data-action], #shortcut-capture")) {
      if (description) el.setAttribute("aria-describedby", description); else el.removeAttribute("aria-describedby");
    }
  }
}
function actionButton(group: SettingsGroup, choice: SettingsGroup["choices"][number]): HTMLButtonElement {
  const id = `${controlId(group)}-${choice.id}`;
  const el = button(id, () => { if (!inactive(el)) void choose(group.id, choice.id, id); });
  el.dataset.action = choice.id;
  if (group.id === "about") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    if (choice.id === "website") {
      svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.6");
      path.setAttribute("d", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z");
    } else {
      svg.setAttribute("fill", "currentColor");
      path.setAttribute("d", "M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.54v-2.07c-3.1.67-3.76-1.31-3.76-1.31-.51-1.28-1.24-1.62-1.24-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.14 1.71 1.14 1 .1.74 1.89 3.26 1.2.1-.73.4-1.23.71-1.51-2.48-.28-5.08-1.24-5.08-5.52 0-1.22.44-2.22 1.14-3-.11-.28-.5-1.41.11-2.94 0 0 .93-.3 3.05 1.14a10.6 10.6 0 0 1 5.55 0c2.12-1.44 3.05-1.14 3.05-1.14.61 1.53.22 2.66.11 2.94.71.78 1.14 1.78 1.14 3 0 4.29-2.61 5.23-5.1 5.51.4.35.75 1.02.75 2.06v3.05c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z");
    }
    svg.append(path); el.append(svg);
  }
  return el;
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
  line.append(label, controls); container.append(line);
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
      item.append(input, node("span")); segments.append(item);
    }
    controls.append(segments);
  } else {
    const select = node("select"); select.id = id;
    for (const choice of group.choices) { const option = node("option"); option.value = choice.id; select.append(option); }
    if (group.kind === "shortcut") {
      const custom = node("option"); custom.value = "custom"; select.append(custom);
    }
    select.addEventListener("change", () => {
      if (group.kind === "shortcut" && select.value === "custom") {
        select.value = committed(shortcutGroup()!);
        void capture(true);
      } else void choose(group.id, select.value, id);
    }); controls.append(select);
  }
  if (group.kind === "shortcut") {
    const area = node("div", "capture-area");
    const field = button("shortcut-capture", () => {});
    field.addEventListener("keydown", event => {
      if (!shortcutGroup()?.capturing) return;
      if (isCloseChord(event, platform())) return; // Not a candidate: the document handler closes.
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
      const candidate = shortcutCandidate(event, group.platform);
      // Releasing or pressing a modifier must not erase a complete preview.
      if (candidate === undefined && candidateToConfirm) return;
      candidateToConfirm = undefined;
      setPreview(candidate ?? shortcutModifiers(event, group.platform).join("+"), group.platform ?? "darwin");
      if (candidate === undefined) { draw(); return; }
      const result = validateAccelerator(candidate);
      // The Settings shortcut is refused here like the other reserved combinations, so the editor stays open; main refuses it too.
      const error = result.error ?? (isSettingsShortcut(result.accelerator, group.platform ?? "darwin") ? SETTINGS_SHORTCUT_RESERVED : undefined);
      if (error) {
        // A key the editor cannot use has no name to show (only the internal "Unsupported"): keep the held modifiers.
        setPreview(shortcutModifiers(event, group.platform).join("+"), group.platform ?? "darwin");
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
        setPreview(shortcutModifiers(event, group.platform).join("+"), group.platform ?? "darwin"); draw();
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
    area.append(field, confirm, button("shortcut-cancel", () => void capture(false, true)), node("p", "capture-help")); container.append(area);
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
        if (loaded) document.getElementById(`recording-result-${encodeURIComponent(loaded.id)}-summary`)?.focus({ preventScroll: true });
      })
        .catch(() => announce(text("Could not complete this action. Please try again.")))
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
  empty.hidden = Boolean(results.length || status); setText(empty, text("No recording failures."));
  const note = list.querySelector<HTMLElement>(".result-history-note")!;
  note.hidden = !results.length;
  setText(note, translate("Keeps all unreviewed failures and the {count} most recently reviewed failures. Removing a record does not delete the recording file.",
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
  // One group per consecutive day heading; groups are kept by heading so rows move only when their day changes.
  const groups: Array<{ day: string; rows: typeof results }> = [];
  for (const result of results) {
    if (groups.at(-1)?.day !== result.day) groups.push({ day: result.day, rows: [] });
    groups.at(-1)!.rows.push(result);
  }
  const sections = new Map([...days.querySelectorAll<HTMLElement>(".result-day")].map(section => [section.dataset.day!, section]));
  /** Rows whose action had focus before this update; a button replaced or a collapse returns it to the header. */
  const actionFocus = new Set<HTMLDetailsElement>();
  for (const [groupIndex, group] of groups.entries()) {
    let section = sections.get(group.day);
    sections.delete(group.day);
    if (!section) {
      section = node("section", "result-day"); section.dataset.day = group.day;
      const heading = node("h2", "result-day-heading", group.day);
      section.append(heading, node("div", "result-rows"));
    }
    place(days, section, groupIndex);
    const rows = section.querySelector<HTMLElement>(".result-rows")!;
    for (const [index, result] of group.rows.entries()) {
      const domId = `recording-result-${encodeURIComponent(result.id)}`;
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
  }
  // A group whose rows all moved elsewhere or were removed.
  for (const section of sections.values()) section.remove();
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
    const target = document.getElementById(`recording-result-${encodeURIComponent(focusId)}`);
    target?.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }
  if (focusAfterRemoval !== undefined) {
    // The row that took the removed one's place, or the new last row; brought into view.
    const next = (focusAfterRemoval === null ? undefined
      : document.getElementById(`recording-result-${encodeURIComponent(focusAfterRemoval)}`)?.querySelector<HTMLElement>(":scope > summary"))
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
  area.setAttribute("aria-busy", String(busy));
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
  setText(error, error.hidden ? "" : text("Could not complete this action. Please try again."));
  const technical = area.querySelector<HTMLDetailsElement>(".result-technical")!;
  // The full path moved here from the row (plan 047); the file name stays above.
  const technicalText = [result.file, result.detail].filter(Boolean).join("\n");
  technical.hidden = !technicalText;
  setText(technical.querySelector("summary")!, text("Technical details"));
  setText(technical.querySelector("pre")!, technicalText);
}

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
  if (focusRequested) {
    // Like a tab click: the editor leaves with its tab, and main must not keep both shortcuts suspended.
    if (selectedTab !== entryTab && (shortcutGroup()?.capturing || arming)) void capture(false);
    selectedTab = entryTab;
  }
  document.documentElement.lang = documentLanguage(current.language);
  document.title = current.title; setText(heading, current.title); setText(hint, current.hint); hint.hidden = !current.hint;
  const groups = current.groups.filter(g => g.tab === selectedTab);
  /** Set when the panel was rebuilt: the offset it gets once everything above its content has settled. */
  let restoreScroll: number | undefined;
  const structure = JSON.stringify([selectedTab, current.tabs.map(t => t.id), groups.map(g => [g.id, g.kind, g.control, g.section, g.control === "segmented" ? g.choices.map(c => c.id) : null])]);
  if (structure !== renderedStructure) {
    renderedStructure = structure;
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
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = current.tabs.findIndex(t => t.id === selectedTab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? current.tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + current.tabs.length) % current.tabs.length;
        document.getElementById(`tab-${current.tabs[next]!.id}`)?.click();
      }); tabs.append(el);
    }
    const panel = node("div"); panel.id = "settings-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `tab-${selectedTab}`);
    let section: HTMLElement | undefined; let previous: string | undefined;
    for (const group of groups) {
      const sectionId = group.section ?? group.id;
      if (!section || sectionId !== previous) {
        section = node("section", group.id === "about" ? "section about" : "section");
        const title = node("h2", "section-heading"); title.id = `${controlId(group)}-section-heading`;
        section.append(title, node("div", "inset-list")); panel.append(section); previous = sectionId;
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
    form.replaceChildren(tabs, viewport);
    updateRows(groups);
    if (restore && document.hasFocus()) {
      const destination = isCaptureControl(restore) && !shortcutGroup()?.capturing ? "setting-hotkey" : restore;
      const focusTarget = document.getElementById(destination);
      if (focusTarget && !focusTarget.closest("[hidden]")) focusTarget.focus({ preventScroll: true });
      else if (isRecoveryControl(restore)) groupControl(restore.replace(/^setting-|-(recovery|retry)$/g, ""))?.focus({ preventScroll: true });
    }
    // Rows first; the offset is applied below, once the panel, failure rows included, is complete.
    updateRecordingResult(false);
    restoreScroll = target;
  } else updateRows(groups);
  form.querySelector('[role="tablist"]')!.setAttribute("aria-label", current.title);
  for (const tab of current.tabs) {
    const el = document.getElementById(`tab-${tab.id}`)!;
    setText(el, tab.label);
    if (tab.accessibleLabel) el.setAttribute("aria-label", tab.accessibleLabel); else el.removeAttribute("aria-label");
  }
  for (const group of groups) {
    const title = document.getElementById(`${controlId(group)}-section-heading`);
    if (title) { setText(title, group.sectionHeading ?? ""); title.hidden = !group.sectionHeading; }
  }
  // After the headings above settle, so scroll anchoring cannot shift the restored offset; an entry's own scroll wins.
  if (restoreScroll !== undefined) document.getElementById("settings-panel")!.scrollTop = restoreScroll;
  updateRecordingResult(focusRequested);
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
  draw();
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
    if (endedByMain && document.hasFocus()) changes.unshift(text("Shortcut editing ended; the shortcut was not changed."));
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
  if (!applied && offeredAfter) { resultErrors.add(id); announce(text("Could not complete this action. Please try again.")); }
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
  const area = document.getElementById(`recording-result-${encodeURIComponent(id)}`) as HTMLDetailsElement | null;
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
    else if (control.endsWith("-recovery")) announce(text("Switched to Primary display"));
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
      (again && !again.closest("[hidden]") ? again : groupControl(group, choice))?.focus({ preventScroll: true });
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
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && (shortcutGroup()?.capturing || arming)) { event.preventDefault(); void capture(false, true); return; }
  if (event.key === "Escape" || isCloseChord(event, platform())) window.close();
});
// An inactive window shows no focus ring (plan 047), even where Chromium keeps :focus-visible.
window.addEventListener("focus", () => { delete document.documentElement.dataset.window; });
window.addEventListener("blur", () => {
  document.documentElement.dataset.window = "inactive";
  for (const intent of resultIntents.values()) intent.moved = true;
  if (shortcutGroup()?.capturing || arming) void capture(false);
});
window.settings.onChanged(render);
void window.settings.read().then(render).catch(() => {
  // A push that already drew the panel answers what the read could not.
  if (view) return;
  startupFailed = true;
  // No view ever drew, so the page still carries the HTML's `lang`; the message is in the requested language.
  document.documentElement.lang = documentLanguage(startupLanguage);
  feedback.classList.remove("visually-hidden");
  announce(translate("Could not open settings. Close this window and open it again.", startupLanguage));
});
