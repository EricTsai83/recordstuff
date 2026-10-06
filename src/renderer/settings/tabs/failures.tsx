/** The Failures tab: rows grouped by day, each with its guidance, recovery actions and technical details. */
import { CircleAlert, ChevronDown, FileWarning } from "lucide-react";
import type { RecordingResultView } from "../../../shared/settings-panel";
import { translate } from "../../../shared/i18n";
import { REVIEWED_FAILURES_KEPT, persistsHistory } from "../../../shared/recording-result";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../../components/ui/collapsible";
import * as model from "../settings-controller";

export function FailureRow({ result }: { result: RecordingResultView }) {
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
  return (
    <Collapsible
      id={id}
      className={`recording-result${result.acknowledged ? "" : " unread"}`}
      data-result-id={result.id}
      aria-busy={busy}
      open={state?.open ?? false}
      onOpenChange={(open) => model.toggleResult(result.id, open)}
    >
      <CollapsibleTrigger
        id={`${id}-summary`}
        className="result-summary"
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
        {/* What became of the recording at a glance: amber when part of it was kept, red when nothing was. */}
        <span
          className="result-mark"
          data-kept={result.fileName ? "" : undefined}
          aria-hidden="true"
        >
          {result.fileName ? <FileWarning /> : <CircleAlert />}
          <span className="result-unread" hidden={result.acknowledged} />
        </span>
        <span className="result-text">
          <span className="result-line">
            <span
              className="sr-only result-unread-label"
              hidden={result.acknowledged}
            >
              {model.text("Unread, ")}
            </span>
            <span className="result-reason">{result.reason}</span>
            <span className="result-time">{result.time}</span>
            <ChevronDown className="result-chevron" aria-hidden="true" />
          </span>
          <span className="result-outcome">{result.outcome}</span>
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
        <div className="result-actions">
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
          <CollapsibleTrigger className="technical-summary">
            {model.text("Technical details")}
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <pre>{technical}</pre>
          </CollapsibleContent>
        </Collapsible>
      </CollapsibleContent>
    </Collapsible>
  );
}
export function Failures() {
  const results = model.view?.recordingResults ?? [],
    status = model.view?.recordingHistoryStatus;
  const days = [...new Set(results.map((result) => result.day))];
  return (
    <section id="recording-results" aria-labelledby="tab-failures">
      <p className="result-history-status" hidden={!status}>
        {status}
      </p>
      <p className="result-empty" hidden={Boolean(results.length || status)}>
        <CircleAlert className="empty-icon" />
        <span>{model.text("No recording failures.")}</span>
      </p>
      <div className="result-days">
        {days.map((day) => (
          <section className="result-day" data-day={day} key={day}>
            <h2 className="day-heading result-day-heading">{day}</h2>
            <div className="result-rows">
              {results
                .filter((result) => result.day === day)
                .map((result) => (
                  <FailureRow key={result.id} result={result} />
                ))}
            </div>
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
