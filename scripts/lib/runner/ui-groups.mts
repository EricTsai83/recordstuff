/**
 * The background suite split by kind of test for CI (check.yml's `ui` matrix, one job per group and platform), so a
 * failing job names what broke. Every background spec belongs to exactly one group (ui-groups.test.ts): a new spec
 * must be added to one. Test time on macos-15 (2026-10-22): layout about 200 s, states 215 s, settings 155 s and
 * app 165 s; four groups keep macOS within the five runners a free account runs at once, beside `check`.
 */
export const UI_GROUPS = {
  /** Settings as a whole: readability, reach, the sidebar, shared components, scrolling and themes. */
  layout: ["settings-layout.spec.ts", "settings-sidebar.spec.ts", "components.spec.ts", "settings-scroll-fades.spec.ts", "settings-theme.spec.ts"],
  /** Every tab's states in both languages, themes and sizes, and recording failures with their disclosure. */
  states: ["settings-matrix.spec.ts", "settings-results.spec.ts", "settings-failure-affordance.spec.ts"],
  /** Settings changed through the page and kept by the app: the panel's cases, preferences, reset and notification help. */
  settings: ["settings-panel.spec.ts", "settings-segments.spec.ts", "settings-reset.spec.ts", "settings-notification-help.spec.ts"],
  /** The app beyond Settings: the player, the shortcut, the library, the undo toast, window actions and the countdown. */
  app: ["player.spec.ts", "shortcut-integration.spec.ts", "settings-library-performance.spec.ts", "toast.spec.ts", "window-actions.spec.ts", "countdown.spec.ts"],
} as const satisfies Record<string, readonly string[]>;

export type UiGroup = keyof typeof UI_GROUPS;

export function isUiGroup(name: string): name is UiGroup {
  return Object.hasOwn(UI_GROUPS, name);
}
