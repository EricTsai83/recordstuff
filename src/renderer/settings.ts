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
/** Pending user intent is kept until every queued save has settled. */
let pending = 0;
let requestId = 0;
let saving: { group: string; choice: string; control: string } | undefined;

function controlId(group: SettingsGroup): string {
  return `setting-${group.id}`;
}

function row(group: SettingsGroup): HTMLElement {
  const container = document.createElement("div");
  container.className = "row";
  const select = document.createElement("select");
  select.id = controlId(group);
  select.disabled = !group.enabled || (saving !== undefined && saving.control !== select.id);
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
  return container;
}

function draw(): void {
  const current = view;
  if (!current) return;
  document.documentElement.lang = current.language === "zh-TW" ? "zh-Hant" : "en";
  document.title = current.title;
  heading.textContent = current.title;
  hint.textContent = current.hint;
  // Rebuilding replaces the focused control; put focus back on its successor
  // so a push or a save does not drop the user out of the form.
  const active = document.activeElement;
  const restore = active instanceof HTMLElement && form.contains(active) ? active.id : "";
  form.replaceChildren(...current.groups.map(row));
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
