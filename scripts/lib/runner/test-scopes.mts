/**
 * The scope catalog behind `pnpm test:scope` (plan 070, docs/testing.md#select-tests-from-behavior): named behaviors and
 * the unit files and background UI cases that answer for each, so a local edit runs the checks for what it touched
 * and not the rest. Selection is by file and by Playwright tag (`{ tag: "@general" }` on a case), never by a title's
 * wording. The catalog is a selection aid, not proof of impact: the person choosing reads the diff and names every
 * scope it reaches, and a shared change takes the union of its consumers.
 */

/** A background spec (relative to tests/ui), whole or only its cases with one of `tags`. */
export interface UiSelection {
  file: string;
  tags?: readonly string[];
}

export interface TestScope {
  name: string;
  /** The behavior it answers for, as `--list` shows it. */
  covers: string;
  /** Vitest filters: repository paths of test files or of folders and name prefixes that hold them. */
  unit: readonly string[];
  ui: readonly UiSelection[];
  /**
   * The native engine's Rust tests (native/capture), as `cargo test --lib` filters: module paths ending in `::`, which
   * libtest matches as substrings of each test's path. Selecting any adds Clippy and rustfmt's check.
   */
  native?: readonly string[];
}

const PAGE = "src/renderer/settings/page-tests/";

