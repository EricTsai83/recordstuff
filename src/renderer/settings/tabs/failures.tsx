/** Troubleshooting's failure history: rows grouped by day, with guidance, recovery actions and technical details. */
import { CameraOff, ChevronDown, CircleAlert, FolderX, HardDrive, MicOff, MonitorOff, PackageX, Settings2, ShieldAlert, TimerOff, VideoOff, VolumeX, type LucideIcon } from "lucide-react";
import type { RecordingResultView } from "../../../shared/settings-panel";
import { translate, type PlainMessageKey } from "../../../shared/i18n";
import type { ErrorCode } from "../../../shared/state";
import { REVIEWED_FAILURES_KEPT, persistsHistory } from "../../../shared/recording-result";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Empty, EmptyHeader, EmptyMedia, EmptyDescription } from "../../components/ui/empty";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../../components/ui/collapsible";
import * as model from "../settings-controller";

/** Cause and preservation are independent: a disk or display failure can still leave a partial file. */
const failureIcons: Record<ErrorCode, LucideIcon> = {
  permission_denied: ShieldAlert,
  unsupported_os_version: Settings2,
  no_display: MonitorOff,
  display_unavailable: MonitorOff,
  no_audio_track: VolumeX,
  microphone_unavailable: MicOff,
  camera_unavailable: CameraOff,
  media_components_missing: PackageX,
  capture_start_failed: VideoOff,
  capture_failed: VideoOff,
  capture_host_crashed: CircleAlert,
  capture_host_unresponsive: CircleAlert,
  output_open_failed: FolderX,
  output_write_failed: HardDrive,
  disk_full: HardDrive,
  stop_timeout: TimerOff,
  app_terminated: CircleAlert,
};
const outcomeLabels: Record<RecordingResultView["outcomeState"], PlainMessageKey> = {
  pending: "Processing",
  partial: "Partially kept",
  empty: "Not kept",
  unknown: "Unconfirmed result",
};

