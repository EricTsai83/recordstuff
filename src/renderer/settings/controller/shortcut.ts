/** The shortcut editor's session: arming, the combination being typed, and what the card said before it opened. */
import { acceleratorKeys, describeAccelerator } from "../../../shared/hotkey";
import { translate } from "../../../shared/i18n";
import {
  SHORTCUT_CAPTURE_TIMEOUT_MS,
  type SettingsGroup,
} from "../../../shared/settings-panel";
import {
  announce,
  draw,
  localFailure,
  render,
  saving,
  setFailure,
  shortcutGroup,
  text,
  view,
} from "./core";

export let arming = false;
export let closingCapture = false;
let captureGeneration = 0;
export let preview = "";
export let previewParts: string[] = [];
export let candidateToConfirm: string | undefined;
export const isCaptureControl = (id: string): boolean =>
  id === "shortcut-capture" || id === "shortcut-confirm";
export const captureNews = (group: SettingsGroup): string =>
  JSON.stringify([group.note, group.diagnostics]);
export const beforeCapture = new Map<string, string>();
export const captureText = (
  key:
    | "Press a combination and Confirm within {seconds} seconds; Esc cancels"
    | "Timed out after {seconds} seconds; the shortcut is unchanged. Choose Custom shortcut… to try again.",
): string =>
  translate(key, view?.language, {
    seconds: SHORTCUT_CAPTURE_TIMEOUT_MS / 1000,
  });
export function setPreview(accelerator: string, p: string): void {
  preview = describeAccelerator(accelerator, p);
  previewParts = acceleratorKeys(accelerator, p);
}
export function setCandidate(candidate: string | undefined): void {
  candidateToConfirm = candidate;
}
/** No editor is open any more: nothing typed is waiting to be confirmed. */
export function clearPreview(): void {
  candidateToConfirm = undefined;
  preview = "";
  previewParts = [];
}
export async function capture(armed: boolean, restore = false): Promise<void> {
  if (
    armed &&
    (!shortcutGroup()?.enabled ||
      saving ||
      arming ||
      shortcutGroup()?.capturing)
  )
    return;
  const generation = ++captureGeneration;
  arming = armed;
  preview = "";
  previewParts = [];
  candidateToConfirm = undefined;
  if (armed) {
    setFailure(undefined);
    announce("");
  } else closingCapture = true;
  draw();
  try {
    const next = await window.settings.capture(armed);
    if (generation !== captureGeneration) return;
    arming = false;
    render(next);
    if (armed && shortcutGroup()?.capturing)
      document
        .getElementById("shortcut-capture")
        ?.focus({ preventScroll: true });
    else if (armed)
      localFailure("hotkey", text("Could not edit the shortcut. Try again."));
    if (!armed && restore && document.hasFocus())
      document.getElementById("setting-hotkey")?.focus({ preventScroll: true });
  } catch {
    if (generation !== captureGeneration) return;
    arming = false;
    localFailure("hotkey", text("Could not edit the shortcut. Try again."));
  } finally {
    if (!armed && generation === captureGeneration) closingCapture = false;
  }
}
