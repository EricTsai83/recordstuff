import { expect, it } from "vitest";
import { formatCloseTimings, parseCloseTimings } from "./ui-close-timings.mts";

it("spreads the normal closes and lists the slowest launch first, with a timed-out close named", () => {
  const text = [
    JSON.stringify({ test: "a", kind: "view", closedNormally: true, audit: 10, close: 400, exit: 50 }),
    JSON.stringify({ test: "b", kind: "view", closedNormally: false, audit: 12, close: 15000, exit: 9000 }),
    "not json",
    JSON.stringify({ test: "c", kind: "app", closedNormally: true, audit: 8, close: 600, exit: 40 }),
  ].join("\n");
  const timings = parseCloseTimings(text);
  expect(timings).toHaveLength(3);
  const report = formatCloseTimings(timings, 2).split("\n");
  expect(report[0]).toBe("3 launches; normal close ms: median 600, 95th 15000, slowest 15000; 1 not closed normally or killed");
  expect(report[1]).toContain("close 15000, exit 9000, close failed  view: b");
  expect(report).toHaveLength(3);
});
