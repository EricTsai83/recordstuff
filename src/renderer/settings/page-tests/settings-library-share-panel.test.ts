// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView, ShareView } from "../../../shared/settings-panel";

const share = (preparing: boolean): ShareView => ({
  heading: "Share “Talk”",
  versions: [
    { kind: "video", label: "Video file", note: "The finished video.", fileName: "Talk.mp4", recommended: true,
      ...(preparing ? { state: "preparing" as const, progress: 0.4 } : { state: "ready" as const }) },
    { kind: "sound", label: "Sound only", note: "Just the sound.", fileName: "Talk (sound).m4a", state: "ready" },
    { kind: "original", label: "Original", fileName: "Talk.recordstuff.mp4", note: "The whole recording as made.", state: "ready" },
    { kind: "sources", label: "Sources", note: "Each as its own file.", fileName: "Talk sources", more: true, state: "ready" },
  ],
  labels: { share: "Share", copy: "Copy", saveTo: "Save to…", more: "More", moreCount: "{count} items", close: "Close",
    drag: "You can also drag a file into another app.", preparing: "Preparing…", failed: "Could not be made",
    preparingNote: "Being prepared. Copy and Save to… wait until it is ready.", failedNote: "This file could not be made.",
    selected: "{count} files selected", copied: "Copied", saved: "Saved" },
});
const item = (preparing: boolean): LibraryItemView => ({ id: "a", day: "Today", title: "Talk", name: "Talk.recordstuff.mp4", time: "2:02 PM", duration: "0:10",
  size: "18 MB", thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1", editable: "Editable", share: share(preparing) });

const key = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

/**
 * Plan 100 step 3's Share…: the card as a little folder. The Video selected as it opens and Copy asked for it; ⌘-click
 * selects several; Space, the arrows, Return and ⌘C on the panel; a drag of a selected file drags the selection; More
 * opens as a folder, named in a breadcrumb; Escape closes; ⌘C on a card without the panel copies its Video. Behaviour
 * and names only.
 */
it("shares a recording's versions from the card's folder", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1, preparing = true, dragFails = false;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [], library: { folder: "~/Movies", items: [item(preparing)] } });
  const sent: Array<[string, unknown]> = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    sent.push([group, choice]);
    // A drag needs its files now: one still being prepared is refused, as main does.
    if ((choice as { action?: string }).action === "drag" && preparing) return { view: view(), applied: false, failure: "Still being prepared.", preparing: true };
    if ((choice as { action?: string }).action === "drag" && dragFails) return { view: view(), applied: false, failure: "This file could not be made." };
    return { view: view(), applied: true };
  });
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
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
  expect(option("video").getAttribute("aria-label")).toBe("Video file, Talk.mp4");
  // The recording's name is said once, in the bar; the breadcrumb says only where the panel is.
  expect(document.querySelector(".share-crumbs [aria-current=page]")!.textContent).toBe("Share");
  expect(document.querySelector(".share-head")!.textContent).not.toContain("Talk");
  // The Video being prepared: nothing says so for the first half second, so a file made in a moment shows nothing.
  expect(option("video").querySelector(".share-progress")).toBeNull();
  expect(document.querySelector(".share-picked-note")!.textContent).toBe("The finished video.");
  // Then said under its icon and in the bar; the picked Video keeps its check meanwhile.
  await vi.waitFor(() => expect(option("video").querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("40"), { timeout: 2000 });
  expect(option("video").querySelector("[role=progressbar]")!.getAttribute("aria-label")).toBe("Preparing…");
  expect(document.querySelector(".share-picked-note")!.textContent).toBe("Being prepared. Copy and Save to… wait until it is ready.");
  expect(option("video").querySelector(".share-mark-picked")).not.toBeNull();
  // Each file is its icon and its name; what it is waits for the bar. The Original carries no warning.
  expect([...document.querySelectorAll(".share-file")].every((file) => file.querySelectorAll(".share-name").length === 1)).toBe(true);
  expect(option("original").querySelector(".share-mark")).toBeNull();

  // Copy waits in main for what is being prepared; the bar says it was copied. Made meanwhile, its bar shows full a little
  // longer rather than going the moment it is shown, then goes.
  preparing = false;
  click(document.getElementById("share-a-copy")!);
  await vi.waitFor(() => expect(option("video").querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("100"));
  await vi.waitFor(() => expect(option("video").querySelector(".share-progress")).toBeNull(), { timeout: 2000 });
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingShare:a", { action: "copy", kinds: ["video"] }]));
  await vi.waitFor(() => expect(document.querySelector(".share-picked-note")!.textContent).toBe("Copied"));

  // A click selects one; ⌘-click adds another; the bar counts them and Save to… takes both.
  click(option("original"));
  expect(document.querySelector(".share-picked-note")!.textContent).toBe("The whole recording as made.");
  // The picked file carries the check; the others none.
  expect(option("original").querySelector(".share-mark-picked")).not.toBeNull();
  expect(option("sound").querySelector(".share-mark")).toBeNull();
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
  expect(document.getElementById("share-a-more")!.getAttribute("aria-label")).toBe("More, 1 items");
  click(document.getElementById("share-a-more")!);
  await vi.waitFor(() => expect(option("sources").getAttribute("aria-selected")).toBe("true"));
  expect([...document.querySelectorAll(".share-crumbs > *")].map((part) => part.textContent)).toEqual(["Share", "", "More"]);
  click(document.getElementById("share-a-back")!);
  await vi.waitFor(() => expect(option("video").getAttribute("aria-selected")).toBe("true"));

  // A drag that finds its file still being prepared says so until the file is ready (or could not be made), then the bar
  // says what the file is again, with nothing to pick again first.
  const note = () => document.querySelector(".share-picked-note")!.textContent;
  preparing = true;
  push(view());
  option("video").dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(note()).toBe("Still being prepared."));
  push(view());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(note(), "still being prepared: still said").toBe("Still being prepared.");
  preparing = false;
  push(view());
  await vi.waitFor(() => expect(note()).toBe("The finished video."), { timeout: 2000 });
  // Any other failure of a drag of a ready file stays said (review): it is not waiting for anything.
  dragFails = true;
  option("video").dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(note()).toBe("This file could not be made."));
  push(view());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(note()).toBe("This file could not be made.");
  dragFails = false;

  // Escape closes, the focus back on the card's menu button.
  key(option("video"), { key: "Escape" });
  await vi.waitFor(() => expect(document.querySelector(".share-panel")).toBeNull());
  expect(document.activeElement?.id).toBe("clip-a-more");
});
