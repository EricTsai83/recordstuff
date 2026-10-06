import { mountRoot } from "../lib/mount-root";
import { CountdownApp } from "./countdown-app";

if (typeof window !== "undefined" && window.countdown) mountRoot(CountdownApp);
