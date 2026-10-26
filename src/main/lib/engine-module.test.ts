import path from "node:path";
import { expect, it } from "vitest";
import { engineAddonPath, engineRejection } from "./engine-module";

it("finds the engine beside the bundle, unpacked from a packaged app's archive", () => {
  expect(engineAddonPath(path.join("/repo", "out", "main"))).toBe(path.join("/repo", "out", "native", "recordstuff-capture.node"));
  const packaged = path.join("/Applications", "RecordStuff.app", "Contents", "Resources", "app.asar", "out", "main");
  expect(engineAddonPath(packaged)).toBe(path.join("/Applications", "RecordStuff.app", "Contents", "Resources", "app.asar.unpacked", "out", "native", "recordstuff-capture.node"));
});

it("reads an engine rejection's code and detail, and a text without a code whole", () => {
  expect(engineRejection(new Error("permission_denied|declined (-3801)"))).toEqual({ code: "permission_denied", detail: "declined (-3801)" });
  expect(engineRejection("a|b|c")).toEqual({ code: "a", detail: "b|c" });
  expect(engineRejection("|leading")).toEqual({ code: undefined, detail: "|leading" });
  expect(engineRejection("boom")).toEqual({ code: undefined, detail: "boom" });
});
