/** Main owns committed preferences, diagnostics and authorized choice ids. */
import { describeAccelerator, validateAccelerator } from "../shared/hotkey";
import { isCloseChord, shortcutCandidate, shortcutModifiers } from "./shortcut-capture";
import { isLanguage, translate, type PlainMessageKey } from "../shared/i18n";
import type { SettingsBridge, SettingsGroup, SettingsView } from "../shared/settings-panel";

declare global { interface Window { settings: SettingsBridge } }
const form = document.querySelector<HTMLFormElement>("#settings")!;
const heading = document.querySelector<HTMLHeadingElement>("#title")!;
const hint = document.querySelector<HTMLParagraphElement>("#hint")!;
const feedback = document.querySelector<HTMLParagraphElement>("#feedback")!;
const startupLanguage = ((v: string | null) => isLanguage(v) ? v : undefined)(new URLSearchParams(location.search).get("lang"));
let view: SettingsView | undefined;
let selectedTab: "recording" | "general" = "recording";
let renderedStructure = "";
const resultStates = new Map<string, { open: boolean; acknowledged: boolean }>();
/**
 * Where each pending result action started. Focus returns from this intent,
 * not from `document.activeElement` surviving the wait; `moved` records that
 * the user went elsewhere or the window lost focus meanwhile.
 */
