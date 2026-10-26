/**
 * The panel's projection and its one request path: the view main pushed, the selected tab, saves, failures and
 * announcements, and the subscriptions `start` holds. Each other concern keeps its own state beside this module.
 */
import { flushSync } from "react-dom";
import { browserPlatform, isCloseChord } from "../../lib/shortcut-capture";
import { UNDO_KEY } from "../../../shared/shortcut-catalog";
import {
  documentLanguage,
  isLanguage,
  translate,
  type PlainMessageKey,
} from "../../../shared/i18n";
import {
  isSettingsTab,
  type SettingsBridge,
  type SettingsGroup,
  type SettingsTab,
  type SettingsView,
} from "../../../shared/settings-panel";
import {
  arming,
  beforeCapture,
  capture,
  captureNews,
  captureText,
  clearPreview,
  closingCapture,
  isCaptureControl,
} from "./shortcut";
import { reconcileResults, resultDomId, resultIntents, resultStates } from "./results";
import { settingsNews } from "./news";
import {
  cancelFolderDialog,
  cancelRename,
  closeMenu,
  dismissLibraryOverlays,
  forgetMissingFolder,
  folderDialog,
  forgetMissingItems,
  isShown,
  showEveryRecording,
  takeShown,
  menuId,
  renaming,
  undoTrash,
} from "./library";
import {
  closePlayer,
  markEscapeClosed,
  playFullScreen,
  playerHidden,
  playerVideo,
  playingItem,
  settlingEscape,
} from "./player";
import { disposeInfo, forgetInfo, hideInfo } from "./info";
import { editingItem, editorVideo, forgetEditor } from "./editor";
import { dismissToast, disposeToast, toastState } from "./toast";

declare global {
  interface Window {
    settings: SettingsBridge;
  }
}
export let view: SettingsView | undefined;
/**
 * The tab a new window opens on: the one last shown (2026-10-26, the maintainer's request, as macOS's settings windows
 * come back to their last pane; formerly always Recordings), kept in this window's storage as the sidebar's state is.
 * An entry that names a tab (the Recording Studio from the tray, a notification's recording) still opens on it.
 */
const TAB_KEY = "recordstuff.settingsTab";
function rememberedTab(): SettingsTab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return isSettingsTab(saved) ? saved : "library";
  } catch {
    return "library";
  }
}
function rememberTab(): void {
  try { localStorage.setItem(TAB_KEY, selectedTab); } catch { /* a page without storage opens on Recordings */ }
}
export let selectedTab: SettingsTab = rememberedTab();
export let feedbackText = "";
export let startupFailed = false;
/** A setting's save in flight: the choice sent, the control it came from, and its request. */
export interface Save { choice: string; control: string; request: number }
/** Why a setting's last choice did not apply, said at its row until it is changed again. */
export interface Failure {
  group: string;
  choice?: string;
  text: string;
  /** Main's value when the choice failed: a retry is offered only while it still holds. */
  baseline?: string;
  refused?: true;
  editor?: true;
}
/**
 * Each setting saves on its own (2026-10-22): its save in flight and its failure are its own, so a choice for one
 * setting is sent at once, never waiting for or dropped behind another's. Main writes the settings file through one
 * ordered queue and stamps every view with a rising revision, which render() orders by; the page needs no lock.
 */
const saves = new Map<string, Save>();
const failures = new Map<string, Failure>();
/** The save in flight for `group`, if any. */
export const savingOf = (group: string): Save | undefined => saves.get(group);
/** Whether any setting is saving: only for what must wait for every save (Hide and Quit, the shortcut editor). */
export const anySaving = (): boolean => saves.size > 0;
/** Why `group`'s last choice did not apply, if it did not. */
export const failureOf = (group: string): Failure | undefined => failures.get(group);
const capturing = (): boolean => [...saves.values()].some((save) => isCaptureControl(save.control));
let requestId = 0,
  reportedReady = false;
let resultFocus = 0,
  lastNotice: string | undefined;
