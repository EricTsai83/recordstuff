import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, ZH_TW, isLanguage, phrases, sentences, translate } from "./i18n";

/** Without values English returns the key verbatim; the placeholder check is bypassed on purpose. */
const english = translate as unknown as (key: string) => string;

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
      expect(english(key)).toBe(key);
    }
  });

  it("requires a value for every placeholder at compile time", () => {
    // @ts-expect-error `{file}` has no value.
    expect(translate("Saved {file}", "en")).toBe("Saved {file}");
    // @ts-expect-error `path` is not this message's placeholder.
    translate("Saved {file}", "en", { path: "/x.mp4" });
    // @ts-expect-error a message without placeholders takes no values.
    translate("Ready", "en", { file: "x" });
  });

  it("substitutes repeated values and preserves filenames verbatim", () => {
    expect(
      translate(
        "The system cannot provide {requested} fps, so this recording uses {actual} fps.",
        "zh-TW",
        { actual: 30, requested: 60 },
      ),
    ).toBe("系統無法提供 60 fps，本次以 30 fps 錄影。");
    expect(translate("Saved {file}", "zh-TW", { file: "demo {file} $&.mp4" })).toBe("已儲存 demo {file} $&.mp4");
  });
});

describe("phrases", () => {
  it("joins the parts of one name with each language's comma", () => {
    expect(phrases(["Today", "2:02 PM", "1:23"], "en")).toBe("Today, 2:02 PM, 1:23");
    expect(phrases(["今天", "下午2:02", "1:23"], "zh-TW")).toBe("今天，下午2:02，1:23");
    expect(phrases(["Today"])).toBe("Today");
  });
});

describe("sentences", () => {
  it("closes and joins messages per language without doubling punctuation", () => {
    expect(sentences(["寫入錄影失敗", "點此查看詳情。"], "zh-TW")).toBe("寫入錄影失敗。點此查看詳情。");
    expect(sentences(["所選螢幕無法使用，請選擇其他螢幕", "點此查看詳情。"], "zh-TW")).toBe("所選螢幕無法使用，請選擇其他螢幕。點此查看詳情。");
    // An ellipsis already ends the sentence, in both languages: no 「…。」.
    expect(sentences(["錄影中斷", "正在處理錄影…"], "zh-TW")).toBe("錄影中斷。正在處理錄影…");
    expect(sentences(["Screen recording permission required", "Click for details."], "en"))
      .toBe("Screen recording permission required. Click for details.");
    expect(sentences(["The disk is full.", "Click for details."])).toBe("The disk is full. Click for details.");
  });
});