export const TEST_SCOPES: readonly TestScope[] = [
  {
    name: "recording-settings",
    covers: "the Recording tab: screen, quality, countdown and its sound, file name, the status card",
    unit: [`${PAGE}settings-arrangement.test.ts`, `${PAGE}settings-file-name.test.ts`, `${PAGE}settings-status.test.ts`, `${PAGE}settings-lock-focus.test.ts`,
      "src/renderer/settings/tabs/", "src/main/settings/settings-model.test.ts", "src/shared/quality.test.ts", "src/shared/file-name.test.ts", "src/shared/display.test.ts"],
    ui: [{ file: "settings-segments.spec.ts" }, { file: "settings-panel.spec.ts", tags: ["@recording-settings"] },
      { file: "settings-layout.spec.ts", tags: ["@recording-settings"] }, { file: "settings-matrix.spec.ts", tags: ["@recording-settings"] }],
  },
  {
    name: "general",
    covers: "the General tab: language, appearance, notifications, updates, local data cleanup, the footer, Hide interface and Quit",
    unit: [`${PAGE}settings-appearance.test.ts`, `${PAGE}settings-announce.test.ts`, "src/renderer/settings/controller/", "src/main/settings/settings-model.test.ts", "src/shared/i18n.test.ts", "tests/i18n-usage.test.ts",
      "src/main/app/updates.test.ts", "src/main/app/data-cleanup"],
    ui: [{ file: "settings-notification-help.spec.ts" }, { file: "settings-segments.spec.ts" }, { file: "window-actions.spec.ts" },
      { file: "settings-panel.spec.ts", tags: ["@general"] }, { file: "components.spec.ts", tags: ["@general"] },
      { file: "settings-layout.spec.ts", tags: ["@general"] }, { file: "settings-matrix.spec.ts", tags: ["@general"] }],
  },
  {
    name: "library",
    covers: "the Recordings tab: listing, categories, search, cards, previews, menus, rename, move, trash and undo",
    unit: [`${PAGE}settings-library`, `${PAGE}settings-toast.test.ts`, "src/main/library/"],
    ui: [{ file: "settings-library-performance.spec.ts" }, { file: "toast.spec.ts" }, { file: "settings-panel.spec.ts", tags: ["@library"] },
      { file: "components.spec.ts", tags: ["@library"] }, { file: "settings-layout.spec.ts", tags: ["@library"] },
      { file: "player.spec.ts", tags: ["@library"] }, { file: "settings-matrix.spec.ts", tags: ["@library"] }],
  },
  {
    name: "editing",
    covers: "cutting a recording (plan 085) and an editable recording's camera and volumes (plan 087): the edit view and its timeline, the edit records, the export worker and its supervision, publication and admission; the engine's reader, cut plan, remux and rendered export, and the editable recording's description",
    unit: [`${PAGE}settings-editor`, "src/renderer/settings/tabs/library/editor-geometry.test.ts", "src/main/editing/", "src/shared/editing.test.ts", "src/shared/editable.test.ts", "src/renderer/settings/controller/editor.test.ts"],
    ui: [{ file: "editor.spec.ts" }],
    native: ["edit::", "editable::"],
  },
  {
    name: "failures",
    covers: "the Failures tab and troubleshooting: history, acknowledgement, rows and their details",
    unit: [`${PAGE}settings-failures.test.ts`, "src/main/recording/recording-result"],
    ui: [{ file: "settings-results.spec.ts" }, { file: "settings-failure-affordance.spec.ts" }, { file: "components.spec.ts", tags: ["@failures"] }],
  },
  {
    name: "layout",
    covers: "Settings as a whole: shared components, themes, zoom, window chrome, focus drawing, every page's root and the visual matrix of every tab",
    unit: ["src/renderer/components/", "src/renderer/lib/mount-root.test.ts", `${PAGE}settings-busy.test.ts`, `${PAGE}settings-quiet.test.ts`, `${PAGE}settings-info.test.ts`, `${PAGE}settings-modal-drag-handle.test.ts`, "src/renderer/settings/zoom-toast.test.ts"],
    ui: [{ file: "settings-layout.spec.ts" }, { file: "settings-sidebar.spec.ts" }, { file: "settings-scroll-fades.spec.ts" }, { file: "settings-theme.spec.ts" }, { file: "settings-matrix.spec.ts" },
      { file: "components.spec.ts", tags: ["@layout"] }, { file: "settings-panel.spec.ts", tags: ["@layout"] }, { file: "settings-results.spec.ts", tags: ["@layout"] }],
  },
  {
    name: "player",
    covers: "the recordings player and its full-screen window",
    unit: ["src/renderer/player/", "src/renderer/video/", "src/shared/video-player.test.ts", "src/main/library/video-fullscreen.test.ts", `${PAGE}settings-player-fullscreen.test.ts`, "src/preload/"],
    ui: [{ file: "player.spec.ts" }, { file: "components.spec.ts", tags: ["@player"] }],
  },
  {
    name: "countdown",
    covers: "the countdown overlay and its tick preference",
    unit: ["src/renderer/countdown/", "src/main/recording/countdown-overlay.test.ts"],
    ui: [{ file: "countdown.spec.ts" }],
  },
  {
    name: "shortcut",
    covers: "the recording shortcut: its editor, registration, refusals and entry, and the Keyboard Shortcuts tab with its catalog",
    unit: [`${PAGE}settings-shortcut-`, `${PAGE}settings.test.ts`, `${PAGE}settings-close.test.ts`, `${PAGE}settings-tab-memory.test.ts`, "src/main/shortcuts/", "src/shared/hotkey.test.ts",
      "src/shared/shortcut-catalog.test.ts", "src/main/menus/app-menu.test.ts"],
    ui: [{ file: "shortcut-integration.spec.ts" }, { file: "settings-panel.spec.ts", tags: ["@shortcut"] }],
  },
  {
    name: "settings-bridge",
    covers: "the Settings window's preload, IPC, persistence, startup and window lifecycle",
    unit: ["src/preload/", "src/main/settings/", `${PAGE}settings-startup.test.ts`, `${PAGE}settings-ready.test.ts`],
    ui: [{ file: "settings-reset.spec.ts" }, { file: "settings-panel.spec.ts", tags: ["@settings-bridge"] }],
  },
  {
    name: "studio",
    covers: "the Studio: the camera bubble's layout and the input volumes' bounds (each checked on both sides against a file shared with the native engine), the Studio port and the preview stream",
    unit: ["src/renderer/settings/tabs/studio-", "src/renderer/settings/tabs/frame-clock.test.ts", "src/shared/camera-layout.test.ts", "src/shared/audio-volume.test.ts", "src/shared/studio-port.test.ts", "src/renderer/lib/preview-stream.test.ts", "src/renderer/lib/preview-decoder.test.ts", "src/renderer/lib/use-pending-value.test.ts"],
    ui: [{ file: "settings-panel.spec.ts", tags: ["@studio"] }],
    native: ["camera_layout::", "preview_gate_tests::", "gain_bounds_tests::"],
  },
  {
    name: "pipeline-diagnostics",
    covers: "the media pipeline's figures (plan 083): the engine's stage histograms and the writer's queue, the capture host's diagnostics lines, the Studio page's preview figures and the report that reads them",
    unit: ["src/shared/pipeline-histogram.test.ts", "scripts/lib/verification/pipeline-report.test.ts", "src/main/recording/native-host-process.test.ts", "src/shared/studio-port.test.ts", "src/renderer/settings/tabs/studio-feed.test.ts"],
    ui: [],
    native: ["core::", "writer::", "preview_gate_tests::"],
  },
  {
    name: "tray",
    covers: "the menu bar icon: its menu and model, the actions it and the shortcuts run, and the interface state behind them",
    unit: ["src/main/menus/tray", "src/main/actions/", "src/main/app/ui-model.test.ts"],
    ui: [],
  },
  {
    name: "app-lifecycle",
    covers: "quit, relaunch and session end, deferred-quit feedback, the fault dialog and reopening. Unit tests only: the lifecycle row of docs/testing.md adds pnpm acceptance:lifecycle",
    unit: ["src/main/app/quit-", "src/main/app/session-end.test.ts", "src/main/app/fault-dialog.test.ts", "src/main/app/reopen.test.ts"],
    ui: [],
  },
  {
    name: "platform",
    covers: "the OS boundaries below recording: screen and microphone permissions and their notices, displays and their capture sources, the input and camera device lists",
    unit: ["src/main/permission/", "src/main/display/", "src/main/app/device-lists.test.ts"],
    ui: [],
  },
  {
    name: "main-lib",
    covers: "the main process's shared helpers: the log file, atomic writes, error text and the drain queue. A change here also takes its consumers' scopes",
    unit: ["src/main/lib/"],
    ui: [],
  },
  {
    name: "recording",
    covers: "recording logic below the UI: recorder, the native engine's host and protocol, file publication. Unit tests only: capture needs the recording row of docs/testing.md",
    unit: ["src/main/recording/", "src/shared/protocol.test.ts"],
    ui: [],
  },
  {
    name: "engine-file",
    covers: "the native engine's file: the MP4 muxer, the writer and the AVC and AAC bitstreams. Rust only: a change to what a recording writes also takes the recording row of docs/testing.md",
    unit: [],
    ui: [],
    native: ["mux::", "writer::", "avc::", "aac::"],
  },
  {
    name: "engine-core",
    covers: "the native engine's session: frame pacing and timing, the mixer and meters, the camera, the encoder thread and its choice, NV12. Rust only",
    unit: [],
    ui: [],
    native: ["core::", "pacing::", "timing::", "async_encoder::", "encoder_choice::", "nv12::"],
  },
  {
    name: "engine-platform",
    covers: "the native engine's macOS and Windows capture and encoding; each platform runs its own. Rust only",
    unit: [],
    ui: [],
    native: ["mac::", "win::"],
  },
  {
    name: "tooling",
    covers: "everything under scripts/ and the background suite's process helpers; the four tooling-* scopes split it by folder",
    unit: ["scripts/", "tests/ui/process-"],
    ui: [],
  },
  {
    name: "tooling-runner",
    covers: "the runners' shared machinery: process groups and cleanup, desktop sessions, recipes and timing, test scopes, the app launcher and interrupts",
    unit: ["scripts/lib/runner/", "scripts/start-app.test.ts", "scripts/runner-interrupt.test.ts", "tests/ui/process-"],
    ui: [],
  },
  {
    name: "tooling-acceptance",
    covers: "the acceptance rounds' own logic and judgements, and their controlled fixtures",
    unit: ["scripts/lib/acceptance/", "scripts/fixtures/"],
    ui: [],
  },
  {
    name: "tooling-analysis",
    covers: "the analyzers: media verification, audio quality, CPU sampling, the matrix, frame logs and finalization timing",
    unit: ["scripts/lib/verification/", "scripts/lib/audio/"],
    ui: [],
  },
  {
    name: "tooling-release",
    covers: "release, packaging and signing tools: the release script and its record, after-pack, the signing identity, icons, the built engine's load check",
    unit: ["scripts/lib/release/", "scripts/release", "scripts/after-pack.test.ts", "scripts/create-signing-identity.test.ts", "scripts/make-icons.test.ts", "scripts/native-load.test.ts"],
    ui: [],
  },
];