/** The card a Recordings entry outlines; taken by its card once, so a remount or a later view does not outline it again. */
let arriving: string | undefined;
export const arrivingAt = (id: string): boolean => arriving === id;
export function takeArrival(id: string): boolean {
  if (arriving !== id) return false;
  arriving = undefined;
  return true;
}
const tabScroll = new Map<SettingsTab, number>();
let serial = 0;
const listeners = new Set<() => void>();
export const snapshot = (): number => serial;
export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function draw(): void {
  serial++;
  flushSync(() => {
    for (const listener of listeners) listener();
  });
}
export const text = (key: PlainMessageKey): string =>
  translate(key, view?.language);
export const platform = (): string =>
  shortcutGroup()?.platform ?? browserPlatform();
export const shortcutGroup = (): SettingsGroup | undefined =>
  view?.groups.find((g) => g.kind === "shortcut");
/** The value main says is in force for `group`. */
export const confirmed = (group: SettingsGroup | undefined): string =>
  group?.choices.find((c) => c.checked)?.id ?? "";
/**
 * The value `group` shows: the one being saved while it saves, if it is one of the group's own values, else the one main
 * confirms (2026-10-22). A control shows the user's choice at once and goes back to main's value if the save fails. An
 * action (a pane, a check) is no value, and a typed or dragged value keeps its own draft until main answers.
 */
export const committed = (group: SettingsGroup | undefined): string => {
  const save = group && saves.get(group.id);
  return save && group.choices.some((c) => c.id === save.choice) && !isAction(group, save.choice) ? save.choice : confirmed(group);
};
const isRecoveryControl = (id: string): boolean =>
  /-(retry|recovery)$/.test(id);
export const focus = (id: string | undefined): void => {
  if (id) document.getElementById(id)?.focus({ preventScroll: true });
};
/** Where announcements are said: inside the open dialog, the player's or the edit view's, else the page's. */
const liveRegion = (): string => (playingItem ? "player-feedback" : editingItem ? "editor-feedback" : "feedback");
export const announced = (): string =>
  (
    document.getElementById(liveRegion())
      ?.textContent ?? feedbackText
  ).replace(/ $/, "");
