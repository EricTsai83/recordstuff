/** The settings window's shell: the tabs, the status card, the page each tab draws, the footer and the overlays. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Film, CircleAlert, Settings2, Settings } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { TooltipProvider } from "../components/ui/tooltip";
import { ZoomToast } from "./zoom-toast";
import * as model from "./settings-controller";
import { Action, Preferences } from "./tabs/preferences";
import { Failures } from "./tabs/failures";
import { Library, RenameDialog, PlayerDialog } from "./tabs/library";
import { ToastHost } from "./undo-toast";

const tabIcons = {
  library: Film,
  recording: Settings2,
  general: Settings,
  failures: CircleAlert,
};
function Status() {
  const current = model.view,
    status = current?.status,
    failure = model.failure?.group === "status" ? model.failure.text : "";
  return (
    <Card
      id="status"
      className="status"
      hidden={!status || status.tone === "ready"}
      data-tone={status?.tone}
    >
      <span className="status-mark" aria-hidden="true" />
      <div className="status-text">
        <p id="status-title" className="status-title">
          {status?.title}
        </p>
        <p
          id="status-detail"
          className="status-detail"
          hidden={!status?.detail || Boolean(current?.hint)}
        >
          {status?.detail}
        </p>
        <p id="hint" hidden={!current?.hint}>
          {current?.hint}
        </p>
        <p id="status-error" className="status-error" hidden={!failure}>
          {failure}
        </p>
        <Button
          id="status-secondary"
          variant="link"
          hidden={!status?.secondaryAction}
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
          {status?.secondaryAction?.label}
        </Button>
      </div>
      <Button
        id="status-action"
        hidden={!status?.action}
        data-action={status?.action?.id}
        aria-disabled={Boolean(model.saving)}
        onClick={() => {
          if (!model.saving && status?.action)
            void model.choose("status", status.action.id, "status-action");
        }}
      >
        {status?.action?.label}
      </Button>
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
    [overflow, setOverflow] = useState(false);
  useEffect(model.start, []);
  useLayoutEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)"),
      apply = (): void => {
        document.documentElement.classList.toggle("dark", query.matches);
      };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    const query = matchMedia("(min-width: 600px)"),
      change = (): void => setVertical(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const update = (): void =>
      setOverflow(node.scrollHeight - node.clientHeight - node.scrollTop > 2);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    node.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
    };
  }, [revision]);
  const about = current?.groups.find((group) => group.id === "about"),
    quit = about?.choices.find((choice) => choice.id === "quit");
  return (
    <TooltipProvider>
      <div className="titlebar" aria-hidden="true" />
      <main>
        <h1 id="title" className="sr-only visually-hidden">
          {current?.title ?? "RecordStuff"}
        </h1>
        <div className="brand" aria-hidden="true">
          <span className="brand-mark" />
          <span className="brand-name">RecordStuff</span>
        </div>
        <form id="settings" onSubmit={(event) => event.preventDefault()}>
          <Tabs
            value={model.selectedTab}
            orientation={vertical ? "vertical" : "horizontal"}
            className="settings-tabs"
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
              className="tabs"
              variant="line"
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
                  <TabsTrigger
                    key={tab.id}
                    id={`tab-${tab.id}`}
                    value={tab.id}
                    aria-label={tab.accessibleLabel ?? tab.label}
                  >
                    <Icon className="tab-icon" />
                    <span className="tab-name">
                      {count ? count[1] : tab.label}
                    </span>
                    {count && (
                      <>
                        <span className="sr-only">{count[2]}</span>
                        <Badge className="tab-badge" variant="secondary">
                          {count[3]}
                        </Badge>
                        <span className="sr-only">{count[4]}</span>
                      </>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <Status />
            <div className="settings-viewport">
              <TabsContent
                ref={panel}
                id="settings-panel"
                tabIndex={-1}
                value={model.selectedTab}
                className="settings-panel"
              >
                <p id="page-title" className="page-title" aria-hidden="true">
                  {current?.tabs
                    .find((tab) => tab.id === model.selectedTab)
                    ?.label.replace(/\s?[（(]\d+[)）]$/, "")}
                </p>
                <div hidden={model.selectedTab !== "library"}>
                  <Library />
                </div>
                {model.selectedTab === "failures" ? (
                  <Failures />
                ) : model.selectedTab !== "library" ? (
                  <Preferences />
                ) : null}
              </TabsContent>
              <div
                id="scroll-hint"
                className="scroll-hint"
                aria-hidden="true"
                hidden={!overflow}
              />
            </div>
          </Tabs>
        </form>
        <footer id="sidebar-about" className="sidebar-about" hidden={!quit}>
          {about && quit && (
            <Action group={about} choice={quit} id="sidebar-about-quit" />
          )}
          <p
            className="sidebar-error"
            hidden={
              !(
                model.failure?.group === "about" &&
                model.failure.choice === "quit"
              )
            }
          >
            {model.failure?.group === "about" && model.failure.choice === "quit"
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
