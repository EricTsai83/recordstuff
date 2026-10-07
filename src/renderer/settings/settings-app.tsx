/** The settings window's shell: the tabs, the status card, the page each tab draws, the footer and the overlays. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, Film, Wrench, Video, Settings } from "lucide-react";
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
import { Library, RenameDialog, PlayerDialog } from "./tabs/library";
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
      className={permission ? "status gap-3 rounded-[18px] p-3.5 ring-(--permission-card-ring)" : "status gap-2.5 p-3"}
      hidden={!status || status.tone === "ready"}
      data-tone={status?.tone}
      data-permission={permission || undefined}
    >
      <span className="status-mark" aria-hidden="true" hidden={permission} />
      {permission && (
        <span className="permission-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none">
            <rect x="2" y="2" width="44" height="44" rx="12" fill="var(--brand)" />
            <rect x="2.5" y="2.5" width="43" height="43" rx="11.5" stroke="var(--brand-foreground)" strokeOpacity="0.12" />
            <rect x="10" y="11" width="28" height="21" rx="4.5" stroke="var(--brand-foreground)" strokeWidth="2" />
            <path d="M24 32v5m-6 0h12" stroke="var(--brand-foreground)" strokeWidth="2" strokeLinecap="round" />
            <circle cx="24" cy="21.5" r="5.2" stroke="var(--brand-foreground)" strokeWidth="1.5" />
            <circle cx="24" cy="21.5" r="2.7" fill="var(--indicator)" />
            <g fill="var(--brand)" strokeLinejoin="round">
              <path d="m39 27.5 6.5 2.5v5.5c0 4-2.5 6.8-6.5 8.5-4-1.7-6.5-4.5-6.5-8.5V30l6.5-2.5Z" stroke="var(--brand)" strokeWidth="5" />
              <path d="m39 27.5 6.5 2.5v5.5c0 4-2.5 6.8-6.5 8.5-4-1.7-6.5-4.5-6.5-8.5V30l6.5-2.5Z" stroke="var(--brand-foreground)" strokeWidth="1.8" />
            </g>
            <rect x="35.5" y="33.8" width="7" height="6.2" rx="1.3" fill="var(--brand-foreground)" />
            <path d="M37.2 34v-1.3a1.8 1.8 0 0 1 3.6 0V34" stroke="var(--brand-foreground)" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="39" cy="36.5" r="0.8" fill="var(--brand)" />
            <path d="M39 37v1" stroke="var(--brand)" strokeWidth="1" strokeLinecap="round" />
          </svg>
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
          variant={permission ? "outline" : "default"}
          wrap={permission}
          className={permission
            ? `darwin:wide:window-no-drag w-full min-h-11 rounded-xl border-(--permission-action-border) bg-(--permission-action-bg) py-2 text-center font-semibold text-(--permission-action-ink) hover:bg-(--permission-action-hover) hover:text-(--permission-action-ink) dark:bg-(--permission-action-bg) ${status?.action?.id === "permission" ? "justify-start gap-2 px-2.5" : ""}`
            : "darwin:wide:window-no-drag wide:w-full"}
          hidden={!status?.action}
          data-action={status?.action?.id}
          aria-disabled={Boolean(model.saving)}
          onClick={() => {
            if (!model.saving && status?.action)
              void model.choose("status", status.action.id, "status-action");
          }}
        >
          {permission && status?.action?.id === "permission" && <Settings className="size-[18px] text-(--permission-icon-ink)" aria-hidden="true" />}
          {permission ? (
            <span id="status-action-label" className={status?.action?.id === "permission" ? "min-w-0 flex-1 text-left" : undefined}>
              {status?.action?.label}
            </span>
          ) : status?.action?.label}
          {permission && status?.action?.id === "permission" && <ArrowUpRight className="size-3.5" aria-hidden="true" />}
        </Button>
        <Button
          id="status-secondary"
          variant="link"
          wrap={permission}
          className={permission
            ? "darwin:wide:window-no-drag w-full min-h-7 rounded-lg px-0 py-1 text-center font-normal text-muted-foreground hover:text-muted-foreground hover:no-underline underline-offset-3"
            : "darwin:wide:window-no-drag h-auto min-h-6 max-w-full justify-start px-0 text-left font-normal whitespace-normal underline underline-offset-3 text-muted-foreground hover:text-primary"}
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
              <span id="status-secondary-hint" hidden={!hasAllowedHint}>{allowedHint}</span>
              {hasAllowedHint && " "}
              <span id="status-secondary-label" className="font-bold text-(--permission-link-ink) decoration-current group-hover/button:underline underline-offset-3">
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
    panel = useRef<HTMLDivElement>(null);
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
                      className="darwin:wide:window-no-drag min-h-[34px] wide:min-h-[42px] wide:text-[15px] wide:gap-2 justify-start narrow:justify-center narrow:px-2 narrow:min-w-9 narrow:aria-selected:min-w-0 narrow:aria-selected:flex-auto"
                    >
                      <Icon className="tab-icon size-[18px]" strokeWidth={vertical ? 2.5 : 2} />
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
              <div className="settings-viewport">
                <TabsContent
                  ref={panel}
                  id="settings-panel"
                  tabIndex={-1}
                  value={model.selectedTab}
                  className="settings-panel"
                >
                  <div className="settings-card">
                    <p id="page-title" className="page-title" aria-hidden="true">
                      {current?.tabs
                        .find((tab) => tab.id === model.selectedTab)
                        ?.label.replace(/\s?[（(]\d+[)）]$/, "")}
                    </p>
                    <div hidden={model.selectedTab !== "library"}>
                      <Library />
                    </div>
                    {model.selectedTab === "failures" ? (
                      <Troubleshooting />
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
      <PlayerDialog />
      <ToastHost />
      <ZoomToast />
    </TooltipProvider>
  );
}