export function announce(value: string): void {
  const current =
    document.getElementById(liveRegion())
      ?.textContent ?? feedbackText;
  feedbackText =
    value && current.replace(/ $/, "") === value
      ? current === value
        ? `${value} `
        : value
      : value;
  draw();
}
/** Clears the announcer without drawing, for a change that draws itself (the player opening). */
export function clearFeedback(): void {
  feedbackText = "";
}
function reportReady(): void {
  if (reportedReady) return;
  reportedReady = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void window.settings.ready().catch(() => {});
    }),
  );
}
export function localFailure(group: string, message: string): void {
  failures.set(group, { group, text: message });
  announce(message);
}
export function setFailure(value: Failure): void {
  failures.set(value.group, value);
}
export function clearFailure(group: string): void {
  if (failures.delete(group)) draw();
}
export function isAction(
  group: SettingsGroup,
  choice: string | undefined,
): boolean {
  return (
    group.kind === "actions" ||
    Boolean(group.actions?.some((action) => action.id === choice))
  );
}
export function groupControl(
  groupId: string,
  choice?: string,
): HTMLElement | null {
  const own = document.getElementById(`setting-${groupId}`);
  if (own?.matches("select, input, [role=switch], [data-slot=select-trigger]")) return own;
  const row = document.getElementById(`setting-${groupId}-row`);
  return (
    // A checked radio that cannot be chosen (an unavailable screen) cannot take focus either: an enabled one can.
    row?.querySelector<HTMLElement>('[aria-pressed="true"], [role="radio"][aria-checked="true"]:not(:disabled)') ??
    (choice ? document.getElementById(`setting-${groupId}-${choice}`) : null) ??
    row?.querySelector<HTMLElement>('[role="radio"]:not(:disabled)') ??
    row?.querySelector<HTMLElement>(".controls button, .controls input") ??
    null
  );
}
export function retryAllowed(group: SettingsGroup): boolean {
  const failure = failures.get(group.id);
  return Boolean(
    failure?.choice &&
    group.enabled &&
    failure.baseline === confirmed(group) &&
    group.choices.some((c) => c.id === failure.choice && c.enabled),
  );
}
export function activateTab(tab: SettingsTab): void {
  if (selectedTab === tab) return;
  tabScroll.set(
    selectedTab,
    document.getElementById("settings-panel")?.scrollTop ?? 0,
  );
  if (shortcutGroup()?.capturing || arming) void capture(false);
  hideInfo();
  dismissLibraryOverlays();
  selectedTab = tab;
  rememberTab();
  draw();
  const panel = document.getElementById("settings-panel");
  if (panel) panel.scrollTop = tabScroll.get(tab) ?? 0;
  focus(`tab-${tab}`);
}
/** The Keyboard Shortcuts tab's Change… (plan 073): the recording shortcut changes only on General's Shortcut card. */
export function showShortcutCard(): void {
  activateTab("general");
  const control = document.getElementById("setting-hotkey");
  focus("setting-hotkey");
  // A recording or a save in progress disables the control; the card's row takes the focus then, still locked.
  if (document.activeElement !== control) focus("setting-hotkey-row");
  control?.scrollIntoView({ block: "nearest" });
}
/** An action (a link, a folder, a system pane) saves nothing: its retry repeats the action and is labelled so. */
export async function choose(
  group: string,
  choice: string,
  control: string,
): Promise<void> {
  // A setting being edited can send a newer intent of its own; its actions never duplicate, and the shortcut editor's
  // save stands alone, as its key capture does.
  const own = saves.get(group);
  if (own && (isRecoveryControl(control) || isCaptureControl(control))) return;
  if (isCaptureControl(control) ? saves.size > 0 : capturing()) return;
  const id = ++requestId;
  saves.set(group, { choice, control, request: id });
  failures.delete(group);
  announce("");
  draw();
  let success = false;
  let returnCaptureFocus = false;
  // Only the newest request for this setting speaks for it; a view from any request still renders by its revision.
  const newest = (): boolean => saves.get(group)?.request === id;
  try {
    const result = await window.settings.choose(group, choice);
    if (!newest()) {
      render(result.view);
      return;
    }
    returnCaptureFocus =
      isCaptureControl(control) &&
      document.activeElement?.id === control &&
      document.hasFocus();
    render(result.view);
    success = result.applied;
    if (!success) {
      const failure: Failure = {
        group,
        choice,
        text: result.failure ?? result.view.failure,
        baseline: confirmed(result.view.groups.find((g) => g.id === group)),
        ...(result.refused ? { refused: true as const } : {}),
      };
      failures.set(group, failure);
      announce(failure.text);
    } else if (
      isCaptureControl(control) &&
      !shortcutGroup()?.diagnostics?.length
    )
      announce(text("Shortcut saved"));
    // A typed value changes nothing else on screen but the example under it.
    else if (result.view.groups.find((g) => g.id === group)?.control === "text")
      announce(text("Saved; new recordings use this name."));
    // The status card's Use Primary display is the Screen row's recovery, offered where the problem is named.
    else if (
      control.endsWith("-recovery") ||
      (control === "status-action" && choice === "primary")
    )
      announce(text("Switched to Primary display"));
  } catch {
    if (newest() && view) {
      const failure: Failure = {
        group,
        choice,
        text: view.failure,
        baseline: confirmed(view.groups.find((g) => g.id === group)),
      };
      failures.set(group, failure);
      announce(failure.text);
      if (isCaptureControl(control)) void capture(false);
    }
  } finally {
    if (!newest()) return;
    saves.delete(group);
    // Only move focus if the user's focus is still on the disappearing field.
    const restore =
      document.activeElement?.id === control && document.hasFocus();
    // A retry that succeeded is hidden, and an action main stops offering is removed
    // (the shortcut card's retry); if focus already fell to the page, it goes back to the group.
    const vanished = (): boolean => {
      const el = document.getElementById(control);
      return !el || Boolean(el.closest("[hidden]"));
    };
    const lost =
      (!document.activeElement || document.activeElement === document.body) &&
      (isRecoveryControl(control) || vanished());
    draw();
    if (lost && document.hasFocus()) {
      const again = document.getElementById(control);
      // The status card hides once its fix worked and has no group row to stand for it: the tab keeps the place,
      // so the next Tab does not start over and the next Escape does not close the window.
      (again && !again.closest("[hidden]")
        ? again
        : (groupControl(group, choice) ??
          document.getElementById(`tab-${selectedTab}`))
      )?.focus({ preventScroll: true });
    }
    if (
      (restore || returnCaptureFocus) &&
      document.hasFocus() &&
      isCaptureControl(control) &&
      !shortcutGroup()?.capturing
    )
      document.getElementById("setting-hotkey")?.focus({ preventScroll: true });
  }
}
export function render(next: SettingsView): void {
  if (
    next.revision !== undefined &&
    view?.revision !== undefined &&
    next.revision < view.revision
  )
    return;
  const previous = view;
  const returned = new Set<string>();
  let endedByMain = false;
  for (const group of next.groups) {
    const old = previous?.groups.find((o) => o.id === group.id);
    if (group.capturing && !old?.capturing)
      beforeCapture.set(group.id, old ? captureNews(old) : "");
    else if (!group.capturing && old?.capturing) {
      if (beforeCapture.get(group.id) === captureNews(group))
        returned.add(group.id);
      beforeCapture.delete(group.id);
      // Cancelled, timed out or saved: a key the closed editor refused is no longer what the card is about.
      if (failures.get(group.id)?.editor) failures.delete(group.id);
      // Main ended it (its time limit, a recording starting) while the user may still be typing a combination.
      if (!closingCapture && !capturing())
        endedByMain = true;
    }
  }
  if (
    !next.groups.some((group) => group.kind === "shortcut" && group.capturing)
  )
    clearPreview();
  view = next;
  if (startupFailed) {
    // A later push drew the panel after all: the read's error is no longer true, and the region is an announcer again.
    startupFailed = false;

    announce("");
  }
  const focusedBefore =
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : undefined;
  reconcile(previous, next);
  // A push can hide the status card or remove a row's action while it has focus (a problem solved from the tray, an
  // action main no longer offers), or lock the control it is on (a recording started from the shortcut, which Chromium
  // answers by dropping focus to the page): the tab keeps the place, so the next Tab does not start over and the next
  // Escape does not close the window. A choice's own reply is left to `choose`, which knows the row that stands for it.
  if (
    focusedBefore &&
    saves.size === 0 &&
    document.hasFocus() &&
    (!focusedBefore.isConnected ||
      focusedBefore.closest("[hidden]") ||
      focusedBefore.matches(":disabled")) &&
    (document.activeElement === document.body ||
      document.activeElement === focusedBefore)
  )
    document
      .getElementById(`tab-${selectedTab}`)
      ?.focus({ preventScroll: true });
  reportReady();
  if (previous) {
    const news = settingsNews(previous, next, {
      selectedTab,
      returned,
      endedNotice:
        endedByMain && document.hasFocus()
          ? next.groups.some((g) => g.captureTimedOut)
            ? captureText(
                "Timed out after {seconds} seconds; the shortcut is unchanged. Choose Custom shortcut… to try again.",
              )
            : text("Editing ended; the shortcut is unchanged.")
          : undefined,
    });
    if (news) announce(news);
  }
}

