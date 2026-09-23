/**
 * The settings panel (docs/system-design/desktop.md). It renders the view
 * main sends and echoes back the id of the option the user picked; it holds
 * only pending user choices; main owns committed preferences.
 *
 * Every string comes from main except the one failure that can happen before
 * the first view arrives, which uses the language main put in the URL.
 */
import { isLanguage, translate } from "../shared/i18n";
import type { SettingsBridge, SettingsGroup, SettingsView } from "../shared/settings-panel";

declare global {
  interface Window {
    settings: SettingsBridge;
  }
}

const form = document.querySelector<HTMLFormElement>("#settings")!;
const heading = document.querySelector<HTMLHeadingElement>("#title")!;
const hint = document.querySelector<HTMLParagraphElement>("#hint")!;
const feedback = document.querySelector<HTMLParagraphElement>("#feedback")!;

/** Main passes the language so a failed first read can still be localized. */
const startupLanguage = ((value: string | null) => (isLanguage(value) ? value : undefined))(
  new URLSearchParams(location.search).get("lang"),
);

let view: SettingsView | undefined;
let selectedTab: "recording" | "general" = "recording";
/** Pending user intent is kept until every queued save has settled. */
let pending = 0;
let requestId = 0;
let renderedStructure = "";
let saving: { group: string; choice: string; control: string } | undefined;

function controlId(group: SettingsGroup): string {
  return `setting-${group.id}`;
}

/** Keep the save lock without flashing every otherwise-enabled control. */
function setDisabled(control: HTMLButtonElement | HTMLSelectElement, unavailable: boolean, busy: boolean): void {
  control.disabled = unavailable || busy;
  control.classList.toggle("saving-disabled", !unavailable && busy);
}

function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** Value/text pushes keep the live controls, focus and scroll position intact. */
function updateRows(groups: SettingsGroup[]): void {
  for (const group of groups) {
    const container = document.getElementById(`${controlId(group)}-row`)!;
    setText(container.querySelector("label, .group-label")!, group.label);
    const note = container.querySelector(".note");
    if (note) setText(note, group.note ?? "");
    if (group.kind !== "actions") {
      const select = container.querySelector("select")!;
      setDisabled(select, !group.enabled, saving !== undefined && saving.control !== select.id);
      for (const [index, choice] of group.choices.entries()) {
        const option = select.options[index]!;
        setText(option, choice.label);
        option.disabled = !choice.enabled;
      }
      const value = saving?.group === group.id
        ? saving.choice : group.choices.find((choice) => choice.checked)?.id ?? "";
      if (select.value !== value) select.value = value;
    }
    for (const choice of group.kind === "actions" ? group.choices : group.actions ?? []) {
      const button = document.getElementById(`${controlId(group)}-${choice.id}`) as HTMLButtonElement;
      setText(button, choice.label);
      setDisabled(button, !group.enabled || !choice.enabled, saving !== undefined);
    }
  }
}

function actionButton(group: SettingsGroup, choice: SettingsGroup["choices"][number]): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = `${controlId(group)}-${choice.id}`;
  button.textContent = choice.label;
  setDisabled(button, !group.enabled || !choice.enabled, saving !== undefined);
  button.addEventListener("click", () => void choose(group.id, choice.id, button.id));
  return button;
}

