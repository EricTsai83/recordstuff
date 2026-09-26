/**
 * The countdown overlay's only door (plan 040): a subscription to the digit
 * main sends. The page renders values and can send nothing back; no Node API
 * and no generic IPC reaches it.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { CountdownBridge, CountdownValue } from "../shared/countdown";

/** Kept in step with `COUNTDOWN_VALUE_CHANNEL`; a sandboxed preload imports nothing at runtime. */
const CHANNEL = "countdown:value";

const bridge: CountdownBridge = {
  onValue: (callback) => {
    ipcRenderer.on(CHANNEL, (_event, value: unknown) => {
      if (value === null || (typeof value === "number" && Number.isInteger(value) && value > 0)) callback(value as CountdownValue);
    });
  },
};
contextBridge.exposeInMainWorld("countdown", bridge);
