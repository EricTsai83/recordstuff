/**
 * The target of cleanup drills D03 and D07 (drills.spec.ts), run in a child Playwright process: it launches the
 * production main, names its process and folder in the drill's marker file, and then either outlives its timeout
 * (`timeout`) or waits to be interrupted (`interrupt`). Skipped in every ordinary run.
 */
import { test } from "./fixtures";
import fs from "node:fs";

test("drill target: launches the app, then times out or waits for SIGINT", async ({ launchApp }) => {
  const marker = process.env.RECORDSTUFF_UI_DRILL_MARKER;
  const mode = process.env.RECORDSTUFF_UI_DRILL;
  test.skip(!marker || !mode, "only cleanup drills D03 and D07 run this");
  test.setTimeout(mode === "timeout" ? 8_000 : 120_000);
  const app = await launchApp();
  // Written whole, then renamed into place: the drill polls for the file and reads it at once, and a plain write let it
  // read an empty file (CI, 2026-10-28: "Unexpected end of JSON input" in D07).
  fs.writeFileSync(`${marker!}.tmp`, JSON.stringify({ pid: app.pid, data: app.data }));
  fs.renameSync(`${marker!}.tmp`, marker!);
  await new Promise(() => {});
});
