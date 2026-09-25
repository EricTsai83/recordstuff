/** Build-only instrumentation. No production module imports this file or the fixture. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TrayModel } from "../../src/main/tray-model.ts";
import type { SettingsView } from "../../src/shared/settings-panel.ts";
import type { RecordingState } from "../../src/shared/state.ts";

function replaceOnce(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw new Error(`Acceptance source anchor changed: ${from}`);
  return source.replace(from, to);
}
export function instrumentUpdateAcceptance(source: string, runDir: string): string {
  source = replaceOnce(source, 'let currentLanguage: Language = DEFAULT_LANGUAGE;',
    `import { configureAcceptance, attachAcceptance } from "../../scripts/fixtures/update-acceptance";\nconst acceptance = configureAcceptance(${JSON.stringify(runDir)});\nlet currentLanguage: Language = DEFAULT_LANGUAGE;`);
  source = replaceOnce(source, 'defaultOutputDir: defaultOutputDir(),', 'defaultOutputDir: acceptance.outputDir || defaultOutputDir(),');
  source = replaceOnce(source, 'localVersion: app.getVersion(), settled,', 'localVersion: app.getVersion(), settled, now: acceptance.now,');
  source = replaceOnce(source, 'fetch: (signal) => fetchVersion(process.platform, process.arch, signal, (url, init) => net.fetch(url, init)),',
    'fetch: (signal) => acceptance.fetch(signal),');
  // Remove only the now-unused production imports from this throwaway copy.
  source = replaceOnce(source, '  net,\n', '');
  source = replaceOnce(source, 'UpdateChecker, fetchVersion, DOWNLOAD_URL', 'UpdateChecker, DOWNLOAD_URL');
  source = replaceOnce(source, '  updates.flush();\n  log(`ready;',
    '  attachAcceptance(acceptance, { recorder, updates, settings, tray, handleAction });\n  updates.flush();\n  log(`ready;');
  // The fixture intercepts this exact lazy call; stop if production bypasses it.
  source = replaceOnce(source, 'show: (savedPath, stoppedEarly) => tray.notifySaved(savedPath, stoppedEarly),', 'show: (savedPath, stoppedEarly) => tray.notifySaved(savedPath, stoppedEarly),');
  return source;
}
export function prepareUpdateAcceptance(root: string, workspace: string, runDir: string): void {
  for (const name of ['src', 'resources', 'build', 'scripts']) fs.cpSync(path.join(root, name), path.join(workspace, name), { recursive: true });
  for (const name of ['package.json', 'pnpm-lock.yaml', 'electron-builder.yml', 'electron-builder.local.yml', 'electron.vite.config.ts', 'tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.base.json']) {
    fs.copyFileSync(path.join(root, name), path.join(workspace, name));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
  const entry = path.join(workspace, 'src/main/index.ts');
  fs.writeFileSync(entry, instrumentUpdateAcceptance(fs.readFileSync(entry, 'utf8'), runDir));
}
export type CaseResult = { name: string; status: 'pass' | 'fail' | 'blocked' | 'not-run'; detail: string; required: boolean };
export function acceptanceExitCode(cases: CaseResult[]): number {
  if (cases.some(c => c.required && c.status === 'fail')) return 1;
  if (!cases.some(c => c.required) || cases.some(c => c.required && c.status !== 'pass')) return 2;
  return 0;
}

/** Do not send a system-wide shortcut unless it belongs to our sole fixture process. */
export function safeCaptureShortcut(pid: number, runningPids: number[], hotkey: { enabled: boolean; registered: boolean; accelerator: string } | null | undefined): string {
  if (runningPids.length !== 1 || runningPids[0] !== pid) throw new Error('Another RecordStuff process appeared; refusing global input.');
  if (!hotkey?.enabled || !hotkey.registered) throw new Error('Fixture does not own its recording shortcut.');
  return hotkey.accelerator;
}

/**
 * What a starting, recording or saving recorder must do to each settings group, from product intent
 * (docs/system-design/desktop.md), not from what the model currently returns: preferences and update
 * actions lock; language, appearance and the About links stay usable. A group missing from this table,
 * or a listed group the panel no longer offers, fails until someone classifies it here.
 */
export const BUSY_SETTINGS_POLICY: Readonly<Record<string, "locked" | "available">> = {
  screen: "locked", videoQuality: "locked", resolutionCap: "locked", frameRate: "locked", hotkey: "locked",
  notifications: "locked", updateChecks: "locked", updates: "locked",
  language: "available", appearance: "available", about: "available",
};
export type LockSnapshot = { recording: RecordingState; model: TrayModel; settings: SettingsView };

/**
 * The tray and settings contract of one recorder state. Only recording shows REC and Stop; every busy
 * state locks preferences, including the tray's output-folder change; a settled recorder unlocks them.
 * The tray never offers update actions, and the panel disables a locked group's controls with it.
 */
export function assertLockContract(s: LockSnapshot): void {
  const state = s.recording.type;
  const busy = state === "starting" || state === "recording" || state === "stopping";
  assert.equal(s.model.title, state === "recording" ? "REC" : busy ? "…" : "", `tray title while ${state}`);
  const items = s.model.menu.flatMap(i => i.kind === "item" ? [i] : []);
  // Located by action: failure-history lines may precede the recording status.
  const stops = items.filter(i => i.action === "stop");
  if (state === "recording") assert(stops.length === 1 && stops[0]!.enabled, "one enabled Stop while recording");
  else assert.equal(stops.length, 0, `no Stop while ${state}`);
  for (const i of items) {
    assert(i.action !== "checkUpdates" && i.action !== "openUpdate" && !i.label.includes("Update available:"), `tray update action while ${state}: ${i.label}`);
    if (busy) assert(!(i.action === "changeOutputDir" && i.enabled), `output folder change enabled while ${state}`);
  }
  const ids = s.settings.groups.map(g => g.id);
  const unknown = ids.filter(id => !Object.hasOwn(BUSY_SETTINGS_POLICY, id));
  assert.deepEqual(unknown, [], `settings groups without a lock policy: ${unknown.join(", ")}`);
  const missing = Object.keys(BUSY_SETTINGS_POLICY).filter(id => !ids.includes(id));
  assert.deepEqual(missing, [], `settings groups no longer offered: ${missing.join(", ")}`);
  for (const group of s.settings.groups) {
    const available = BUSY_SETTINGS_POLICY[group.id] === "available";
    assert.equal(group.enabled, available || !busy, `settings group ${group.id} while ${state}`);
    // A permitted group must stay usable choice by choice, not only as a group.
    if (available) for (const choice of [...group.choices, ...group.actions ?? []]) assert.equal(choice.enabled, true, `settings choice ${group.id}/${choice.id} while ${state}`);
  }
}

/** Refuse existing evidence without invoking any app/build work. */
export function createAcceptanceOutput(dir: string): void {
  fs.mkdirSync(dir);
}