const resultIntents = new Map<string, { action: string; control: string; moved: boolean }>();
const resultErrors = new Set<string>();
const PERSISTING_ACTIONS = ["acknowledge", "remove", "retry"];
let resultFocus = 0;
let requestId = 0;
let pending = 0;
let saving: { group: string; choice: string; control: string } | undefined;
let arming = false;
let captureGeneration = 0;
let preview = "";
let candidateToConfirm: string | undefined;
let failure: { group: string; choice?: string; text: string; baseline?: string } | undefined;
const text = (key: PlainMessageKey): string => translate(key, view?.language);
const controlId = (group: SettingsGroup): string => `setting-${group.id}`;
const shortcutGroup = (): SettingsGroup | undefined => view?.groups.find(g => g.kind === "shortcut");
/** Main's platform; before the first view (a failed read) the page must still close. */
const platform = (): string => shortcutGroup()?.platform ?? (navigator.platform.startsWith("Mac") ? "darwin" : navigator.platform);
function setText(element: Element, value: string): void { if (element.textContent !== value) element.textContent = value; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", value = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; el.textContent = value; return el;
}
function announce(value: string): void { setText(feedback, value); }
function committed(group: SettingsGroup | undefined): string { return group?.choices.find(c => c.checked)?.id ?? ""; }
function setDisabled(el: HTMLButtonElement | HTMLSelectElement | HTMLInputElement, unavailable: boolean, busy: boolean): void {
  if (el.disabled !== (unavailable || busy)) el.disabled = unavailable || busy;
  el.classList.toggle("saving-disabled", !unavailable && busy);
}
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
  preview = "";
  candidateToConfirm = undefined;
  if (armed) { failure = undefined; announce(""); }
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
  }
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
  const actionFailure = activeFailure && (group.kind === "actions" ? group.choices : group.actions ?? []).some(choice => choice.id === activeFailure.choice);
  setText(error.querySelector("strong")!, text(actionFailure ? "Action failed" : "Change was not saved"));
  setText(error.querySelector("p")!, activeFailure?.text ?? "");
  const recovery = area.querySelector<HTMLButtonElement>(".recovery")!;
  const canRecover = group.recovery && group.choices.some(c => c.id === group.recovery?.choice && c.enabled);
  const hadRecoveryFocus = document.activeElement === recovery;
  recovery.hidden = !canRecover;
  setText(recovery, group.recovery?.label ?? "");
  setDisabled(recovery, !group.enabled, Boolean(saving));
  const retry = area.querySelector<HTMLButtonElement>(".retry")!;
  const hadRetryFocus = document.activeElement === retry;
  retry.hidden = !retryAllowed(group);
  setText(retry, text("Retry save"));
  setDisabled(retry, !group.enabled, Boolean(saving));
  const guidance = area.querySelector<HTMLElement>(".reselect")!;
  guidance.hidden = !activeFailure || retryAllowed(group);
  setText(guidance, text("Choose the setting again to retry."));
  area.hidden = !items.length && !activeFailure;
  if (((hadRecoveryFocus && recovery.hidden) || (hadRetryFocus && retry.hidden)) && document.hasFocus())
    document.getElementById(controlId(group))?.focus({ preventScroll: true });
}
function updateRows(groups: SettingsGroup[]): void {
  for (const group of groups) {
    const container = document.getElementById(`${controlId(group)}-row`)!;
    const label = container.querySelector<HTMLElement>(".group-label")!;
    setText(label, group.label);
    label.hidden = !group.label;
    container.classList.toggle("locked", !group.enabled);
    const note = container.querySelector<HTMLElement>(".note")!;
    setText(note, group.note ?? ""); note.hidden = !group.note;
    // Status changes use the single announcer below, not duplicate live regions.
    const description = `${controlId(group)}-note ${controlId(group)}-diagnostics`;
    for (const el of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input")) {
      el.setAttribute("aria-describedby", description);
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
      setDisabled(el, !group.enabled || !choice.enabled, Boolean(saving));
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
      field.setAttribute("aria-describedby", description);
      const display = preview || text("Press a combination");
      if (field.dataset.preview !== display) {
        field.dataset.preview = display;
        const indicator = node("span", "listening-indicator"); indicator.setAttribute("aria-hidden", "true");
        for (let index = 0; index < 3; index++) indicator.append(node("span"));
        field.replaceChildren(indicator, ...(preview ? Array.from(preview).map(key => node("kbd", "", key)) : [document.createTextNode(display)]));
        field.setAttribute("aria-label", `${display}. ${text("Escape to cancel")}`);
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
    const footnote = document.getElementById(`${controlId(group)}-footnote`)!;
    setText(footnote, group.sectionFootnote ?? ""); footnote.hidden = !group.sectionFootnote;
  }
}
function actionButton(group: SettingsGroup, choice: SettingsGroup["choices"][number]): HTMLButtonElement {
  const id = `${controlId(group)}-${choice.id}`;
  const el = button(id, () => void choose(group.id, choice.id, id));
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
  const label = group.id === "about" ? node("span", "group-label") : node("label", "group-label");
  if (label instanceof HTMLLabelElement) label.htmlFor = id;
  label.id = `${id}-label`;
  const controls = node("div", "controls");
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
      preview = describeAccelerator(candidate ?? shortcutModifiers(event, group.platform).join("+"), group.platform ?? "darwin");
      if (candidate === undefined) { draw(); return; }
      const result = validateAccelerator(candidate);
      if (result.error) { localFailure(group.id, translate(result.error, view?.language)); return; }
      candidateToConfirm = result.accelerator;
      failure = undefined;
      announce(`${preview}. ${text("Confirm to save")}`);
      draw();
    });
    field.addEventListener("keyup", event => {
      if (!shortcutGroup()?.capturing || saving || candidateToConfirm) return;
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
        preview = describeAccelerator(shortcutModifiers(event, group.platform).join("+"), group.platform ?? "darwin"); draw();
      }
    });
    area.addEventListener("focusout", () => queueMicrotask(() => {
      if (shortcutGroup()?.capturing && !saving && !area.contains(document.activeElement)) void capture(false);
    }));
    const confirm = button("shortcut-confirm", () => {
      if (candidateToConfirm && shortcutGroup()?.capturing && !saving)
        void choose(group.id, candidateToConfirm, "shortcut-confirm");
    });
    // macOS can move focus out of the capture area on mouse-down before the
    // button's click fires. Keep its current focus so blur cancellation cannot
    // discard the candidate before this explicit confirmation is delivered.
    confirm.addEventListener("mousedown", event => { if (event.button === 0) event.preventDefault(); });
    area.append(field, confirm, button("shortcut-cancel", () => void capture(false, true)), node("p", "capture-help")); container.append(area);
  }
  const diagnostics = node("div", "diagnostics"); diagnostics.id = `${id}-diagnostics`;
  const error = node("div", "save-error diagnostic"); error.append(node("strong"), node("p"));
  const recovery = button(`${id}-recovery`, () => {
    const current = view?.groups.find(g => g.id === group.id);
    if (current?.recovery && !saving) void choose(group.id, current.recovery.choice, recovery.id);
  }); recovery.className = "recovery";
  const retry = button(`${id}-retry`, () => {
    const current = view?.groups.find(g => g.id === group.id);
    if (current && retryAllowed(current) && failure?.choice && !saving) void choose(group.id, failure.choice, retry.id);
  }); retry.className = "retry";
  diagnostics.append(node("div", "diagnostic-content"), error, recovery, retry, node("p", "reselect"));
  const note = node("p", "note"); note.id = `${id}-note`;
  container.append(diagnostics, note);
  for (const choice of group.actions ?? []) container.append(actionButton(group, choice));
  container.append(node("span", "applying visually-hidden"));
  return container;
}
function updateRecordingResult(): void {
  const results = view?.recordingResults ?? [];
  let list = document.getElementById("recording-results");
  const panel = document.getElementById("settings-panel")!;
  const focusRequested = (view?.resultFocus ?? 0) > resultFocus;
  resultFocus = view?.resultFocus ?? 0;
  const status = view?.recordingHistoryStatus ?? "";
  if (!results.length && !status) {
    const hadFocus = list?.contains(document.activeElement);
    list?.remove(); resultStates.clear();
    if (hadFocus || focusRequested) document.getElementById(`tab-${selectedTab}`)?.focus({ preventScroll: true });
    return;
  }
  const focusId = (results.find(r => !r.acknowledged) ?? results[0])?.id;
  if (!list) {
    list = node("section"); list.id = "recording-results";
    list.append(node("h2"), node("p", "result-history-note"), node("p", "result-history-status"));
    panel.prepend(list);
  }
  setText(list.querySelector("h2")!, text("Recording failures"));
  setText(list.querySelector(".result-history-note")!, text("Keeps all unreviewed failures and the 20 most recently reviewed failures. Removing a record does not delete the recording file."));
  const statusLine = list.querySelector<HTMLElement>(".result-history-status")!;
  statusLine.hidden = !status; setText(statusLine, status);
  let removedFocus = false;
  for (const area of list.querySelectorAll<HTMLDetailsElement>(".recording-result")) {
    if (!results.some(r => r.id === area.dataset.resultId)) {
      removedFocus ||= area.contains(document.activeElement);
      area.remove(); resultStates.delete(area.dataset.resultId!); resultErrors.delete(area.dataset.resultId!);
    }
  }
  for (const [index, result] of results.entries()) {
    const domId = `recording-result-${encodeURIComponent(result.id)}`;
    let area = document.getElementById(domId) as HTMLDetailsElement | null;
    let state = resultStates.get(result.id);
    if (!state) { state = { open: !result.acknowledged, acknowledged: result.acknowledged }; resultStates.set(result.id, state); }
    if (!state.acknowledged && result.acknowledged) state.open = false;
    state.acknowledged = result.acknowledged;
    if (focusRequested && result.id === focusId) state.open = true;
    if (!area) {
      area = node("details", "recording-result"); area.id = domId; area.dataset.resultId = result.id;
      const summary = node("summary"); summary.id = `${domId}-summary`;
      summary.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); area!.open = !area!.open; state!.open = area!.open;
        }
      });
      const persistence = node("p", "result-persistence"); persistence.setAttribute("role", "alert");
      const error = node("p", "result-error"); error.setAttribute("role", "alert");
      const technical = node("details", "result-technical"); technical.append(node("summary"), node("pre"));
      area.append(summary, node("p", "result-reason"), node("p", "result-time"), node("p", "result-outcome"),
        node("p", "result-file"), node("p", "result-guidance"), persistence, node("div", "result-actions"), node("p", "result-saving"), error, technical);
      area.addEventListener("toggle", () => { if (area!.isConnected) state!.open = area!.open; updateScrollHint(); });
      list.insertBefore(area, list.children[index + 3] ?? null);
    }
    const hadActionFocus = area.querySelector(".result-actions")!.contains(document.activeElement);
    area.open = state.open;
    setText(area.querySelector("summary")!, `${result.acknowledged ? "" : "⚠ "}${result.time} — ${result.reason}`);
    setText(area.querySelector(".result-reason")!, result.heading);
    setText(area.querySelector(".result-time")!, result.time);
    setText(area.querySelector(".result-outcome")!, result.outcome);
    const persistence = area.querySelector<HTMLElement>(".result-persistence")!;
    persistence.hidden = !result.persistenceWarning; setText(persistence, result.persistenceWarning ?? "");
    const file = area.querySelector<HTMLElement>(".result-file")!;
    file.hidden = !result.file; setText(file, result.file ?? "");
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
        actions.insertBefore(el, actions.children[position] ?? null);
      }
      setText(el, action.label);
      // Busy stays focusable and ignores activation; native disabled would drop focus to body.
      setDisabled(el, !action.enabled, false);
      el.setAttribute("aria-disabled", String(busy || !action.enabled));
      el.classList.toggle("saving-disabled", busy && action.enabled);
    }
    const savingLine = area.querySelector<HTMLElement>(".result-saving")!;
    const savingText = result.saving || (intent && PERSISTING_ACTIONS.includes(intent.action) ? text("Saving this change…") : "");
    savingLine.hidden = !savingText; setText(savingLine, savingText);
    const error = area.querySelector<HTMLElement>(".result-error")!;
    error.hidden = !resultErrors.has(result.id);
    setText(error, error.hidden ? "" : text("Could not complete this action. Please try again."));
    const technical = area.querySelector<HTMLDetailsElement>(".result-technical")!;
    technical.hidden = !result.detail;
    setText(technical.querySelector("summary")!, text("Technical details"));
    setText(technical.querySelector("pre")!, result.detail);
    if ((focusRequested && result.id === focusId) || (hadActionFocus && (!area.open || !area.contains(document.activeElement)))) {
      area.querySelector<HTMLElement>("summary")!.focus({ preventScroll: true });
    }
  }
  if (focusRequested && focusId) document.getElementById(`recording-result-${encodeURIComponent(focusId)}`)?.scrollIntoView({ block: "nearest" });
  if (removedFocus) list.querySelector<HTMLElement>(".recording-result > summary")?.focus({ preventScroll: true });
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
  document.documentElement.lang = current.language === "zh-TW" ? "zh-Hant" : "en";
  document.title = current.title; setText(heading, current.title); setText(hint, current.hint); hint.hidden = !current.hint;
  const groups = current.groups.filter(g => g.tab === selectedTab);
  const structure = JSON.stringify([selectedTab, current.tabs.map(t => t.id), groups.map(g => [g.id, g.kind, g.control, g.section, g.control === "segmented" ? g.choices.map(c => c.id) : null])]);
  if (structure !== renderedStructure) {
    renderedStructure = structure;
    const active = document.activeElement;
    const restore = active instanceof HTMLElement && form.contains(active) ? active.id : "";
    const scroll = document.getElementById("settings-panel")?.scrollTop ?? 0;
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
      const foot = node("p", "section-footnote"); foot.id = `${controlId(group)}-footnote`; section.append(foot);
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
      const destination = (restore === "shortcut-capture" || restore === "shortcut-confirm") && !shortcutGroup()?.capturing ? "setting-hotkey" : restore;
      const target = document.getElementById(destination);
      if (target && !target.closest("[hidden]")) target.focus({ preventScroll: true });
      else if (restore.endsWith("-recovery") || restore.endsWith("-retry")) document.getElementById(restore.replace(/-(recovery|retry)$/, ""))?.focus({ preventScroll: true });
    }
    panel.scrollTop = scroll;
  } else updateRows(groups);
  form.querySelector('[role="tablist"]')!.setAttribute("aria-label", current.title);
  for (const tab of current.tabs) setText(document.getElementById(`tab-${tab.id}`)!, tab.label);
  for (const group of groups) {
    const title = document.getElementById(`${controlId(group)}-section-heading`);
    if (title) { setText(title, group.sectionHeading ?? ""); title.hidden = !group.sectionHeading; }
  }
  updateRecordingResult();
  updateScrollHint();
}
function render(next: SettingsView): void {
  const previous = view;
  if (!next.groups.some(group => group.kind === "shortcut" && group.capturing)) { candidateToConfirm = undefined; preview = ""; }
  view = next;
  draw();
  if (previous) {
    const changes = next.groups.filter(g => g.tab === selectedTab).flatMap(g => {
      const old = previous.groups.find(o => o.id === g.id);
      const messages: string[] = [];
      if (g.noteKind === "status" && old?.note !== g.note && g.note) messages.push(g.note);
      if (JSON.stringify(old?.diagnostics) !== JSON.stringify(g.diagnostics)) messages.push(...(g.diagnostics ?? []).map(d => `${d.heading}. ${d.reason} ${d.guidance}`));
      return messages;
    });
    for (const result of previous.language === next.language ? next.recordingResults ?? [] : []) {
      const old = previous.recordingResults?.find(r => r.id === result.id);
      if (!old || old.outcome !== result.outcome) changes.unshift(`${result.reason} ${result.outcome}`);
    }
    if (changes.length) announce(changes.join(" "));
  }
}
/** Result actions run beside preference saves; only the same row refuses a duplicate. */
async function chooseResult(id: string, action: string, control: string): Promise<void> {
  const offered = view?.recordingResults?.find(r => r.id === id);
  if (!offered || resultIntents.has(id) || offered.saving) return;
  // Record the origin before anything can change focus.
  const intent = { action, control, moved: false };
  resultIntents.set(id, intent); resultErrors.delete(id);
  if (PERSISTING_ACTIONS.includes(action)) announce(text("Saving this change…"));
  draw();
  let applied = false;
  try {
    const result = await window.settings.choose(`recordingResult:${id}`, action);
    render(result.view); applied = result.applied;
  } catch { /* Keep the current projection; main owns the state. */ }
  resultIntents.delete(id);
  if (!applied) { resultErrors.add(id); announce(text("Could not complete this action. Please try again.")); }
  else if (feedback.textContent === text("Saving this change…")) announce("");
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
  if (control && area?.open && !PERSISTING_ACTIONS.includes(intent.action)) { control.focus({ preventScroll: true }); return; }
  const target = area?.querySelector<HTMLElement>(":scope > summary") ?? document.querySelector<HTMLElement>(".recording-result > summary")
    ?? document.getElementById(`tab-${selectedTab}`);
  target?.focus({ preventScroll: true });
}
async function choose(group: string, choice: string, control: string): Promise<void> {
  // The currently edited value can queue a newer intent; actions never duplicate.
  if (saving && (saving.group !== group || control.endsWith("-recovery") || control.endsWith("-retry") || (control === "shortcut-capture" || control === "shortcut-confirm"))) return;
  const id = ++requestId;
  pending++; saving = { group, choice, control }; failure = undefined; announce(""); draw();
  let success = false;
  let returnCaptureFocus = false;
  try {
    const result = await window.settings.choose(group, choice);
    if (id !== requestId) return;
    returnCaptureFocus = (control === "shortcut-capture" || control === "shortcut-confirm") && document.activeElement?.id === control && document.hasFocus();
    render(result.view); success = result.applied;
    if (!success) {
      failure = { group, choice, text: result.failure ?? result.view.failure, baseline: committed(result.view.groups.find(g => g.id === group)!) };
      announce(failure.text);
    } else if ((control === "shortcut-capture" || control === "shortcut-confirm") && !shortcutGroup()?.diagnostics?.length) announce(text("Shortcut saved"));
    else if (control.endsWith("-recovery")) announce(text("Switched to Primary display"));
  } catch {
    if (id === requestId && view) {
      failure = { group, choice, text: view.failure, baseline: committed(view.groups.find(g => g.id === group)!) }; announce(failure.text);
      if ((control === "shortcut-capture" || control === "shortcut-confirm")) void capture(false);
    }
  } finally {
    pending--; if (!pending) saving = undefined;
    // Only move focus if the user's focus is still on the disappearing field.
    const restore = document.activeElement?.id === control && document.hasFocus();
    draw();
    if ((restore || returnCaptureFocus) && document.hasFocus() && (control === "shortcut-capture" || control === "shortcut-confirm") && !shortcutGroup()?.capturing)
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
window.addEventListener("blur", () => {
  for (const intent of resultIntents.values()) intent.moved = true;
  if (shortcutGroup()?.capturing || arming) void capture(false);
});
window.settings.onChanged(render);
void window.settings.read().then(render).catch(() => {
  feedback.classList.remove("visually-hidden");
  announce(translate("Could not open settings. Close this window and open it again.", startupLanguage));
});
