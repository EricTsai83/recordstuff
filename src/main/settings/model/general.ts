/**
 * The General and Keyboard Shortcuts rows: the recording shortcut and the shortcut list, updates, notifications, the
 * icon's click and the language.
 */
import { translate as t, type Language } from "../../../shared/i18n";
import { DEFAULT_HOTKEY, settingsShortcut, describeAccelerator, isSettingsShortcut, sameShortcut } from "../../../shared/hotkey";
import type { ShortcutRowView } from "../../../shared/settings-panel";
import { SHORTCUT_CATEGORIES, SHORTCUT_CATEGORY_LABELS, shortcutCatalog, shortcutKeys, shortcutText, type CatalogShortcut } from "../../../shared/shortcut-catalog";
import type { AppAction, AppContext } from "../../app/ui-model";
import { type Group, group, switchChoices } from "./group";

/**
 * One recommended shortcut, the current custom value, and Off. A registration the OS refused is
 * never silent: the saved choice stays selected and a diagnostic says it is inert.
 */
export function hotkeyGroup(ctx: AppContext, enabled: boolean): Group {
  const hotkey = ctx.hotkey;
  const language = ctx.language;
  const unavailable = hotkey.enabled && !hotkey.registered
    ? t("Another app may be using this shortcut.", language)
    : undefined;
  const diagnostics = hotkeyDiagnostics(ctx, unavailable);
  const recommended = DEFAULT_HOTKEY.accelerator;
  const current = (accelerator: string): boolean => sameShortcut(accelerator, hotkey.accelerator, ctx.platform);
  const accelerators = current(recommended) ? [recommended] : [recommended, hotkey.accelerator];
  return { ...group("hotkey", t("Shortcut", language), enabled, [
    ...accelerators.map((accelerator) => ({
      id: accelerator,
      label: accelerator === recommended
        ? t("Recommended: {shortcut}", language, { shortcut: describeAccelerator(accelerator, ctx.platform) })
        : t("{shortcut} (custom)", language, { shortcut: describeAccelerator(accelerator, ctx.platform) }),
      // A remembered combination that is now the Settings shortcut is refused if chosen again; only the current one stays selectable.
      enabled: !isSettingsShortcut(accelerator, ctx.platform) || (hotkey.enabled && current(accelerator)),
      checked: hotkey.enabled && current(accelerator),
      action: { setHotkey: { enabled: true, accelerator } } satisfies AppAction,
    })),
    {
      id: "off",
      label: t("Off", language),
      enabled: true,
      checked: !hotkey.enabled,
      // Keep the remembered accelerator so re-enabling restores the choice.
      action: { setHotkey: { enabled: false, accelerator: hotkey.accelerator } },
    },
  ], undefined), kind: "shortcut", platform: ctx.platform,
    ...((unavailable || ctx.settingsShortcut?.kind === "failed") ? { actions: [{ id: HOTKEY_RETRY_ID, label: t("Retry shortcut registration", language), enabled: true, checked: false, action: "retryShortcuts" as const }] } : {}),
    ...(diagnostics.length ? { diagnostics } : {}) };
}

/** Why a shortcut this card owns does not work: the recording one, and RecordStuff's own (⌥⌘,), which the tray also explains. */
function hotkeyDiagnostics(ctx: AppContext, unavailable: string | undefined): NonNullable<Group["diagnostics"]> {
  const language = ctx.language;
  const settings = describeAccelerator(settingsShortcut(ctx.platform), ctx.platform);
  const kind = ctx.settingsShortcut?.kind;
  return [
    ...(unavailable ? [{ kind: "current" as const, heading: t("Shortcut unavailable", language), reason: unavailable,
      guidance: t("Record from the menu, or choose another shortcut.", language) }] : []),
    ...(kind === "failed" ? [{ kind: "current" as const, heading: t("The shortcut for RecordStuff is unavailable", language),
      reason: t("Another app may be using {shortcut}.", language, { shortcut: settings }),
      guidance: t(ctx.platform === "darwin" ? "Open RecordStuff from the menu bar icon, or retry once the other app releases it."
        : "Open RecordStuff from the system tray icon, or retry once the other app releases it.", language) }] : []),
    ...(kind === "conflict" ? [{ kind: "current" as const, heading: t("The shortcut for RecordStuff is unavailable", language),
      reason: t("{shortcut} is the recording shortcut, so it does not open RecordStuff.", language, { shortcut: settings }),
      guidance: t("Choose another recording shortcut to open RecordStuff with {shortcut} again.", language, { shortcut: settings }) }] : []),
  ];
}

