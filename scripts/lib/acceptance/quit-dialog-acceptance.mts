/**
 * Pure verdicts for `pnpm acceptance:quit-dialog` (scripts/acceptance-quit-dialog.mts, plan 062).
 * The round keeps five layers apart: the signed fixture app, the lifecycle, the notification's
 * delivery event, the visual banner observation (never made by the runner) and cleanup. A
 * passing lifecycle cannot hide a failed delivery, and a delivery event is not visual proof.
 * Kept free of I/O so the judgement is unit-tested (quit-dialog-acceptance.test.ts).
 */
import type { INTERRUPT_EXIT } from "../runner/processes.mts";
import { roundExit, type RoundOutcome } from "../runner/round-exit.mts";

export type LayerStatus = "pass" | "fail" | "blocked" | "not run";
export interface Layer { status: LayerStatus; reason: string }

/** The fixture keeps the notice up for eight 1 s ticks; a show or failure must arrive inside that window. */
export const DELIVERY_WINDOW_MS = 8000;
/** A 1 s timer late by this much means something held main while the notice was up; unheld it is a few ms. */
export const MAX_LATE_MS = 500;
/** start-app.mjs --fixture-app phases, in order. */
export const SETUP_PHASES = ["preflight", "copy", "sign", "verify"] as const;

export interface NotificationEvent {
  time: string;
  event: "requested" | "shown" | "failed";
  /** `Notification.isSupported()` at the request. */
  supported?: boolean;
  error?: string;
}

/** One JSON object per line, appended by the fixture as each event happens; a torn last line is ignored. */
export function parseNotificationEvents(text: string): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<NotificationEvent>;
      if (typeof value.time === "string" && (value.event === "requested" || value.event === "shown" || value.event === "failed")) {
        events.push(value as NotificationEvent);
      }
    } catch { /* torn by a killed process */ }
  }
  return events;
}

/** `UNErrorDomain` error 1 is `UNErrorCodeNotificationsNotAllowed`: macOS refused this app's notifications. */
export function isAuthorizationDenial(error: string): boolean {
  return /UNErrorDomain(?: error |\s+code=)1\b|notifications? (?:are |is )?not allowed|not authori[sz]ed/i.test(error);
}

export interface DeliveryLayer extends Layer { error?: string; latencyMs?: number }

/**
 * Only a `shown` event inside the window passes. A failure outranks a show; an explicit
 * authorization denial is blocked (the round could not judge delivery), any other error fails.
 */
export function classifyDelivery(events: NotificationEvent[], windowMs = DELIVERY_WINDOW_MS): DeliveryLayer {
  const requests = events.filter(event => event.event === "requested");
  if (requests.length === 0) return { status: "fail", reason: "The fixture never requested the notification." };
  if (requests.length > 1) return { status: "fail", reason: `The notification was requested ${requests.length} times; one was expected.` };
  const requested = Date.parse(requests[0]!.time);
  const after = (event: NotificationEvent): number => Date.parse(event.time) - requested;
  const failed = events.find(event => event.event === "failed");
  if (failed) {
    const error = failed.error ?? "(no error text)";
    return isAuthorizationDenial(error)
      ? { status: "blocked", error, reason: `macOS denied this app notification authorization ${after(failed)} ms after the request; delivery could not be judged.` }
      : { status: "fail", error, reason: `The notification failed ${after(failed)} ms after the request with an error other than an authorization denial.` };
  }
  const shown = events.find(event => event.event === "shown");
  if (!shown) {
    return { status: "fail", reason: `Neither a show nor a failure event arrived within ${windowMs} ms of the request${requests[0]!.supported === false ? "; Notification.isSupported() was false" : ""}.` };
  }
  const latencyMs = after(shown);
  return latencyMs <= windowMs
    ? { status: "pass", latencyMs, reason: `Shown event ${latencyMs} ms after the request. This is delivery-event evidence, not proof of one visible, readable banner.` }
    : { status: "fail", latencyMs, reason: `Shown event ${latencyMs} ms after the request, beyond the ${windowMs} ms window.` };
}

export interface SupervisedRun {
  code: number | null;
  stopped?: string | undefined;
  error?: string | undefined;
}

/**
 * The signed-copy preparation. Exit 2 is a blocked identity prerequisite; a timeout while the
 * keychain is consulted (preflight or signing) is treated as a pending permission prompt.
 */
