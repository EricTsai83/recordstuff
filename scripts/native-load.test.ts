import { expect, it } from "vitest";
import { ENGINE_METHODS, missingMethods } from "./native-load.mjs";

it("names what a module lacks of the capture host's calls, and refuses one without the class", () => {
  class Full { }
  for (const name of ENGINE_METHODS) (Full.prototype as unknown as Record<string, unknown>)[name] = () => undefined;
  expect(missingMethods({ NativeCapture: Full })).toEqual([]);
  class Partial { probe(): void {} }
  expect(missingMethods({ NativeCapture: Partial })).toEqual(ENGINE_METHODS.filter((name) => name !== "probe"));
  expect(() => missingMethods({})).toThrow("no NativeCapture class");
});