/**
 * The Keyboard Shortcuts tab (plan 073): one read-only section per catalog category. Only main knows whether the two
 * global shortcuts work, so their rows show the current choice and status here, with the Shortcut card's reasons.
 */
export function shortcutListGroups(ctx: AppContext): Group[] {
  const { language, platform, hotkey } = ctx;
  const settingsKind = ctx.settingsShortcut?.kind;
  const unavailable = (reason: string): ShortcutRowView["status"] => ({ kind: "unavailable", label: t("Unavailable", language), reason });
  const status = (id: string): ShortcutRowView["status"] => {
    if (id === "record") {
      if (!hotkey.enabled) return { kind: "off", label: t("Off", language) };
      return hotkey.registered ? undefined : unavailable(t("Another app may be using this shortcut.", language));
    }
    if (id !== "open") return undefined;
    const settings = describeAccelerator(settingsShortcut(platform), platform);
    return settingsKind === "failed" ? unavailable(t("Another app may be using {shortcut}.", language, { shortcut: settings }))
      : settingsKind === "conflict" ? unavailable(t("{shortcut} is the recording shortcut, so it does not open RecordStuff.", language, { shortcut: settings }))
        : undefined;
  };
  const row = (shortcut: CatalogShortcut): ShortcutRowView => {
    // The recording row shows the user's own combination; Off still names it, as the Shortcut card remembers it.
    const keys = shortcut.id === "record" ? [hotkey.accelerator] : shortcut.keys;
    const rowStatus = status(shortcut.id);
    return {
      id: shortcut.id,
      label: t(shortcut.label, language),
      keys: keys.map((key) => shortcutKeys(key, platform)),
      spoken: keys.map((key) => shortcutText(key, platform)),
      ...(shortcut.gesture ? { gesture: t(shortcut.gesture, language) } : {}),
      ...(shortcut.where ? { where: t(shortcut.where, language) } : {}),
      ...(rowStatus ? { status: rowStatus } : {}),
      ...(shortcut.id === "record" ? { change: t("Change in General", language) } : {}),
    };
  };
  const catalog = shortcutCatalog(platform);
  return SHORTCUT_CATEGORIES.map((category) => {
    const id = `shortcutList:${category}`, label = t(SHORTCUT_CATEGORY_LABELS[category], language);
    return { id, label, tab: "shortcuts", kind: "shortcutList", section: id, sectionHeading: label, enabled: true, choices: [],
      shortcuts: catalog.filter((shortcut) => shortcut.category === category).map(row) };
  });
}

export function updateChecksGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  return { ...group("updateChecks", t("Check for updates on launch", language), enabled,
    switchChoices(language, ctx.updates.enabled, (value) => ({ setUpdateChecks: value }))) };
}