function row(group: SettingsGroup): HTMLElement {
  const container = document.createElement("div");
  container.className = "row";
  container.id = `${controlId(group)}-row`;
  if (group.kind === "actions") {
    const label = document.createElement("p");
    label.className = "group-label";
    label.textContent = group.label;
    container.append(label);
    if (group.note) {
      const note = document.createElement("p");
      note.className = "note";
      note.setAttribute("role", "status");
      note.textContent = group.note;
      container.append(note);
    }
    for (const choice of group.choices) container.append(actionButton(group, choice));
    return container;
  }
  const select = document.createElement("select");
  select.id = controlId(group);
  setDisabled(select, !group.enabled, saving !== undefined && saving.control !== select.id);
  const label = document.createElement("label");
  label.htmlFor = select.id;
  label.textContent = group.label;
  container.append(label);
  if (group.note) {
    const note = document.createElement("p");
    note.className = "note";
    note.id = `${select.id}-note`;
    note.textContent = group.note;
    select.setAttribute("aria-describedby", note.id);
    container.append(note);
  }
  for (const choice of group.choices) {
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.label;
    option.selected = saving?.group === group.id ? choice.id === saving.choice : choice.checked;
    option.disabled = !choice.enabled;
    select.append(option);
  }
  select.addEventListener("change", () => void choose(group.id, select.value, select.id));
  const control = document.createElement("div");
  control.className = "select-control";
  control.append(select);
  container.append(control);
  // Buttons belonging to this preference, e.g. the system pane that can
  // override it. They follow the control so the card reads top to bottom.
  for (const choice of group.actions ?? []) container.append(actionButton(group, choice));
  return container;
}

function draw(): void {
  const current = view;
  if (!current) return;
  document.documentElement.lang = current.language === "zh-TW" ? "zh-Hant" : "en";
  document.title = current.title;
  setText(heading, current.title);
  setText(hint, current.hint);
  const groups = current.groups.filter((group) => group.tab === selectedTab);
  // Rebuild only for a tab/layout change, not pending saves or value pushes.
  const structure = JSON.stringify([selectedTab, current.tabs.map((tab) => tab.id),
    groups.map((group) => [group.id, group.kind, Boolean(group.note),
      group.choices.map((choice) => choice.id), group.actions?.map((choice) => choice.id)])]);
  if (structure === renderedStructure) {
    form.querySelector('[role="tablist"]')!.setAttribute("aria-label", current.title);
    for (const tab of current.tabs) setText(document.getElementById(`tab-${tab.id}`)!, tab.label);
    updateRows(groups);
    return;
  }
  renderedStructure = structure;
  // Rebuilding replaces the focused control; put focus back on its successor
  // so a push or a save does not drop the user out of the form.
  const active = document.activeElement;
  const restore = active instanceof HTMLElement && form.contains(active) ? active.id : "";
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", current.title);
  for (const tab of current.tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `tab-${tab.id}`;
    button.textContent = tab.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(selectedTab === tab.id));
    button.setAttribute("aria-controls", "settings-panel");
    button.tabIndex = selectedTab === tab.id ? 0 : -1;
    button.addEventListener("click", () => { selectedTab = tab.id; draw(); document.getElementById(button.id)?.focus(); });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      selectedTab = event.key === "Home" ? "recording" : event.key === "End" ? "general" : selectedTab === "recording" ? "general" : "recording";
      draw();
      document.getElementById(`tab-${selectedTab}`)?.focus();
    });
    tabs.append(button);
  }
  const panel = document.createElement("div");
  panel.id = "settings-panel";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `tab-${selectedTab}`);
  panel.append(...groups.map(row));
  form.replaceChildren(tabs, panel);
  if (restore) document.getElementById(restore)?.focus({ preventScroll: true });
}

function render(next: SettingsView): void {
  view = next;
  draw();
}

async function choose(group: string, choice: string, control: string): Promise<void> {
  const id = ++requestId;
  pending += 1;
  saving = { group, choice, control };
  feedback.textContent = "";
  draw();
  try {
    const result = await window.settings.choose(group, choice);
    if (id !== requestId) return;
    view = result.view;
    if (!result.applied) feedback.textContent = result.view.failure;
  } catch {
    if (id === requestId && view) feedback.textContent = view.failure;
  } finally {
    pending -= 1;
    if (pending === 0) saving = undefined;
    draw();
  }
}

form.addEventListener("submit", (event) => event.preventDefault());
document.addEventListener("keydown", (event) => {
  // The panel has no application menu of its own on macOS: close it here.
  if (event.key === "Escape" || (event.key === "w" && (event.metaKey || event.ctrlKey))) window.close();
});
window.settings.onChanged(render);
void window.settings.read().then(render).catch(() => {
  feedback.textContent = translate("Could not open settings. Close this window and open it again.", startupLanguage);
});
