/**
 * Settings interaction state. Main owns committed values; React owns the projection. One surface for the page,
 * kept by concern in controller/: the projection and its requests (core), the shortcut editor, the Failures rows,
 * the Recordings tab, the embedded player, the explanation popovers and the toast.
 */
export * from "./controller/core";
export * from "./controller/shortcut";
export * from "./controller/results";
export * from "./controller/library";
export * from "./controller/player";
export * from "./controller/info";
export * from "./controller/toast";
