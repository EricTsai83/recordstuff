/**
 * Development switches of plan 100 step 4's gate (`pnpm matrix -- pace --prepare <file> --pace governed`), read only by
 * an app that is not packaged. Kept apart from governor.ts so the runner imports them without the app's code.
 */
/** Forces the pace of versions prepared alongside a recording: `governed` (by its health) or `pause`. */
export const VERSION_PACE_ENV = "RECORDSTUFF_VERSION_PACE";
/** An editable recording whose Video is prepared afresh at launch, so it runs alongside the recording that follows. */
export const PREPARE_AT_LAUNCH_ENV = "RECORDSTUFF_PREPARE_AT_LAUNCH";
