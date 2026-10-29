// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView, ShareView } from "../../../shared/settings-panel";

const share = (preparing: boolean): ShareView => ({
  heading: "Share “Talk”",
  versions: [
    { kind: "video", label: "Video file", detail: "As it plays here", fileName: "Talk.mp4", recommended: true,
      ...(preparing ? { state: "preparing" as const, progress: 0.4 } : { state: "ready" as const }) },
    { kind: "sound", label: "Sound only", detail: "The mixed sound", fileName: "Talk (sound).m4a", state: "ready" },
    { kind: "original", label: "Original", detail: "Everything recorded", fileName: "Talk.recordstuff.mp4", note: "Includes the camera and each sound separately", state: "ready" },
    { kind: "sources", label: "Sources", detail: "Each track on its own", fileName: "Talk sources", more: true, state: "ready" },
  ],
  labels: { share: "Share", recommended: "Recommended", copy: "Copy", saveTo: "Save to…", more: "More", moreCount: "{count} items", close: "Close",
    drag: "You can also drag a file into another app.", preparing: "Preparing…", failed: "Could not be made",
    preparingNote: "Preparing {percent}%. Copy and Save to… wait until it is ready.", failedNote: "This file could not be made.",
    selected: "{count} files selected", copied: "Copied", saved: "Saved" },
});
const item = (preparing: boolean): LibraryItemView => ({ id: "a", day: "Today", title: "Talk", name: "Talk.recordstuff.mp4", time: "2:02 PM", duration: "0:10",
  size: "18 MB", thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1", editable: "Editable", share: share(preparing) });

const key = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

/**
 * Plan 100 step 3's Share…: the card as a little folder. The Video selected as it opens and Copy asked for it; ⌘-click
 * selects several; Space, the arrows, Return and ⌘C on the panel; a drag of a selected file drags the selection; More
 * opens as a folder; Escape closes; ⌘C on a card without the panel copies its Video. Behaviour and names only.
 */
it("shares a recording's versions from the card's folder", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1, preparing = true;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [], library: { folder: "~/Movies", items: [item(preparing)] } });
  const sent: Array<[string, unknown]> = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    sent.push([group, choice]);
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));

  // ⌘C on the card copies its Video.
  key(document.getElementById("clip-a-open")!, { key: "c", metaKey: true });
  await vi.waitFor(() => expect(sent).toContainEqual(["recordingShare:a", { action: "copy", kinds: ["video"] }]));

  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-share")!);
  await vi.waitFor(() => expect(document.querySelector(".share-panel")).not.toBeNull());
  expect(sent).toContainEqual(["recordingShare:a", { action: "open" }]);
  const option = (kind: string) => document.getElementById(`share-a-${kind}`)!;
  expect(option("video").getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector(".share-listbox, [role=listbox]")!.getAttribute("aria-multiselectable")).toBe("true");
  expect(option("video").getAttribute("aria-label")).toBe("Video file, As it plays here, Talk.mp4");
  // The Video being prepared: said on its icon and in the bar, every file with the same two lines under it.
  expect(option("video").querySelector(".share-mark-progress")!.getAttribute("aria-label")).toBe("Preparing… 40%");
  expect(document.querySelector(".share-picked-note")!.textContent).toBe("Preparing 40%. Copy and Save to… wait until it is ready.");
  expect([...document.querySelectorAll(".share-file")].every((file) => file.querySelectorAll(".share-name, .share-detail").length === 2)).toBe(true);

  // Copy waits in main for what is being prepared; the bar says it was copied.
  click(document.getElementById("share-a-copy")!);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingShare:a", { action: "copy", kinds: ["video"] }]));
  await vi.waitFor(() => expect(document.querySelector(".share-picked-note")!.textContent).toBe("Copied"));

  // A click selects one; ⌘-click adds another; the bar counts them and Save to… takes both.
  click(option("original"));
  expect(document.querySelector(".share-picked-note")!.textContent).toBe("Includes the camera and each sound separately");
  option("sound").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
  await vi.waitFor(() => expect(document.querySelector(".share-picked-name")!.textContent).toBe("2 files selected"));
  click(document.getElementById("share-a-save")!);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingShare:a", { action: "save", kinds: ["original", "sound"] }]));

  // Dragging a selected file drags the selection; another drags alone.
  option("sound").dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingShare:a", { action: "drag", kinds: ["original", "sound"] }]));
  option("video").dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingShare:a", { action: "drag", kinds: ["video"] }]));

  // The keys: an arrow moves, Space selects, Return and ⌘C copy the selection.
  option("original").focus();
  key(option("original"), { key: "ArrowLeft" });
  expect(document.activeElement).toBe(option("sound"));
  key(option("sound"), { key: " " });
  await vi.waitFor(() => expect(option("sound").getAttribute("aria-selected")).toBe("true"));
  expect(option("original").getAttribute("aria-selected")).toBe("false");
  key(option("sound"), { key: "Enter" });
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingShare:a", { action: "copy", kinds: ["sound"] }]));
  key(option("sound"), { key: "c", metaKey: true });
  await vi.waitFor(() => expect(sent.filter(([, choice]) => JSON.stringify(choice) === JSON.stringify({ action: "copy", kinds: ["sound"] }))).toHaveLength(2));

  // More opens as a folder, its first file selected; back again.
  click(document.getElementById("share-a-more")!);
  await vi.waitFor(() => expect(option("sources").getAttribute("aria-selected")).toBe("true"));
  click(document.getElementById("share-a-back")!);
  await vi.waitFor(() => expect(option("video").getAttribute("aria-selected")).toBe("true"));

  // Escape closes, the focus back on the card's menu button.
  key(option("video"), { key: "Escape" });
  await vi.waitFor(() => expect(document.querySelector(".share-panel")).toBeNull());
  expect(document.activeElement?.id).toBe("clip-a-more");
});
