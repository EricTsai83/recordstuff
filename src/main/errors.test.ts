import { describe, expect, it } from "vitest";
import { errnoCode, messageOf } from "./errors";

describe("errors", () => {
  it("reads an errno code only where one is carried", () => {
    expect(errnoCode(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errnoCode({ code: 13 })).toBe("13");
    expect(errnoCode(new Error("plain"))).toBeUndefined();
    expect(errnoCode({ code: undefined })).toBeUndefined();
    for (const value of [null, undefined, "ENOENT", 7]) expect(errnoCode(value)).toBeUndefined();
  });

  it("describes any thrown value", () => {
    expect(messageOf(new Error("disk"))).toBe("disk");
    expect(messageOf("text")).toBe("text");
    expect(messageOf(undefined)).toBe("undefined");
  });
});
