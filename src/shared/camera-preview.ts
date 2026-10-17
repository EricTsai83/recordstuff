/** Plan 075 step 2's preview page: the channel main hands it the capture process's preview port on. */
export const CAMERA_PREVIEW_PORT_CHANNEL = "camera-preview:port";

/** Main's message that hands a capture process a preview port, Settings' or the prototype page's; not part of the capture protocol. */
export const PREVIEW_PORT_MESSAGE = "cameraPreviewPort";

/** Plan 075 step 2's development switch, read by the engine too (native/capture/src/camera_layout.rs). */
export const CAMERA_PROTOTYPE_SWITCH = "RECORDSTUFF_CAMERA_PROTOTYPE";

/** Whether the camera prototype's switch is on, as the engine reads it. */
export function cameraPrototypeOn(env: Record<string, string | undefined>): boolean {
  const value = (env[CAMERA_PROTOTYPE_SWITCH] ?? "").trim();
  return value !== "" && value !== "0" && value.toLowerCase() !== "off";
}

/** Whether it also asks for preview frames: on unless its value has `preview=0`, as the engine reads it. */
export function cameraPreviewOn(env: Record<string, string | undefined>): boolean {
  if (!cameraPrototypeOn(env)) return false;
  const pairs = (env[CAMERA_PROTOTYPE_SWITCH] ?? "").split(",").map((pair) => pair.split("=").map((part) => part.trim()));
  return !pairs.some(([key, value]) => key === "preview" && value !== undefined && Number(value) === 0);
}