/** Reconcile focus and explicit entry intents after React committed the new projection. */
function reconcile(
  previous: SettingsView | undefined,
  next: SettingsView,
): void {
  const active = document.activeElement as HTMLElement | null;
  const activeId = active?.id;
  const priorCard =
    active?.closest<HTMLElement>(".clip")?.dataset.id ??
    (playingItem ? playingItem.id : undefined);
  const priorResult =
    active?.closest<HTMLElement>(".recording-result")?.dataset.resultId;
  const entering = (next.resultFocus ?? 0) > resultFocus;
  resultFocus = next.resultFocus ?? 0;
  if (!next.tabs.some((tab) => tab.id === selectedTab))
    selectedTab = next.tabs[0]?.id ?? "library";
  if (entering) {
    const tab = next.entryTab ?? "failures";
    if (tab !== selectedTab && (shortcutGroup()?.capturing || arming))
      void capture(false);
    selectedTab = tab;
    rememberTab();
    arriving = tab === "library" ? next.libraryFocus : undefined;
    // A banner or menu click brought the card: its outline flashes and goes, with no focus line left in the same red
    // (2026-10-09); a key the user presses there brings the line back.
    if (arriving) document.documentElement.dataset.input = "pointer";
    // The recording it brings must be among the cards shown (plan 071).
    if (arriving) showEveryRecording();
    closePlayer(false);
    dismissLibraryOverlays();
  }
  const ids = new Set(next.library?.items.map((item) => item.id));
  if (playingItem && !ids.has(playingItem.id)) closePlayer(false);
  forgetEditor(ids);
  forgetMissingItems(ids);
  takeShown(next.library);
  forgetMissingFolder(next.library);
  // A card moved out of the folder shown, or out of the search, hands its focus on as one that left does.
  const shown = new Set(next.library?.items.filter((item) => isShown(item)).map((item) => item.id));
  const resultIds = reconcileResults(next, entering);
  forgetInfo(next);
  if (document.documentElement.lang !== documentLanguage(next.language))
    document.documentElement.lang = documentLanguage(next.language);
  if (document.title !== next.title) document.title = next.title;
  if (document.documentElement.dataset.tab !== selectedTab)
    document.documentElement.dataset.tab = selectedTab;
  if (document.documentElement.dataset.platform !== platform())
    document.documentElement.dataset.platform = platform();
  if (next.library?.notice && next.library.notice !== lastNotice)
    feedbackText = next.library.notice;
  lastNotice = next.library?.notice;
  if (toastState?.kind === "trashed" && !next.library?.trashed) dismissToast();
  draw();
  if (priorCard && !shown.has(priorCard)) {
    const old = previous?.library?.items ?? [],
      at = old.findIndex((item) => item.id === priorCard);
    const successor =
      old.slice(at + 1).find((item) => shown.has(item.id)) ??
      old
        .slice(0, at)
        .reverse()
        .find((item) => shown.has(item.id));
    focus(successor ? `clip-${successor.id}-open` : "tab-library");
  } else if (priorResult && !resultIds.has(priorResult)) {
    const old = previous?.recordingResults ?? [],
      at = old.findIndex((item) => item.id === priorResult);
    const successor =
      old.slice(at + 1).find((item) => resultIds.has(item.id)) ??
      next.recordingResults?.at(-1);
    focus(
      successor ? `${resultDomId(successor.id)}-summary` : `tab-${selectedTab}`,
    );
  } else if (
    priorResult &&
    resultStates.get(priorResult)?.open === false &&
    active?.matches("button[data-action]")
  )
    focus(`${resultDomId(priorResult)}-summary`);
  else if (
    activeId &&
    document.activeElement === document.body &&
    document.getElementById(activeId)
  )
    focus(activeId);
  if (entering) {
    const target =
      selectedTab === "library"
        ? next.libraryFocus
          ? `clip-${next.libraryFocus}-open`
          : "tab-library"
        : selectedTab === "general" && !shortcutGroup()?.capturing
          ? "setting-hotkey"
          : selectedTab === "failures"
            ? `${resultDomId((next.recordingResults?.find((r) => !r.acknowledged) ?? next.recordingResults?.[0])?.id ?? "")}-summary`
            : `tab-${selectedTab}`;
    focus(target);
    document.getElementById(target)?.scrollIntoView({ block: "nearest" });
  }
}
/** All DOM/native subscriptions have a matching disposal when the React root leaves. */
export function start(): () => void {
  const cleanups: Array<() => void> = [];
  function listen(
    target: EventTarget,
    type: string,
    handler: EventListener,
    capture = false,
  ): void {
    target.addEventListener(type, handler, capture);
    cleanups.push(() => target.removeEventListener(type, handler, capture));
  }
  listen(
    document,
    "keydown",
    (raw) => {
      const event = raw as KeyboardEvent;
      if (event.key === "Escape" && (event.repeat || settlingEscape())) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  listen(
    document,
    "pointerdown",
    (event) => {
      document.documentElement.dataset.input = "pointer";
      for (const intent of resultIntents.values())
        if (
          !document
            .getElementById(intent.control)
            ?.contains(event.target as Node)
        )
          intent.moved = true;
    },
    true,
  );
  listen(document, "focusin", (event) => {
    for (const intent of resultIntents.values())
      if (event.target !== document.getElementById(intent.control))
        intent.moved = true;
  });
  // Which input came last, in the capture phase: a control that stops a key's propagation (Base UI's slider thumb
  // stops its arrows) must not leave the page thinking the pointer was last, which hides the keyboard focus line.
  listen(
    document,
    "keydown",
    (raw) => {
      if (
        ["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(
          (raw as KeyboardEvent).key,
        )
      )
        document.documentElement.dataset.input = "keyboard";
    },
    true,
  );
  listen(document, "keydown", (raw) => {
    const event = raw as KeyboardEvent;
    if (event.defaultPrevented) return;
    const command =
      platform() === "darwin"
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
    if (
      command &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === UNDO_KEY &&
      view?.library?.trashed &&
      !playingItem &&
      !(
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
    ) {
      event.preventDefault();
      void undoTrash();
      return;
    }
    if (event.key === "Escape" && (event.repeat || settlingEscape())) {
      event.preventDefault();
      return;
    }
    // An open settings or window-actions menu takes Escape itself and closes; the window stays.
    if (
      event.key === "Escape" &&
      (document.querySelector('[data-slot="select-content"][data-open], [data-window-actions][data-open], [data-folder-actions][data-open]') ||
        (event.target instanceof Element &&
          event.target.closest('[data-slot="select-content"], [data-window-actions], [data-folder-actions]')))
    )
      return;
    // The first-launch guide's dialog takes Escape, which sets it aside (onboarding.tsx); the window stays.
    if (event.key === "Escape" && view?.onboarding) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && playingItem) {
      event.preventDefault();
      markEscapeClosed();
      closePlayer();
      return;
    }
    // The edit view never closes on Escape (2026-10-26, the maintainer's request): its dialog takes the key and lets go
    // of a selection instead (escapeEditor, from the dialog's dismissal), and the window stays.
    if (event.key === "Escape" && editingItem) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && folderDialog) {
      event.preventDefault();
      cancelFolderDialog();
      return;
    }
    if (event.key === "Escape" && renaming) {
      event.preventDefault();
      cancelRename();
      return;
    }
    if (event.key === "Escape" && menuId) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "Escape" && (shortcutGroup()?.capturing || arming)) {
      event.preventDefault();
      void capture(false, true);
      return;
    }
    if (event.key === "Escape" && hideInfo()) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && toastState?.open) {
      event.preventDefault();
      dismissToast();
      return;
    }
    // ⌘W (Ctrl+W) closes the window, as the red button does; Escape never does (2026-10-26, the maintainer's request:
    // macOS closes a window with ⌘W, and Escape only what is open in it), so one Escape too many leaves it in place.
    if (isCloseChord(event, platform())) window.close();
  });
  listen(document, "fullscreenchange", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      void playFullScreen();
    }
  });
  listen(window, "focus", () => {
    delete document.documentElement.dataset.window;
  });
  listen(window, "blur", () => {
    document.documentElement.dataset.window = "inactive";
    hideInfo();
    closeMenu();
    for (const intent of resultIntents.values()) intent.moved = true;
    if (shortcutGroup()?.capturing || arming) void capture(false);
  });
  cleanups.push(window.settings.onChanged(render));
  // Nothing sounds from a window out of sight: the player and the edit view's preview pause.
  const hidden = window.settings.onHidden?.(() => {
    playerHidden();
    editorVideo?.pause();
  });
  if (hidden) cleanups.push(hidden);
  let disposed = false;
  void window.settings
    .read()
    .then((next) => {
      if (!disposed) render(next);
    })
    .catch(() => {
      if (disposed || view) return;
      startupFailed = true;
      const lang = new URLSearchParams(location.search).get("lang");
      const language = isLanguage(lang) ? lang : undefined;
      document.documentElement.lang = documentLanguage(language);
      announce(
        translate(
          "This window could not load. Close it and open RecordStuff again.",
          language,
        ),
      );
      reportReady();
    });
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    disposeInfo();
    disposeToast();
    playerVideo?.pause();
  };
}