/**
 * Tests that read sources instead of importing them, so no import graph or scope can tell which edit reaches them:
 * every selection runs them, as `pnpm test:changed` does. Both take about a second.
 */
export const ALWAYS_UNIT: readonly string[] = ["tests/source-boundaries.test.ts", "tests/style-guard.test.ts"];

/** What a set of scopes and test files selects, deduplicated. */
export interface Selection {
  scopes: string[];
  unit: string[];
  /** Per spec file: undefined tags for the whole file. */
  ui: UiSelection[];
  /** For `playwright test --grep`: each whole file, or a file's tagged cases. Undefined without UI. */
  grep?: string;
  /** `cargo test --lib` filters for the native engine. Undefined without any. */
  native?: string[];
}

/** The session core's tests, which run on the real clock: one at a time, as `pnpm test:native` runs them. */
export const SERIAL_NATIVE_TESTS = "core::tests";

/**
 * The `cargo test --lib` runs for a selection's native filters, as the arguments after `--`: one parallel run, and
 * when a filter takes in the session core's tests, those apart in a run of their own one at a time, so the other
 * modules' tests are not serialized with them.
 */
export function nativeTestRuns(filters: readonly string[]): Array<{ serial: boolean; args: string[] }> {
  if (!filters.some((filter) => SERIAL_NATIVE_TESTS.startsWith(filter))) return [{ serial: false, args: [...filters] }];
  return [
    { serial: false, args: [...filters, "--skip", SERIAL_NATIVE_TESTS] },
    { serial: true, args: ["--test-threads=1", SERIAL_NATIVE_TESTS] },
  ];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Scopes by name and test files by path (`*.test.ts` for Vitest, `tests/ui/*.spec.ts` for the background suite), merged:
 * a file selected whole by one scope stays whole, otherwise its tags add up, and the unit files always include
 * {@link ALWAYS_UNIT}. Throws on what names nothing.
 */
export function resolveSelection(args: readonly string[], scopes: readonly TestScope[] = TEST_SCOPES, exists: (file: string) => boolean = () => true): Selection {
  if (!args.length) throw new Error("Name at least one scope or test file (pnpm test:scope -- --list shows the scopes).");
  const unit = new Set<string>(), native = new Set<string>(), named: string[] = [];
  const ui = new Map<string, Set<string> | undefined>();
  const addUi = (selection: UiSelection): void => {
    if (ui.has(selection.file) && ui.get(selection.file) === undefined) return;
    if (!selection.tags?.length) { ui.set(selection.file, undefined); return; }
    const tags = ui.get(selection.file) ?? new Set<string>();
    for (const tag of selection.tags) tags.add(tag);
    ui.set(selection.file, tags);
  };
  for (const arg of args) {
    const scope = scopes.find(candidate => candidate.name === arg);
    if (scope) {
      named.push(scope.name);
      for (const filter of scope.unit) unit.add(filter);
      for (const selection of scope.ui) addUi(selection);
      for (const filter of scope.native ?? []) native.add(filter);
      continue;
    }
    const spec = /^(?:\.\/)?tests\/ui\/([^/]+\.spec\.ts)$/.exec(arg);
    if (spec) {
      if (!exists(arg)) throw new Error(`${arg} does not exist.`);
      addUi({ file: spec[1]! });
    } else if (/\.test\.m?ts$/.test(arg)) {
      if (!exists(arg)) throw new Error(`${arg} does not exist.`);
      unit.add(arg.replace(/^\.\//, ""));
    } else throw new Error(`Unknown scope or test file ${JSON.stringify(arg)}; known scopes: ${scopes.map(candidate => candidate.name).join(", ")}.`);
  }
  const uiList = [...ui].map(([file, tags]) => (tags ? { file, tags: [...tags].sort() } : { file })).sort((a, b) => a.file.localeCompare(b.file));
  // Playwright matches --grep against the file, the title and then the tags, joined by spaces.
  const grep = uiList.length
    ? uiList.map(({ file, tags }) => tags ? `${escape(file)}.*(?:${tags.map(escape).join("|")})(?:\\s|$)` : escape(file)).join("|")
    : undefined;
  for (const file of ALWAYS_UNIT) unit.add(file);
  return { scopes: named, unit: [...unit].sort(), ui: uiList, ...(grep ? { grep } : {}), ...(native.size ? { native: [...native].sort() } : {}) };
}
