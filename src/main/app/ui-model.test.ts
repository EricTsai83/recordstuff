import { describe, expect, it } from "vitest";
import { abbreviateHome } from "./ui-model";

describe("abbreviateHome", () => {
  it("replaces the home prefix on both path styles", () => {
    expect(abbreviateHome("/Users/eric/Movies/RecordStuff", "/Users/eric")).toBe("~/Movies/RecordStuff");
    expect(abbreviateHome("C:\\Users\\eric\\Videos\\RecordStuff", "C:\\Users\\eric")).toBe("~\\Videos\\RecordStuff");
    expect(abbreviateHome("/Volumes/Ext/Rec", "/Users/eric")).toBe("/Volumes/Ext/Rec");
    expect(abbreviateHome("/Users/eric", "/Users/eric")).toBe("~");
    expect(abbreviateHome("/Users/erica/x", "/Users/eric")).toBe("/Users/erica/x");
    expect(abbreviateHome("/Users/eric/x", "")).toBe("/Users/eric/x");
  });
});
