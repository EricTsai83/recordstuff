/** The settings window's shell: the tabs, the status card, the page each tab draws, the footer and the overlays. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bell, Film, Wrench, Video, Settings, Lock, Keyboard, MonitorPlay, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { ScrollFades } from "../components/scroll-fades";
import { ControlTooltip } from "../components/control-tooltip";
import { TooltipProvider } from "../components/ui/tooltip";
import { HidePrompt } from "./hide-prompt";
import { ZoomToast } from "./zoom-toast";
import type { SettingsStatus } from "../../shared/settings-panel";
import { translate } from "../../shared/i18n";
import * as model from "./settings-controller";
import { Preferences } from "./tabs/preferences";
import { Studio } from "./tabs/studio";
import { WindowActions } from "./window-actions";
import { Troubleshooting } from "./tabs/troubleshooting";
import { Library, LibraryHead, LibrarySummary, RenameDialog, FolderDialog, PlayerDialog, EditorDialog } from "./tabs/library";
import { OnboardingDialog } from "./onboarding";
import { ToastHost } from "./undo-toast";
import { useDarkClass } from "../lib/color-scheme";

const tabIcons = {
  library: Film,
  studio: MonitorPlay,
  recording: Video,
  general: Settings,
  shortcuts: Keyboard,
  failures: Wrench,
};
const isPermissionStatus = (status?: SettingsStatus): boolean => status?.tone === "attention" &&
  (status.action?.id === "permission" || status.action?.id === "relaunch");
/** Where a collapsed sidebar is remembered (2026-10-17, plan 075 D19's larger preview): this window's own look only. */
const SIDEBAR_KEY = "recordstuff.sidebarCollapsed";
const remembered = (): boolean => { try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; } };

/** Whether the status card has something to say: a ready app and a recording in progress show none. */
const hasCard = (status?: SettingsStatus): boolean => Boolean(status && status.tone !== "ready" && status.tone !== "recording");
/** A collapsed sidebar's status (2026-10-20): a bell with a dot in the card's tone, named by its title, which opens the
    card beside it, so the sidebar stays as it is. */