export function classifySetup(run: SupervisedRun, completedPhases: readonly string[], logLine: string): Layer {
  const reason = logLine.replace(/\.+$/, "");
  if (run.code === 0 && !run.stopped && !run.error) return { status: "pass", reason: "A private Electron.app copy was fully signed and verified before launch." };
  if (run.stopped === "timeout") {
    const pending = SETUP_PHASES.find(phase => !completedPhases.includes(phase));
    return pending === "preflight" || pending === "sign"
      ? { status: "blocked", reason: `Signing did not finish (${pending} timed out); macOS may be waiting for keychain permission. No fixture launched.` }
      : { status: "fail", reason: `The ${pending ?? "setup"} phase timed out. No fixture launched.` };
  }
  if (run.stopped) return { status: "fail", reason: `Setup ${run.stopped}. No fixture launched.` };
  if (run.code === 2) return { status: "blocked", reason: `Signing prerequisite unavailable: ${reason || "no reason given"}. No fixture launched.` };
  return { status: "fail", reason: `Signing or verification failed: ${reason || run.error || `exit ${run.code}`}. No fixture launched.` };
}

export interface FixtureResult { prompts?: number; deferred?: number; maxLateMs?: number }

export function classifyLifecycle(run: SupervisedRun, result: FixtureResult | undefined, maxLateMs = MAX_LATE_MS): Layer {
  if (run.stopped) return { status: "fail", reason: `The fixture was stopped: ${run.stopped}.` };
  if (run.error) return { status: "fail", reason: `The fixture could not be supervised: ${run.error}.` };
  if (run.code !== 0) return { status: "fail", reason: `The fixture exited with ${run.code}.` };
  if (!result) return { status: "fail", reason: "The fixture wrote no result." };
  if (result.prompts !== 1 || result.deferred !== 1) return { status: "fail", reason: `Expected one notice and one deferral, got ${result.prompts} and ${result.deferred}.` };
  if (typeof result.maxLateMs !== "number" || !(result.maxLateMs < maxLateMs)) {
    return { status: "fail", reason: `Timers while the notice was up were late by ${result.maxLateMs ?? "unknown"} ms (limit ${maxLateMs} ms).` };
  }
  return { status: "pass", reason: `One deferral and one notice; timers late by at most ${result.maxLateMs} ms (limit ${maxLateMs} ms); exact synthetic bytes saved; normal exit.` };
}

export interface CleanupFacts {
  setupGroupGone: boolean | undefined;
  /** Undefined when the fixture was never launched. */
  fixtureGroupGone: boolean | undefined;
  /** A group needed SIGKILL. An interrupt stops the disposable fixture that way, so the runner passes false for it. */
  forced: boolean;
  temporaryRemoved: boolean;
}

export function classifyCleanup(facts: CleanupFacts): Layer {
  const problems = [
    facts.setupGroupGone === false || facts.setupGroupGone === undefined ? "the setup process group was not confirmed gone" : "",
    facts.fixtureGroupGone === false ? "the fixture process group was not confirmed gone" : "",
    facts.forced ? "a process group needed forced cleanup" : "",
    facts.temporaryRemoved ? "" : "the signed temporary copy was retained",
  ].filter(Boolean);
  return problems.length ? { status: "fail", reason: `${problems.join("; ")}.` } : { status: "pass", reason: "Owned process groups exited and the signed temporary copy was removed." };
}

/** The deferred-quit message the fixture's media deferral shows (`DEFERRAL_MESSAGE.media` in src/main/app/quit-feedback.ts). */
export const DEFERRED_QUIT_MEDIA_MESSAGE = "Recording is still starting, saving or cleaning up, so RecordStuff stays open. A recording that has not started is cancelled. Try Quit or Relaunch again when it finishes.";

/** A banner as Notification Center's Accessibility tree shows it (scripts/lib/runner/native-ax.mts). */
export interface BannerSighting { id: string | undefined; title: string | undefined; body: string | undefined }

/**
 * Plan 063, step 6: the banner text read through Accessibility while the notice is up. Only
 * banners titled RecordStuff that were not already listed before the fixture launched count as
 * this round's. Exactly one must appear and its body must be the round's language text; the
 * other language's text is a language failure. Truncation and readability stay visual.
 */
