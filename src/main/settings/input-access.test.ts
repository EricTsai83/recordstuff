import { describe, expect, it } from "vitest";
import { accessRefused } from "./input-access";

describe("accessRefused", () => {
  it("is only macOS's lasting refusals", () => {
    expect((["denied", "restricted", "granted", "not-determined", "unknown", undefined] as const).map(accessRefused))
      .toEqual([true, true, false, false, false, false]);
  });
});
