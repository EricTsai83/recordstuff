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
    unit: [`${PAGE}settings-appearance.test.ts`, `${PAGE}settings-announce.test.ts`, "src/renderer/settings/controller/", "src/main/settings/settings-model.test.ts", "src/shared/i18n.test.ts"],
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
    name: "failures",
    covers: "the Failures tab and troubleshooting: history, acknowledgement, rows and their details",
    unit: [`${PAGE}settings-failures.test.ts`, "src/main/recording/recording-result"],
    ui: [{ file: "settings-results.spec.ts" }, { file: "settings-failure-affordance.spec.ts" }, { file: "components.spec.ts", tags: ["@failures"] }],
  },
  {
    name: "layout",
    covers: "Settings as a whole: shared components, themes, zoom, window chrome, focus drawing and the visual matrix of every tab",
    unit: ["src/renderer/components/", `${PAGE}settings-busy.test.ts`, `${PAGE}settings-quiet.test.ts`, `${PAGE}settings-info.test.ts`, "src/renderer/settings/zoom-toast.test.ts"],
    ui: [{ file: "settings-layout.spec.ts" }, { file: "settings-scroll-fades.spec.ts" }, { file: "settings-theme.spec.ts" }, { file: "settings-matrix.spec.ts" },
      { file: "components.spec.ts", tags: ["@layout"] }, { file: "settings-panel.spec.ts", tags: ["@layout"] }, { file: "settings-results.spec.ts", tags: ["@layout"] }],
  },
  {
    name: "player",
    covers: "the recordings player and its full-screen window",
    unit: ["src/renderer/player/", "src/renderer/video/", "src/main/library/video-fullscreen.test.ts", `${PAGE}settings-player-fullscreen.test.ts`, "src/preload/"],
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
    covers: "the recording shortcut: its editor, registration, refusals and entry",
    unit: [`${PAGE}settings-shortcut-`, `${PAGE}settings.test.ts`, `${PAGE}settings-close.test.ts`, "src/main/shortcuts/", "src/shared/hotkey.test.ts"],
    ui: [{ file: "shortcut-integration.spec.ts" }, { file: "settings-panel.spec.ts", tags: ["@shortcut"] }],
  },
  {
    name: "settings-bridge",
    covers: "the Settings window's preload, IPC, persistence, startup and window lifecycle",
    unit: ["src/preload/", "src/main/settings/", `${PAGE}settings-startup.test.ts`, `${PAGE}settings-ready.test.ts`],
    ui: [{ file: "settings-reset.spec.ts" }, { file: "settings-panel.spec.ts", tags: ["@settings-bridge"] }],
  },
  {
    name: "recording",
    covers: "recording logic below the UI: recorder, capture host and protocol, file writing, MP4 finishing. Unit tests only: capture needs the recording row of docs/testing.md",
    unit: ["src/main/recording/", "src/renderer/capture/", "src/shared/protocol.test.ts", "tests/capture-protocol.test.ts"],
    ui: [],
  },
  {
    name: "tooling",
    covers: "runners, analyzers and release tools under scripts/",
    unit: ["scripts/"],
    ui: [],
  },
];

/** What a set of scopes and test files selects, deduplicated. */
export interface Selection {
  scopes: string[];
  unit: string[];
  /** Per spec file: undefined tags for the whole file. */
  ui: UiSelection[];
  /** For `playwright test --grep`: each whole file, or a file's tagged cases. Undefined without UI. */
  grep?: string;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Scopes by name and test files by path (`*.test.ts` for Vitest, `tests/ui/*.spec.ts` for the background suite), merged:
 * a file selected whole by one scope stays whole, otherwise its tags add up. Throws on what names nothing.
 */
export function resolveSelection(args: readonly string[], scopes: readonly TestScope[] = TEST_SCOPES, exists: (file: string) => boolean = () => true): Selection {
  if (!args.length) throw new Error("Name at least one scope or test file (pnpm test:scope -- --list shows the scopes).");
  const unit = new Set<string>(), named: string[] = [];
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
  return { scopes: named, unit: [...unit].sort(), ui: uiList, ...(grep ? { grep } : {}) };
}
