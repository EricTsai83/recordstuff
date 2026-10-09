/** The settings window's shell: the tabs, the status card, the page each tab draws, the footer and the overlays. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Film, Wrench, Video, Settings, Lock } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { ScrollFades } from "../components/scroll-fades";
import { ControlTooltip } from "../components/control-tooltip";
import { TooltipProvider } from "../components/ui/tooltip";
import { ZoomToast } from "./zoom-toast";
import type { SettingsStatus } from "../../shared/settings-panel";
import { translate } from "../../shared/i18n";
import * as model from "./settings-controller";
import { Preferences } from "./tabs/preferences";
import { WindowActions } from "./window-actions";
import { Troubleshooting } from "./tabs/troubleshooting";
import { Library, LibraryHead, LibrarySummary, RenameDialog, FolderDialog, PlayerDialog } from "./tabs/library";
import { ToastHost } from "./undo-toast";
import { useDarkClass } from "../lib/color-scheme";

const tabIcons = {
  library: Film,
  recording: Video,
  general: Settings,
  failures: Wrench,
};
const isPermissionStatus = (status?: SettingsStatus): boolean => status?.tone === "attention" &&
  (status.action?.id === "permission" || status.action?.id === "relaunch");
function Status() {
  const current = model.view,
    status = current?.status,
    failure = model.failure?.group === "status" ? model.failure.text : "",
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
        : "status gap-2.5 p-3 shadow-none data-[tone=recording]:bg-recording-surface data-[tone=recording]:ring-recording-border dark:data-[tone=recording]:bg-recording-surface"}
      // Only what needs the user: a ready app and a recording in progress show no card (#feedback still says the state).
      hidden={!status || status.tone === "ready" || status.tone === "recording"}
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
            ? `darwin:wide:window-no-drag w-full min-h-8 rounded-lg py-1.5 text-center font-semibold ${status?.action?.id === "permission" ? "justify-center gap-2 px-2.5" : ""}`
            : "darwin:wide:window-no-drag wide:w-full"}
          hidden={!status?.action}
          data-action={status?.action?.id}
          aria-disabled={Boolean(model.saving)}
          onClick={() => {
            if (!model.saving && status?.action)
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
            ? "darwin:wide:window-no-drag w-full min-h-7 flex-wrap gap-x-1 gap-y-0 rounded-lg px-0 py-1 text-center font-normal text-(--permission-card-muted) hover:text-(--permission-card-muted) hover:no-underline"
            : "darwin:wide:window-no-drag h-auto min-h-6 max-w-full justify-start px-0 text-left font-normal whitespace-normal"}
          hidden={!status?.secondaryAction}
          aria-label={permission ? status?.secondaryAction?.label : undefined}
          data-action={status?.secondaryAction?.id}
          aria-disabled={Boolean(model.saving)}
          onClick={() => {
            if (!model.saving && status?.secondaryAction)
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
export function SettingsApp() {
  const revision = useSyncExternalStore(model.subscribe, model.snapshot),
    current = model.view;
  const [vertical, setVertical] = useState(
      () => matchMedia("(min-width: 600px)").matches,
    ),
    panel = useRef<HTMLDivElement>(null),
    [head, setHead] = useState<HTMLDivElement | null>(null);
  useEffect(model.start, []);
  useDarkClass();
  useEffect(() => {
    const query = matchMedia("(min-width: 600px)"),
      change = (): void => setVertical(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const about = current?.groups.find((group) => group.id === "about"),
    quit = about?.choices.find((choice) => choice.id === "quit");
  return (
    <TooltipProvider delay={600}>
      <div className="titlebar window-drag" aria-hidden="true" />
      <main>
        <div className="sidebar-background darwin:wide:window-drag" aria-hidden="true" />
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
            orientation={vertical ? "vertical" : "horizontal"}
            className="settings-tabs h-full min-h-0 gap-0 wide:contents narrow:flex-col"
            onValueChange={(value) => {
              if (
                value === "library" ||
                value === "general" ||
                value === "recording" ||
                value === "failures"
              )
                model.activateTab(value);
            }}
          >
            <TabsList
              activateOnFocus
              aria-orientation={vertical ? "vertical" : "horizontal"}
              className="tabs flex-none items-stretch wide:col-start-1 wide:row-start-2 wide:w-full wide:flex-col wide:self-start narrow:w-full"
              variant={vertical ? "sidebar" : "line"}
              aria-label={current?.title ?? "RecordStuff"}
              onKeyDown={(event) => {
                const extra = vertical
                  ? ["ArrowLeft", "ArrowRight"]
                  : ["ArrowUp", "ArrowDown"];
                if (!extra.includes(event.key)) return;
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
                      (event.key === "ArrowUp" || event.key === "ArrowLeft"
                        ? -1
                        : 1) +
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
                  <ControlTooltip key={tab.id} label={!vertical || tab.id === "failures" ? tab.label : undefined}>
                    <TabsTrigger
                      id={`tab-${tab.id}`}
                      value={tab.id}
                      aria-label={tab.accessibleLabel ?? tab.label}
                      // A narrow window shows only the selected tab's name; the others name themselves on hover.
                      // Every tab stays in the window, even zoomed in at the smallest size: the icon-only tabs keep their
                      // width and the selected tab's name gives way, with its full name on hover (plan 067).
                      className="darwin:wide:window-no-drag min-h-[34px] wide:min-h-9 wide:gap-2.5 justify-start narrow:justify-center narrow:px-2 narrow:min-w-9 narrow:aria-selected:min-w-0 narrow:aria-selected:flex-auto"
                    >
                      <Icon className="tab-icon size-4" strokeWidth={2} />
                      {count ? (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <span className="tab-name min-w-0 overflow-hidden text-ellipsis">{count[1]}</span>
                          <>
                            <span className="sr-only">{count[2]}</span>
                            <Badge
                              className="tab-badge h-[18px] min-w-[18px] shrink-0 px-0.5 tabular-nums"
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
            <Status />
            <div className="settings-content">
              {/* The card's top stays put while the page under it scrolls: the page's name, the library's summary and
                  folder controls, and Troubleshooting's section tabs. */}
              <div ref={setHead} className="settings-head darwin:wide:window-drag">
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
          {about && quit && (
            <WindowActions
              group={about}
              quit={quit}
              id="sidebar-about-hide"
              sidebar
            />
          )}
          <p
            className="sidebar-error"
            hidden={
              !(
                model.failure?.group === "about" &&
                (model.failure.choice === "quit" || model.failure.choice === "hide")
              )
            }
          >
            {model.failure?.group === "about" && (model.failure.choice === "quit" || model.failure.choice === "hide")
              ? model.failure.text
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
      <ToastHost />
      <ZoomToast />
    </TooltipProvider>
  );
}