export function updateActions(ctx: AppContext, enabled: boolean): Group {
  const { state } = ctx.updates;
  const result = state.kind === "checking" ? state.previous : state;
  const language = ctx.language;
  // A check in progress is busy, not unavailable: the button just pressed keeps keyboard focus.
  const busy = state.kind === "checking" ? { busy: true } : {};
  const choices: Group["choices"] = [{
    id: "check", label: t(state.kind === "checking" ? "Checking for updates…" : "Check for updates…", language),
    enabled: true, ...busy, checked: false, action: "checkUpdates",
  }];
  if (result?.kind === "available" || result?.kind === "failed") choices.push({
    id: "open", label: result.kind === "available"
      ? t("Download {version}…", language, { version: result.version })
      : t("Open releases page…", language),
    enabled: true, ...busy, checked: false, action: "openUpdate",
  });
  // Every result is a status note, which the page reads out; the button only offers what to do about it.
  const note = result?.kind === "current"
    ? t("Up to date (checked {time})", language, { time: new Date(result.checkedAt).toLocaleString(language) })
    : result?.kind === "available" ? t("Version {version} is available.", language, { version: result.version })
    : result?.kind === "failed" ? t("Could not check for updates.", language)
    : undefined;
  // Not "Updates" again: that is already the section's heading.
  return { ...group("updates", t("Manual check", language), enabled, choices, note), kind: "actions", noteKind: "status" };
}

/**
 * One switch for every notification the app sends, after Cap's design
 * (CapSoftware/Cap, apps/desktop/src-tauri/src/notifications.rs): the send
 * path checks one boolean and nothing else. Cap can also gate its switch on
 * the OS permission because Tauri exposes `isPermissionGranted`; Electron has
 * no equivalent — `getMediaAccessStatus` accepts microphone, camera and
 * screen only — so the app never claims to know the OS state. The ⓘ
 * carries the recovery path instead of a status line that could be wrong.
 */
export function notificationsGroup(ctx: AppContext, enabled: boolean): Group {
  const language = ctx.language;
  // The switch controls OS notifications; in-app failure status stays available.
  const switchGroup = group("notifications", t("Notifications", language), enabled,
    switchChoices(language, ctx.notifications, (value) => ({ setNotifications: value })));
  if (!ctx.notifications) switchGroup.info = t(ctx.platform === "darwin" ? "Failures still appear in the menu bar and the Troubleshooting tab."
    : "Failures still appear in the system tray and the Troubleshooting tab.", language);
  else if (ctx.platform === "darwin") switchGroup.info = t("macOS must also allow RecordStuff in System Settings → Notifications.", language);
  // Only macOS hides notifications behind a pane worth linking to. It sits in
  // this card so the switch and the permission that can override it read as
  // one decision rather than two unrelated settings.
  if (ctx.platform !== "darwin") return switchGroup;
  return { ...switchGroup, actions: [{
    id: "openSettings",
    label: t("Open notification settings…", language),
    enabled: true,
    checked: false,
    action: "openNotificationSettings" satisfies AppAction,
  }] };
}

/**
 * What the icon's left click does (2026-10-04). Never locked: a session holds nothing that depends on it,
 * and the next click simply follows the new choice. The right click always opens the menu, as the ⓘ says.
 */
export function trayClickGroup(ctx: AppContext): Group {
  const language = ctx.language;
  const current = ctx.trayClick ?? "record";
  return { ...group("trayClick", t("Icon click", language), true,
    (["menu", "record"] as const).map((value) => ({
      id: value, label: t(value === "menu" ? "Open the menu" : "Start / stop recording", language),
      enabled: true, checked: value === current, action: { setTrayClick: value },
    }))), info: t("A right click always opens the menu.", language) };
}

/** Language is presentation only: it never touches a running capture, so it is never locked. */
export function languageGroup(language: Language): Group {
  return group("language", t("Language", language), true, (["en", "zh-TW"] as const).map((value) => ({
    id: value,
    label: value === "en" ? "English" : "繁體中文",
    enabled: true,
    checked: value === language,
    action: { setLanguage: value },
  })));
}

/** The shortcut card's retry action; the card's only choice id besides Off that is not a combination. */
const HOTKEY_RETRY_ID = "retryRegistration";

/**
 * Whether a shortcut-card choice proposes a combination: the editor sends any
 * accelerator as the choice id, so every id but Off and the card's own action is one.
 */
export function proposesHotkey(groupId: unknown, choiceId: unknown): boolean {
  return groupId === "hotkey" && choiceId !== "off" && choiceId !== HOTKEY_RETRY_ID;
}
