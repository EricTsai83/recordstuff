import { describe, expect, it } from "vitest";
import { EditableChoice } from "./editable-choice";

function rig(platform = "darwin", setting = false) {
  const state = { setting, preview: true, stopped: 0 };
  const logs: string[] = [];
  const choice: EditableChoice = new EditableChoice({
    platform,
    setting: () => state.setting,
    preview: () => state.preview,
    // As the recorder does: the preview's cancel settles idle synchronously, and main's subscriber hears it.
    stopPreview: () => { state.stopped += 1; state.preview = false; choice.idle(); },
    log: (line) => logs.push(line),
  });
  return { choice, state, logs };
}

describe("EditableChoice", () => {
  it("follows the setting, on macOS only", () => {
    expect(rig("darwin", true).choice.next()).toBe(true);
    expect(rig("darwin", false).choice.next()).toBe(false);
    expect(rig("win32", true).choice.next()).toBe(false);
  });

  it("lets a plain Live preview go before the tray's Start editable recording, and stays editable through its idle", () => {
    const { choice, state } = rig();
    choice.chooseOnce();
    expect(state.stopped).toBe(1);
    expect(choice.next()).toBe(true);
    // The recording ends: the next one follows the setting again.
    choice.idle();
    expect(choice.next()).toBe(false);
  });

  it("keeps a preview that is already editable, and has none to let go without one", () => {
    const editable = rig("darwin", true);
    editable.choice.chooseOnce();
    expect(editable.state.stopped).toBe(0);
    const none = rig();
    none.state.preview = false;
    none.choice.chooseOnce();
    expect(none.state.stopped).toBe(0);
    expect(none.choice.next()).toBe(true);
  });

  it("never lets a preview go where recordings cannot be editable", () => {
    const { choice, state } = rig("win32");
    choice.chooseOnce();
    expect(state.stopped).toBe(0);
    expect(choice.next()).toBe(false);
  });
});