function FailureRow({ result }: { result: RecordingResultView }) {
  const id = model.resultDomId(result.id),
    state = model.resultStates.get(result.id),
    intent = model.resultIntents.get(result.id),
    busy = Boolean(intent || result.saving);
  const saving =
    result.saving ||
    (intent && persistsHistory(intent.action)
      ? model.text("Saving this change…")
      : "");
  const technical = [result.file, result.detail].filter(Boolean).join("\n");
  const Icon = failureIcons[result.code];
  return (
    <Collapsible
      id={id}
      className={`recording-result${result.acknowledged ? "" : " unread"}`}
      data-result-id={result.id}
      data-outcome={result.outcomeState}
      aria-busy={busy}
      open={state?.open ?? false}
      onOpenChange={(open) => model.toggleResult(result.id, open)}
    >
      <CollapsibleTrigger
        id={`${id}-summary`}
        className="result-summary outline-none focus-visible:border-ring/80 focus-visible:ring-[0.5px] focus-visible:ring-ring/80"
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const headers = [
              ...document.querySelectorAll<HTMLElement>(".result-summary"),
            ],
            at = headers.indexOf(event.currentTarget);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? headers.length - 1
                : Math.min(
                    headers.length - 1,
                    Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)),
                  );
          headers[next]?.focus();
          headers[next]?.scrollIntoView({ block: "nearest" });
        }}
      >
        <span className="result-mark" aria-hidden="true">
          <Icon />
          <span className="result-unread" hidden={result.acknowledged} />
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-[2px] pt-[1px]">
          <span className="flex items-start gap-[7px]">
            <span
              className="sr-only result-unread-label"
              hidden={result.acknowledged}
            >
              {model.text("Unread, ")}
            </span>
            <span className="result-heading">
              <span className="result-reason">{result.reason}</span>
              <Badge
                className={`result-badge h-auto min-h-[18px] max-w-full rounded-[3px] px-1 py-0 leading-4 whitespace-normal ${
                  result.outcomeState === "partial"
                    ? "bg-warning-surface text-warning"
                    : result.outcomeState === "pending" || result.outcomeState === "unknown"
                      ? "text-muted-foreground"
                      : ""
                }`}
                size="md"
                variant={result.outcomeState === "empty" ? "destructive" : "secondary"}
                data-outcome={result.outcomeState}
              >
                {model.text(outcomeLabels[result.outcomeState])}
              </Badge>
            </span>
            <span className="result-time flex-none text-muted-foreground text-[12px] tabular-nums">{result.time}</span>
            <ChevronDown className="result-chevron" aria-hidden="true" />
          </span>
          <span className="result-outcome block text-muted-foreground text-[12px]">{result.outcome}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="result-details" keepMounted>
        <p className="result-guidance">{result.guidance}</p>
        <p className="result-file" hidden={!result.fileName}>
          {result.fileName}
        </p>
        <p className="result-persistence" hidden={!result.persistenceWarning}>
          {result.persistenceWarning}
        </p>
        <div className="result-actions flex flex-wrap gap-[6px] my-[10px] mx-0">
          {result.actions.map((action) => (
            <Button
              key={action.id}
              id={`${id}-${action.id}`}
              data-action={action.id}
              variant="outline"
              disabled={!action.enabled}
              aria-disabled={!action.enabled || busy}
              onClick={() => {
                if (action.enabled && !busy)
                  void model.chooseResult(
                    result.id,
                    action.id,
                    `${id}-${action.id}`,
                  );
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
        <p className="result-saving" hidden={!saving}>
          {saving}
        </p>
        <p className="result-error" hidden={!model.resultErrors.has(result.id)}>
          {model.resultErrors.has(result.id)
            ? model.text("Could not complete this action. Try again.")
            : ""}
        </p>
        <Collapsible
          className="result-technical"
          hidden={!technical}
          onOpenChange={() => model.draw()}
        >
          <CollapsibleTrigger className="technical-summary outline-none focus-visible:border-ring/80 focus-visible:ring-[0.5px] focus-visible:ring-ring/80">
            {model.text("Technical details")}
            <ChevronDown className="technical-chevron" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <pre>{technical}</pre>
          </CollapsibleContent>
        </Collapsible>
      </CollapsibleContent>
    </Collapsible>
  );
}
export function Failures({ headingHidden = false }: { headingHidden?: boolean } = {}) {
  const results = model.view?.recordingResults ?? [],
    status = model.view?.recordingHistoryStatus,
    reset = model.view?.recordingHistoryReset;
  const days = [...new Set(results.map((result) => result.day))];
  return (
    <section id="recording-results" className="section" aria-labelledby="recording-results-heading">
      <h2 id="recording-results-heading" className={headingHidden ? "sr-only" : "section-heading"}>{model.text("Recording failures")}</h2>
      <p className="result-history-status" hidden={!status}>
        {status}
      </p>
      {reset && (
        <Button
          id="history-reset"
          className="history-reset"
          variant="outline"
          disabled={!reset.enabled}
          onClick={() => void model.choose("recordingHistory", "reset", "history-reset")}
        >
          {reset.label}
        </Button>
      )}
      <Empty className="result-empty py-10 text-muted-foreground" hidden={Boolean(results.length || status)}>
        <EmptyHeader>
          <EmptyMedia><CircleAlert className="size-[38px]" /></EmptyMedia>
          <EmptyDescription>{model.text("No recording failures.")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div className="result-days">
        {days.map((day) => (
          <section className="result-day" data-day={day} key={day}>
            <h3 className="day-heading result-day-heading">{day}</h3>
            <Card className="result-rows gap-0 overflow-visible rounded-none bg-transparent p-0 shadow-none ring-0 dark:bg-transparent">
              {results
                .filter((result) => result.day === day)
                .map((result) => (
                  <FailureRow key={result.id} result={result} />
                ))}
            </Card>
          </section>
        ))}
      </div>
      <p
        className="result-history-note section-footnote"
        hidden={!results.length}
      >
        {translate(
          "Keeps unreviewed failures and the {count} most recently reviewed. Removing a record does not delete its file.",
          model.view?.language,
          { count: REVIEWED_FAILURES_KEPT },
        )}
      </p>
      <Button
        id="history-more"
        className="history-more"
        variant="outline"
        hidden={!model.view?.recordingResultsRemaining}
        aria-disabled={model.historyPending || undefined}
        onClick={() => void model.historyMore()}
      >
        {model.text("Show more failures")}
      </Button>
    </section>
  );
}
