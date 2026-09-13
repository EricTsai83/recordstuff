import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, ZH_TW, isLanguage, translate, type MessageKey } from "./i18n";

describe("language catalog", () => {
  it("defaults to English and validates only supported persisted choices", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(translate("Ready")).toBe("Ready");
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("zh-TW")).toBe(true);
    for (const invalid of ["zh", "zh-CN", "fr", undefined, null, 7]) expect(isLanguage(invalid)).toBe(false);
  });

  it("preserves the same placeholders in every translation", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, value] of Object.entries(ZH_TW)) {
      expect(value.length).toBeGreaterThan(0);
      expect(placeholders(value), key).toEqual(placeholders(key));
      expect(translate(key as MessageKey)).toBe(key);
    }
  });

  it("substitutes repeated values and preserves filenames verbatim", () => {
    expect(
      translate(
        "The system provides {actual} fps. This recording uses {actual} fps (requested {requested} fps).",
        "zh-TW",
        { actual: 30, requested: 60 },
      ),
    ).toBe("系統只提供 30 fps，本次以 30 fps 錄製（設定為 60 fps）");
    expect(translate("Saved {file}", "zh-TW", { file: "demo {file} $&.mp4" })).toBe("已儲存 demo {file} $&.mp4");
  });
});