function StatusBell({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const status = model.view?.status;
  if (!status || !hasCard(status)) return null;
  return (
    <ControlTooltip label={open ? undefined : status.title} side="right">
      <Button id="status-bell" variant="ghost" size="icon" data-tone={status.tone}
        className="status-bell darwin:window-no-drag relative size-9 short:size-8 rounded-lg text-muted-foreground hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
        aria-label={status.title} aria-expanded={open} aria-controls="status" onClick={() => setOpen(!open)}>
        <span className="notice-icon">
          <Bell aria-hidden="true" />
          <span className="notice-dot" aria-hidden="true" />
        </span>
      </Button>
    </ControlTooltip>
  );
}
function Status({ rail = false, open = false }: { rail?: boolean; open?: boolean }) {
  const current = model.view,
    status = current?.status,
    failure = model.failureOf("status")?.text ?? "",
    permission = isPermissionStatus(status),
    allowedHint = translate("Already allowed?", current?.language),
    secondaryLabel = status?.secondaryAction?.label ?? "",
    hasAllowedHint = secondaryLabel.startsWith(allowedHint),
    relaunchLabel = hasAllowedHint ? secondaryLabel.slice(allowedHint.length).trimStart() : secondaryLabel;
  return (
    <Card
      id="status"
      // Stable action IDs identify the permission card in either language.
      // The permission card is an ink tile in both themes; a recording tints the card in the recording colours.
      className={permission
        ? "status grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2 rounded-xl bg-(--permission-card-bg) p-3 text-(--permission-card-fg) shadow-(--permission-card-shadow) ring-0 dark:bg-(--permission-card-bg) dark:shadow-(--permission-card-shadow)"
        : "status gap-2.5 p-3 shadow-none data-popover:shadow-lg data-[tone=recording]:bg-recording-surface data-[tone=recording]:ring-recording-border dark:data-[tone=recording]:bg-recording-surface"}
      // Only what needs the user: a ready app and a recording in progress show no card (#feedback still says the state).
      // A collapsed sidebar says it with a bell instead (StatusBell), which opens this card beside it.
      hidden={(rail && !open) || !hasCard(status)}
      role={rail && open ? "dialog" : undefined}
      aria-labelledby={rail && open ? "status-title" : undefined}
      data-popover={(rail && open) || undefined}
      data-tone={status?.tone}
      data-permission={permission || undefined}
    >
      <span className="status-mark" aria-hidden="true" hidden={permission} />
      {permission && (
        <span className="permission-icon" aria-hidden="true">
          <Lock strokeWidth={2} />
        </span>
      )}
      <div className="status-text">
        <div className="status-heading">
          <p id="status-title" className="status-title">
            {status?.title}
          </p>
        </div>
        <p
          id="status-detail"
          className="status-detail"
          hidden={permission || !status?.detail || Boolean(current?.hint)}
        >
          {status?.detail}
        </p>
        <p id="hint" hidden={!current?.hint}>
          {current?.hint}
        </p>
        <p id="status-error" className="status-error" hidden={!failure}>
          {failure}
        </p>
      </div>
      <div className="status-actions">
        <Button
          id="status-action"
          variant="default"
          wrap={permission}
          className={permission
            ? `darwin:window-no-drag w-full min-h-8 rounded-lg py-1.5 text-center font-semibold ${status?.action?.id === "permission" ? "justify-center gap-2 px-2.5" : ""}`
            : "darwin:window-no-drag w-full"}
          hidden={!status?.action}
          data-action={status?.action?.id}
          aria-disabled={Boolean(model.savingOf("status"))}
          onClick={() => {
            if (!model.savingOf("status") && status?.action)
              void model.choose("status", status.action.id, "status-action");
          }}
        >
          {permission && status?.action?.id === "permission" && <Settings className="size-4" aria-hidden="true" />}
          {permission ? (
            <span id="status-action-label" className={status?.action?.id === "permission" ? "min-w-0 text-center" : undefined}>
              {status?.action?.label}
            </span>
          ) : status?.action?.label}
        </Button>
        <Button
          id="status-secondary"
          variant="link"
          wrap={permission}
          className={permission
            // The hint stays quiet; only the action itself follows the link style (the label below).
            ? "darwin:window-no-drag w-full min-h-7 flex-wrap gap-x-1 gap-y-0 rounded-lg px-0 py-1 text-center font-normal text-(--permission-card-muted) hover:text-(--permission-card-muted) hover:no-underline"
            : "darwin:window-no-drag h-auto min-h-6 max-w-full justify-start px-0 text-left font-normal whitespace-normal"}
          hidden={!status?.secondaryAction}
          aria-label={permission ? status?.secondaryAction?.label : undefined}
          data-action={status?.secondaryAction?.id}
          aria-disabled={Boolean(model.savingOf("status"))}
          onClick={() => {
            if (!model.savingOf("status") && status?.secondaryAction)
              void model.choose(
                "status",
                status.secondaryAction.id,
                "status-secondary",
              );
          }}
        >
          {permission ? (
            <>
              <span id="status-secondary-hint" className="whitespace-nowrap" hidden={!hasAllowedHint}>{allowedHint}</span>
              {hasAllowedHint && " "}
              <span id="status-secondary-label" className="whitespace-nowrap font-semibold text-(--permission-card-fg) decoration-current underline-offset-4 group-hover/button:text-primary group-hover/button:underline">
                {relaunchLabel}
              </span>
            </>
          ) : status?.secondaryAction?.label}
        </Button>
      </div>
    </Card>
  );
}
/** A window with room for the full sidebar: 600 px wide and more than 420 px tall (2026-10-21). Shorter, its six tabs, the
    status card and the window actions would not all show; the collapsed toolbars do. */
const ROOMY = "(min-width: 600px) and (min-height: 421px)";
export function SettingsApp() {
  const revision = useSyncExternalStore(model.subscribe, model.snapshot),
    current = model.view;
  const [roomy, setRoomy] = useState(
      () => matchMedia(ROOMY).matches,
    ),
    panel = useRef<HTMLDivElement>(null),
    [head, setHead] = useState<HTMLDivElement | null>(null),
    [collapsed, setCollapsedState] = useState(remembered);
  const setCollapsed = (value: boolean): void => {
    setCollapsedState(value);
    try { localStorage.setItem(SIDEBAR_KEY, value ? "1" : "0"); } catch { /* a page without storage keeps it until closed */ }
  };
  // A narrow or short window has no room for the full sidebar: it keeps the collapsed one, and the choice stays for a
  // window with room.
  const rail = collapsed || !roomy;
  const [statusOpen, setStatusOpen] = useState(false),
    card = hasCard(model.view?.status),
    cardOpen = rail && statusOpen && card;
  useEffect(model.start, []);
  // A card that went away or a sidebar that opened closes the bell's card: the next status shows the bell, never the
  // card unasked.
  useEffect(() => { if (!rail || !card) setStatusOpen(false); }, [rail, card]);
  useDarkClass();
  // The window controls keep their size at any zoom: the sidebar toggle beside them places itself by the page's zoom,
  // read from the renderer on every resize (a zoom changes the inner width), never from the window's outer and inner
  // widths, which a live resize updates a frame or more apart.
  useEffect(() => {
    const set = (factor: number): void => document.documentElement.style.setProperty("--page-zoom", String(factor));
    const zoom = (): void => {
      const factor = window.settings.zoomFactor?.() ?? 1;
      set(Number.isFinite(factor) && factor > 0 ? factor : 1);
    };
    zoom();
    addEventListener("resize", zoom);
    const unsubscribe = window.settings.onZoomChanged?.((next) => set(next.factor));
    return () => { removeEventListener("resize", zoom); unsubscribe?.(); };
  }, []);
  // The bell's card closes on Escape, which gives the focus back to the bell, or a press anywhere else; the window stays.
  useEffect(() => {
    if (!cardOpen) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setStatusOpen(false);
      document.getElementById("status-bell")?.focus({ preventScroll: true });
    };
    const press = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest("#status, #status-bell")) setStatusOpen(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", press, true);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", press, true); };
  }, [cardOpen]);
  useEffect(() => {
    const query = matchMedia(ROOMY),
      change = (): void => setRoomy(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const about = current?.groups.find((group) => group.id === "about"),
    quit = about?.choices.find((choice) => choice.id === "quit");
  return (
    <TooltipProvider delay={600}>
      <div className="titlebar window-drag" aria-hidden="true" />
      <main data-sidebar={rail ? "collapsed" : undefined}>
        <div className="sidebar-background darwin:window-drag" aria-hidden="true" />
        <h1 id="title" className="sr-only visually-hidden">
          {current?.title ?? "RecordStuff"}
        </h1>
        <div className="brand select-none" aria-hidden="true">
          <span className="brand-mark" />
          <span className="brand-name">RecordStuff</span>
        </div>
        <form id="settings" onSubmit={(event) => event.preventDefault()}>
          <Tabs
            value={model.selectedTab}
            orientation="vertical"
            className="settings-tabs contents"
            onValueChange={(value) => {
              if (
                value === "library" ||
                value === "studio" ||
                value === "general" ||
                value === "recording" ||
                value === "shortcuts" ||
                value === "failures"
              )
                model.activateTab(value);
            }}
          >
            <TabsList
              id="settings-tabs"
              activateOnFocus
              aria-orientation="vertical"
              // A collapsed sidebar's tabs are a floating toolbar, its icons where they were: its top padding is the list's
              // own. In a window too short for them (a small one zoomed in, or one with the status card) the tabs scroll,
              // so the card and the window actions below stay whole.
              className={`tabs col-start-1 row-start-2 max-h-full w-full flex-none flex-col items-stretch justify-start self-start overflow-y-auto [scrollbar-width:none] ${rail
                ? "rounded-[14px] bg-sidebar p-1 pt-[3px] shadow-(--sidebar-toolbar-shadow)" : ""}`}
              variant="sidebar"
              aria-label={current?.title ?? "RecordStuff"}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const tabs = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]',
                    ),
                  ],
                  at = tabs.indexOf(event.target as HTMLButtonElement);
                if (at < 0) return;
                event.preventDefault();
                const next =
                  tabs[
                    (at +
                      (event.key === "ArrowLeft" ? -1 : 1) +
                      tabs.length) %
                      tabs.length
                  ];
                next?.focus();
                next?.click();
              }}
            >
              {current?.tabs.map((tab) => {
                const Icon = tabIcons[tab.id],
                  count = /^(.*?)(\s?[（(])(\d+)([)）])$/.exec(tab.label);
                return (
                  <ControlTooltip key={tab.id} label={rail || tab.id === "failures" ? tab.label : undefined} {...(rail ? { side: "right" as const } : {})}>
                    <TabsTrigger
                      id={`tab-${tab.id}`}
                      value={tab.id}
                      aria-label={tab.accessibleLabel ?? tab.label}
                      className={`darwin:window-no-drag min-h-9 justify-start gap-2.5 ${rail
                        ? "relative short:min-h-8 group-data-[variant=sidebar]/tabs-list:px-2.5" : ""}`}
                    >
                      {/* A collapsed sidebar marks unread items with a dot on the icon's corner; the count stays in the
                          tab's name. */}
                      <span className="notice-icon">
                        <Icon className="tab-icon size-4" strokeWidth={2} />
                        {count && <span className="notice-dot tab-dot" aria-hidden="true" />}
                      </span>
                      {count ? (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <span className="tab-name min-w-0 overflow-hidden text-ellipsis">{count[1]}</span>
                          <>
                            <span className="sr-only">{count[2]}</span>
                            <Badge
                              className={`tab-badge h-[18px] min-w-[18px] shrink-0 px-0.5 tabular-nums ${rail ? "hidden" : ""}`}
                              variant="default"
                              size="md"
                            >
                              {count[3]}
                            </Badge>
                            <span className="sr-only">{count[4]}</span>
                          </>
                        </span>
                      ) : (
                        <span className="tab-name min-w-0 overflow-hidden text-ellipsis">{tab.label}</span>
                      )}
                    </TabsTrigger>
                  </ControlTooltip>
                );
              })}
            </TabsList>
            <Status rail={rail} open={cardOpen} />
            <div className="settings-content">
              {/* The card's top stays put while the page under it scrolls: the page's name, the library's summary and
                  folder controls, and Troubleshooting's section tabs. */}
              <div ref={setHead} className="settings-head darwin:window-drag">
                <p id="page-title" className="page-title" aria-hidden="true">
                  {current?.tabs
                    .find((tab) => tab.id === model.selectedTab)
                    ?.label.replace(/\s?[（(]\d+[)）]$/, "")}
                </p>
                <div className="settings-head-tools" hidden={model.selectedTab !== "library"}>
                  <LibrarySummary />
                </div>
                {/* The search and folder controls take a line of their own under the title (2026-10-09). */}
                <div className="settings-head-controls" hidden={model.selectedTab !== "library"}>
                  <LibraryHead />
                </div>
              </div>
              <div className="settings-viewport">
                <TabsContent
                  ref={panel}
                  id="settings-panel"
                  tabIndex={-1}
                  value={model.selectedTab}
                  className="settings-panel"
                >
                  <div className="settings-card">
                    <div hidden={model.selectedTab !== "library"}>
                      <Library />
                    </div>
                    {model.selectedTab === "failures" ? (
                      <Troubleshooting head={head} />
                    ) : model.selectedTab === "studio" ? (
                      <Studio />
                    ) : model.selectedTab !== "library" ? (
                      <Preferences />
                    ) : null}
                  </div>
                </TabsContent>
                <ScrollFades
                  scrollRef={panel}
                  contentRevision={revision}
                  topId="scroll-hint-top"
                  bottomId="scroll-hint"
                />
              </div>
            </div>
          </Tabs>
        </form>
        <footer id="sidebar-about" className="sidebar-about" hidden={!quit}>
          {rail && <StatusBell open={cardOpen} setOpen={setStatusOpen} />}
          {roomy && (
            // One place in either mode (2026-10-20), drawn at the top beside the window controls, so the same click opens and
            // closes it; the same button too, so a keyboard's focus stays on it as it toggles. It keeps its place in the page's
            // order here, after the tabs: the first Tab still reaches them.
            <ControlTooltip label={model.text(rail ? "Expand sidebar" : "Collapse sidebar")} side="bottom">
              <Button id="sidebar-toggle" variant="ghost" size="icon" aria-expanded={!rail} aria-controls="settings-tabs"
                aria-label={model.text(rail ? "Expand sidebar" : "Collapse sidebar")}
                // Expanded is the sidebar's state, not an open menu's: the button keeps its plain look. Only its colours
                // animate: its place follows the zoom at once, never gliding there.
                className="sidebar-toggle window-no-drag transition-colors text-muted-foreground hover:bg-sidebar-accent aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-sidebar-accent aria-expanded:hover:text-foreground"
                onClick={() => { setCollapsed(!rail); setStatusOpen(false); }}>
                {rail ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
              </Button>
            </ControlTooltip>
          )}
          {about && quit && (
            <WindowActions
              // Keyed by the mode, so its tooltip, open in the rail, never stays over the full sidebar's controls.
              key={rail ? "actions-rail" : "actions-full"}
              group={about}
              quit={quit}
              id="sidebar-about-hide"
              compact={rail}
            />
          )}
          <p
            className="sidebar-error"
            hidden={
              !(
                model.failureOf("about")?.choice === "quit" || model.failureOf("about")?.choice === "hide"
              )
            }
          >
            {model.failureOf("about")?.choice === "quit" || model.failureOf("about")?.choice === "hide"
              ? model.failureOf("about")!.text
              : ""}
          </p>
        </footer>
        <p
          id="feedback"
          className={
            model.startupFailed ? "startup-error" : "sr-only visually-hidden"
          }
          role="status"
          aria-live="polite"
        >
          {model.feedbackText}
        </p>
      </main>
      <RenameDialog />
      <FolderDialog />
      <PlayerDialog />
      <EditorDialog />
      <OnboardingDialog />
      <HidePrompt />
      <ToastHost />
      <ZoomToast />
    </TooltipProvider>
  );
}
