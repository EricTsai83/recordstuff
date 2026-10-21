import { describe, expect, it, vi } from "vitest";
import type { CameraDevice, MicrophoneDevice } from "../../shared/protocol";
import { DeviceLists, type DeviceListsDeps } from "./device-lists";

const mic: MicrophoneDevice = { id: "mic", name: "MacBook Pro Microphone", default: true };
const cam: CameraDevice = { id: "cam", name: "FaceTime HD Camera", default: true };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<DeviceListsDeps> = {}) {
  const order: string[] = [];
  const deps = {
    listMicrophones: vi.fn(async () => { order.push("microphones"); return [mic]; }),
    listCameras: vi.fn(async () => { order.push("cameras"); return [cam]; }),
    allowed: vi.fn(() => true),
    cameraAvailable: vi.fn(() => true),
    changed: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
  return { lists: new DeviceLists(deps), deps, order };
}

describe("DeviceLists", () => {
  it("lists each kind once at a time: a second request waits for the listing in flight", async () => {
    const pending = deferred<MicrophoneDevice[]>();
    const { lists, deps } = setup({ listMicrophones: vi.fn(() => pending.promise) });
    const first = lists.refreshMicrophones(), second = lists.refreshMicrophones();
    expect(second).toBe(first);
    pending.resolve([mic]);
    await first;
    expect(deps.listMicrophones).toHaveBeenCalledOnce();
    expect(lists.microphones).toEqual([mic]);
    expect(deps.changed).toHaveBeenCalledOnce();
  });

  it("takes the kinds in turn, and a listing that fails leaves the next its turn", async () => {
    const pending = deferred<MicrophoneDevice[]>();
    const { lists, deps, order } = setup({ listMicrophones: vi.fn(() => { order.push("microphones"); return pending.promise; }) });
    lists.refresh();
    await Promise.resolve();
    expect(order).toEqual(["microphones"]);
    pending.reject(new Error("no audio media type"));
    await lists.refreshCameras();
    expect(order).toEqual(["microphones", "cameras"]);
    expect([lists.microphones, lists.cameras]).toEqual([undefined, [cam]]);
    expect(deps.log).toHaveBeenCalledWith("microphone: the inputs could not be listed: no audio media type");
  });

  it("lists nothing while a session runs, and no cameras where the engine records none", async () => {
    const locked = setup({ allowed: () => false });
    await locked.lists.refreshMicrophones();
    await locked.lists.search();
    expect(locked.deps.listMicrophones).not.toHaveBeenCalled();
    expect(locked.lists.searching).toBe(false);
    const noCamera = setup({ cameraAvailable: () => false });
    await noCamera.lists.refreshCameras();
    expect(noCamera.deps.listCameras).not.toHaveBeenCalled();
  });

  it("shows Searching… while a search lists the inputs, and takes the monitor's list as it changes", async () => {
    const pending = deferred<MicrophoneDevice[]>();
    const { lists, deps } = setup({ listMicrophones: vi.fn(() => pending.promise) });
    const search = lists.search();
    expect(lists.searching).toBe(true);
    await lists.search();
    expect(deps.listMicrophones).toHaveBeenCalledOnce();
    pending.resolve([mic]);
    await search;
    expect([lists.searching, lists.microphones]).toEqual([false, [mic]]);
    lists.setMicrophones([]);
    expect(lists.microphones).toEqual([]);
    expect(deps.changed).toHaveBeenCalledTimes(4);
  });
});
