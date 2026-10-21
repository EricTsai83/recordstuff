import { mountRoot } from "../lib/mount-root";
import { CountdownApp } from "./countdown-app";

// A transparent window over the screen: one that cannot draw shows nothing rather than words over the user's work.
if (typeof window !== "undefined" && window.countdown) mountRoot(CountdownApp, { fallback: "none" });