export function classifyBannerText(input: {
  before: readonly BannerSighting[];
  polls: ReadonlyArray<readonly BannerSighting[]>;
  expected: string;
  otherLanguage: string;
  delivery: Layer;
  blocked?: string;
}): Layer & { bodies?: string[] } {
  if (input.blocked) return { status: "blocked", reason: input.blocked };
  if (input.delivery.status !== "pass") return { status: "not run", reason: "No shown notification to read." };
  // Identity is the banner's AXIdentifier; without it neither "new" nor "exactly one" can be told (review pass 2).
  const ours = (banner: BannerSighting): boolean => banner.title === "RecordStuff";
  if ([input.before, ...input.polls].some(list => list.some(banner => ours(banner) && !banner.id))) {
    return { status: "blocked", reason: "Notification Center listed a RecordStuff banner without an identifier, so this round's banners could not be told apart or counted." };
  }
  const known = new Set(input.before.map(banner => banner.id));
  const round = new Map<string, BannerSighting>();
  for (const poll of input.polls) for (const banner of poll) {
    if (ours(banner) && !known.has(banner.id)) round.set(banner.id!, banner);
  }
  const bodies = [...round.values()].map(banner => banner.body ?? "");
  if (bodies.length === 0) return { status: "fail", bodies, reason: `No RecordStuff banner from this round appeared in Notification Center's Accessibility tree in ${input.polls.length} reads.` };
  if (bodies.length > 1) return { status: "fail", bodies, reason: `${bodies.length} RecordStuff banners from this round appeared; one was expected.` };
  if (bodies[0] === input.expected) return { status: "pass", bodies, reason: "One banner from this round, its full body in the round's language as Accessibility reports it (not proof that it was visible or untruncated)." };
  if (bodies[0] === input.otherLanguage) return { status: "fail", bodies, reason: "The banner's body is in the other language." };
  return { status: "fail", bodies, reason: `The banner's body differs from the expected text: ${JSON.stringify(bodies[0])}.` };
}

export interface Layers { setup: Layer; lifecycle: Layer; delivery: Layer; bannerText: Layer; cleanup: Layer }

/**
 * The round's exit in the order the desktop runners share (round-exit.mts): a cleanup layer that failed fails it;
 * an interrupt that left nothing exits 130/143 and a lock seen during the round blocks it, even when a layer also
 * failed, since either may be why; then a failed layer fails it and one that could not run blocks it. Exit 0 is
 * automated evidence only: the visual layer stays pending for an observer.
 */
export function combineVerdict(layers: Layers, lockedAt: string | undefined, interrupted?: keyof typeof INTERRUPT_EXIT): { automated: RoundOutcome; exitCode: number } {
  const { cleanup, ...rest } = layers;
  const statuses = Object.values(rest).map(layer => layer.status);
  const { outcome, code } = roundExit({
    cleanupIncomplete: cleanup.status === "fail", interrupted, locked: lockedAt !== undefined,
    failed: statuses.includes("fail"), blocked: cleanup.status !== "pass" || statuses.some(status => status !== "pass"),
  });
  return { automated: outcome, exitCode: code };
}

export const VISUAL_PENDING: Layer = {
  status: "not run",
  reason: "Pending: this command cannot see the banner. An observer (the native acceptance skill or the maintainer) records whether it was visible and readable and whether its text was truncated; a shown event and the Accessibility text are not visual proof.",
};

export function renderReport(input: {
  language: string;
  layers: Layers;
  verdict: ReturnType<typeof combineVerdict>;
  desktop: string;
  provenance: string[];
  /** Evidence files present in the report directory. */
  files: string[];
}): string {
  const row = (name: string, layer: Layer): string => `| ${name} | ${layer.status.toUpperCase()} | ${layer.reason.replaceAll("|", "\\|")} |`;
  const { layers, verdict } = input;
  return [
    `# Deferred-quit notice (${input.language})`,
    "",
    `Automated evidence: **${verdict.automated.toUpperCase()}** (exit ${verdict.exitCode}): signed fixture app, lifecycle, notification delivery event, the banner's text read through Accessibility and cleanup. Visual banner observation: **pending**, not part of this result.`,
    "",
    "| Layer | Result | Reason |",
    "| --- | --- | --- |",
    row("Signed fixture app", layers.setup),
    row("Lifecycle and timers", layers.lifecycle),
    row("Notification delivery event", layers.delivery),
    row("Banner text (Accessibility)", layers.bannerText),
    row("Visual banner observation", VISUAL_PENDING),
    row("Cleanup", layers.cleanup),
    "",
    input.desktop,
    "",
    "## Provenance",
    "",
    ...input.provenance.map(line => `- ${line}`),
    "",
    "Source: isolated synthetic fixture using production feedback, launched from a per-round signed copy of this checkout's Electron.app; not the RecordStuff bundle or a capture test.",
    `Details: ${input.files.map(file => `[${file}](${file})`).join(", ")}.`,
    "",
  ].join("\n");
}
