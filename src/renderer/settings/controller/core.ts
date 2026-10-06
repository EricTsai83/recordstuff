/**
 * The panel's projection and its one request path: the view main pushed, the selected tab, saves, failures and
 * announcements, and the subscriptions `start` holds. Each other concern keeps its own state beside this module.
 */
import { flushSync } from "react-dom";
import { browserPlatform, isCloseChord } from "../../lib/shortcut-capture";
import {
  documentLanguage,
  isLanguage,
  sentences,
  translate,
  type PlainMessageKey,
} from "../../../shared/i18n";
import type {
  SettingsBridge,
  SettingsGroup,
  SettingsTab,
  SettingsView,
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
import {
  cancelRename,
  closeMenu,
  dismissLibraryOverlays,
  forgetMissingItems,
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
import { dismissToast, disposeToast, toastState } from "./toast";

declare global {
  interface Window {
    settings: SettingsBridge;
  }
}
export let view: SettingsView | undefined;
export let selectedTab: SettingsTab = "library";
export let feedbackText = "";
export let startupFailed = false;
export let saving:
  | { group: string; choice: string; control: string }
  | undefined;
export let failure:
  | {
      group: string;
      choice?: string;
      text: string;
      baseline?: string;
      refused?: true;
      editor?: true;
    }
  | undefined;
let requestId = 0,
  pending = 0,
  reportedReady = false;
let resultFocus = 0,
  lastNotice: string | undefined;
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
export const committed = (group: SettingsGroup | undefined): string =>
  group?.choices.find((c) => c.checked)?.id ?? "";
const isRecoveryControl = (id: string): boolean =>
  /-(retry|recovery)$/.test(id);
export const focus = (id: string | undefined): void => {
  if (id) document.getElementById(id)?.focus({ preventScroll: true });
};
export const announced = (): string =>
  (
    document.getElementById(playingItem ? "player-feedback" : "feedback")
      ?.textContent ?? feedbackText
  ).replace(/ $/, "");
export function announce(value: string): void {
  const current =
    document.getElementById(playingItem ? "player-feedback" : "feedback")
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
  failure = { group, text: message };
  announce(message);
}
export function setFailure(value: typeof failure): void {
  failure = value;
}
export function clearFailure(group: string): void {
  if (failure?.group === group) {
    failure = undefined;
    draw();
  }
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
    row?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
    (choice ? document.getElementById(`setting-${groupId}-${choice}`) : null) ??
    row?.querySelector<HTMLElement>(".controls button, .controls input") ??
    null
  );
}
export function retryAllowed(group: SettingsGroup): boolean {
  return Boolean(
    failure?.choice &&
    failure.group === group.id &&
    group.enabled &&
    failure.baseline === committed(group) &&
    group.choices.some((c) => c.id === failure?.choice && c.enabled),
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
  draw();
  const panel = document.getElementById("settings-panel");
  if (panel) panel.scrollTop = tabScroll.get(tab) ?? 0;
  focus(`tab-${tab}`);
}
/** An action (a link, a folder, a system pane) saves nothing: its retry repeats the action and is labelled so. */
export async function choose(
  group: string,
  choice: string,
  control: string,
): Promise<void> {
  // The currently edited value can queue a newer intent; actions never duplicate.
  if (
    saving &&
    (saving.group !== group ||
      isRecoveryControl(control) ||
      isCaptureControl(control))
  )
    return;
  const id = ++requestId;
  pending++;
  saving = { group, choice, control };
  failure = undefined;
  announce("");
  draw();
  let success = false;
  let returnCaptureFocus = false;
  try {
    const result = await window.settings.choose(group, choice);
    if (id !== requestId) return;
    returnCaptureFocus =
      isCaptureControl(control) &&
      document.activeElement?.id === control &&
      document.hasFocus();
    render(result.view);
    success = result.applied;
    if (!success) {
      failure = {
        group,
        choice,
        text: result.failure ?? result.view.failure,
        baseline: committed(result.view.groups.find((g) => g.id === group)!),
        ...(result.refused ? { refused: true as const } : {}),
      };
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
    if (id === requestId && view) {
      failure = {
        group,
        choice,
        text: view.failure,
        baseline: committed(view.groups.find((g) => g.id === group)!),
      };
      announce(failure.text);
      if (isCaptureControl(control)) void capture(false);
    }
  } finally {
    pending--;
    if (!pending) saving = undefined;
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
      if (failure?.group === group.id && failure.editor) failure = undefined;
      // Main ended it (its time limit, a recording starting) while the user may still be typing a combination.
      if (!closingCapture && !(saving && isCaptureControl(saving.control)))
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
    !pending &&
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
    // Only news is read out: a language switch retranslates every note and row without changing them.
    const sameLanguage = previous.language === next.language;
    const say = (parts: string[]): string =>
      sentences(parts.filter(Boolean), next.language);
    const changes = next.groups
      .filter(
        (g) => sameLanguage && g.tab === selectedTab && !returned.has(g.id),
      )
      .flatMap((g) => {
        const old = previous.groups.find((o) => o.id === g.id);
        const messages: string[] = [];
        // A status note a diagnostic also states as its reason is read once, with the diagnostic.
        const reasons = new Set((g.diagnostics ?? []).map((d) => d.reason));
        // A finished action (the update check) is news even when its result repeats the last one.
        const finished =
          Boolean(old?.choices.some((c) => c.busy)) &&
          !g.choices.some((c) => c.busy);
        if (
          g.noteKind === "status" &&
          g.note &&
          (old?.note !== g.note || finished) &&
          !reasons.has(g.note)
        )
          messages.push(g.note);
        if (JSON.stringify(old?.diagnostics) !== JSON.stringify(g.diagnostics))
          messages.push(
            ...(g.diagnostics ?? []).map((d) =>
              say([d.heading, d.reason, d.guidance]),
            ),
          );
        return messages;
      });
    if (endedByMain && document.hasFocus())
      changes.unshift(
        next.groups.some((g) => g.captureTimedOut)
          ? captureText(
              "Timed out after {seconds} seconds; the shortcut is unchanged. Choose Custom shortcut… to try again.",
            )
          : text("Editing ended; the shortcut is unchanged."),
      );
    // The history arriving from disk is not news: every row would be read out at once.
    const historyLoaded =
      Boolean(previous.recordingHistoryStatus) && !next.recordingHistoryStatus;
    const olds = new Map(
      (previous.recordingResults ?? []).map((r) => [r.id, r]),
    );
    const results =
      sameLanguage && !historyLoaded ? (next.recordingResults ?? []) : [];
    // Newest first, so a new failure precedes every known row; rows after one are older ones paged into view.
    const firstKnown = results.findIndex((r) => olds.has(r.id));
    for (const [index, result] of results.entries()) {
      const old = olds.get(result.id);
      if (!old) {
        if (firstKnown === -1 || index < firstKnown)
          changes.unshift(say([result.reason, result.outcome]));
      } else if (old.outcome !== result.outcome)
        changes.unshift(say([result.reason, result.outcome]));
      else if (
        result.persistenceWarning &&
        old.persistenceWarning !== result.persistenceWarning
      )
        changes.push(say([result.reason, result.persistenceWarning]));
    }
    // The status card is no live region (`#feedback` stays the one announcer), so a state it newly shows is read here:
    // a recording started from the shortcut, a save, a problem that appeared, a countdown after starting (the same tone).
    // Once per state, not every countdown second, and not again when a diagnostic already says it; Ready says nothing.
    const status = next.status,
      was = previous.status;
    if (
      sameLanguage &&
      status &&
      status.tone !== "ready" &&
      (status.tone !== was?.tone ||
        status.phase !== was?.phase ||
        (status.tone === "attention" && status.title !== was?.title)) &&
      !changes.some((change) => change.includes(status.title))
    )
      changes.unshift(say([status.title, status.detail]));
    if (changes.length) announce(say(changes));
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
    closePlayer(false);
    dismissLibraryOverlays();
  }
  const ids = new Set(next.library?.items.map((item) => item.id));
  if (playingItem && !ids.has(playingItem.id)) closePlayer(false);
  forgetMissingItems(ids);
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
  if (priorCard && !ids.has(priorCard)) {
    const old = previous?.library?.items ?? [],
      at = old.findIndex((item) => item.id === priorCard);
    const successor =
      old.slice(at + 1).find((item) => ids.has(item.id)) ??
      old
        .slice(0, at)
        .reverse()
        .find((item) => ids.has(item.id));
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
  listen(document, "keydown", (raw) => {
    const event = raw as KeyboardEvent;
    if (
      [
        "Tab",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      document.documentElement.dataset.input = "keyboard";
    if (event.defaultPrevented) return;
    const command =
      platform() === "darwin"
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
    if (
      command &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "z" &&
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
    // An open settings menu (shadcn Select) takes Escape itself and closes; the window stays (2026-10-07).
    if (
      event.key === "Escape" &&
      (document.querySelector('[data-slot="select-content"][data-open]') ||
        (event.target instanceof Element &&
          event.target.closest('[data-slot="select-content"]')))
    )
      return;
    if (event.key === "Escape" && playingItem) {
      event.preventDefault();
      markEscapeClosed();
      closePlayer();
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
    if (event.key === "Escape" || isCloseChord(event, platform()))
      window.close();
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
  const hidden = window.settings.onHidden?.(playerHidden);
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
