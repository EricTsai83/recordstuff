/**
 * Pure pieces of `pnpm acceptance:shortcut-layout` (docs/system-design/tooling.md#keyboard-layout-shortcut-check):
 * the JavaScript for Automation helper that reads and selects macOS input
 * sources, the choice of a source whose number row types no digits, restore
 * bookkeeping and the run's verdict. The runner owns processes and files.
 */

/** Chosen so no preset, reserved or commonly bound combination collides with it. */
export const LAYOUT_ACCELERATOR = "CommandOrControl+Control+Alt+Shift+7";
/** ANSI key codes: the number row for 0–9 and the keypad key for the accelerator's 7. */
export const NUMBER_ROW_KEY_CODES = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25] as const;
export const NUMBER_ROW_SEVEN = 26;
export const KEYPAD_SEVEN = 89;

/**
 * `osascript -l JavaScript input-source.js <list|state|select id>`. TIS
 * functions are bound with object types because the Carbon bridge's own
 * signatures reject the refs it returns. Key translation goes through a
 * CGEvent, which uses the keyboard layout current when the helper starts; each
 * query is a fresh process for that reason.
 */
export const INPUT_SOURCE_SCRIPT = String.raw`
function run(argv) {
  ObjC.import('Carbon');
  ObjC.import('AppKit');
  ObjC.bindFunction('TISGetInputSourceProperty', ['id', ['id', 'id']]);
  ObjC.bindFunction('TISCreateInputSourceList', ['id', ['id', 'bool']]);
  ObjC.bindFunction('TISSelectInputSource', ['int', ['id']]);
  ObjC.bindFunction('TISCopyCurrentKeyboardInputSource', ['id', []]);
  ObjC.bindFunction('TISCopyCurrentKeyboardLayoutInputSource', ['id', []]);
  const property = (source, name) => {
    const value = $.TISGetInputSourceProperty(source, ObjC.castRefToObject($[name]));
    return value && !value.isNil() ? ObjC.unwrap(value) : null;
  };
  const describe = source => ({
    id: property(source, 'kTISPropertyInputSourceID'),
    name: property(source, 'kTISPropertyLocalizedName'),
    type: property(source, 'kTISPropertyInputSourceType'),
    category: property(source, 'kTISPropertyInputSourceCategory'),
    selectCapable: property(source, 'kTISPropertyInputSourceIsSelectCapable') === true,
  });
  // Enabled sources only: the runner never enables or adds one.
  const enabled = () => {
    const list = $.TISCreateInputSourceList($(), false);
    const sources = [];
    for (let i = 0; i < list.count; i++) sources.push(list.objectAtIndex(i));
    return sources;
  };
  const [command, id] = argv;
  if (command === 'list') return JSON.stringify(enabled().map(describe));
  if (command === 'state') {
    const keys = {};
    for (const code of [${[...NUMBER_ROW_KEY_CODES, KEYPAD_SEVEN].join(", ")}]) {
      keys[code] = ObjC.unwrap($.NSEvent.eventWithCGEvent($.CGEventCreateKeyboardEvent($(), code, true)).characters);
    }
    return JSON.stringify({
      source: property($.TISCopyCurrentKeyboardInputSource(), 'kTISPropertyInputSourceID'),
      layout: property($.TISCopyCurrentKeyboardLayoutInputSource(), 'kTISPropertyInputSourceID'),
      keys,
    });
  }
  if (command === 'select' && id) {
    const source = enabled().find(candidate => property(candidate, 'kTISPropertyInputSourceID') === id);
    if (!source || !describe(source).selectCapable) throw new Error('not an enabled, selectable input source: ' + id);
    const status = $.TISSelectInputSource(source);
    if (status !== 0) throw new Error('TISSelectInputSource returned ' + status + ' for ' + id);
    return JSON.stringify({ selected: id });
  }
  throw new Error('usage: input-source.js list | state | select <id>');
}
`;

export interface InputSource {
  id: string;
  name: string | null;
  type: string | null;
  category: string | null;
  selectCapable: boolean;
}

export interface LayoutState {
  /** The selected input source, e.g. `com.apple.inputmethod.TCIM.Zhuyin`. */
  source: string;
  /** The keyboard layout it types with, e.g. `com.apple.keylayout.ZhuyinBopomofo`. */
  layout: string;
  /** Characters typed without modifiers, by key code. */
  keys: Record<string, string>;
}

export function parseSources(output: string): InputSource[] {
  const value = JSON.parse(output) as unknown;
  if (!Array.isArray(value)) throw new Error(`Unexpected input-source list: ${output}`);
  return value.filter((source): source is InputSource => typeof source?.id === "string");
}

export function parseState(output: string): LayoutState {
  const value = JSON.parse(output) as Partial<LayoutState>;
  if (typeof value.source !== "string" || typeof value.layout !== "string" || typeof value.keys !== "object" || !value.keys) {
    throw new Error(`Unexpected input-source state: ${output}`);
  }
  return value as LayoutState;
}

/**
 * Chromium's layout-aware lookup binds a digit to whichever key types it. The
 * check needs a layout where no number-row key types a digit but the keypad
 * still types 7; otherwise the lookup lands on the number row anyway and the
 * check would pass with the bug present.
 */
export function layoutVerdict(state: LayoutState): { qualifies: boolean; reason: string } {
  const row = NUMBER_ROW_KEY_CODES.map(code => state.keys[code] ?? "");
  const digits = row.filter(typed => /^[0-9]$/.test(typed));
  const keypad = state.keys[KEYPAD_SEVEN];
  if (digits.length) return { qualifies: false, reason: `${state.layout} types ${digits.join(" ")} on the number row` };
  if (keypad !== "7") return { qualifies: false, reason: `${state.layout} types ${JSON.stringify(keypad ?? null)} on keypad 7, not 7` };
  return { qualifies: true, reason: `${state.layout} types ${row.join(" ")} on the number row and 7 on the keypad` };
}

const eligible = (source: InputSource): boolean =>
  source.selectCapable && source.category === "TISCategoryKeyboardInputSource";

/**
 * Enabled keyboard sources to try, the current one first so that a user who
 * already types with such a layout sees no switch. A requested source that is
 * not enabled is blocked before anything changes.
 */
export function orderCandidates(sources: readonly InputSource[], current: string, requested?: string):
  { candidates: InputSource[] } | { blocked: string } {
  const usable = sources.filter(eligible);
  if (requested) {
    const match = usable.find(source => source.id === requested);
    return match ? { candidates: [match] } : {
      blocked: `${requested} is not an enabled, selectable keyboard input source. Enable it in System Settings → Keyboard → Input Sources; this runner never adds or enables sources.`,
    };
  }
  const ordered = [...usable.filter(source => source.id === current), ...usable.filter(source => source.id !== current)];
  return ordered.length ? { candidates: ordered } : { blocked: "No enabled, selectable keyboard input source was found." };
}

/** An input method applies its own keyboard layout only once a text field activates it. */
export function needsActivation(source: InputSource): boolean {
  return source.type === "TISTypeKeyboardInputMode" || source.type === "TISTypeKeyboardInputMethodWithoutModes";
}

export interface InputSourceOps {
  current(): Promise<string>;
  select(id: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

export interface RestoreRecord {
  original: string;
  /** Whether this run ever asked for a different source. */
  changed: boolean;
  /** Whether the restore had to select the original again. */
  selected: boolean;
  restored: string | undefined;
  confirmed: boolean;
  error?: string;
}

/**
 * Remembers the source seen before any change and puts it back. A selection
 * counts as a change before it is attempted, since an interrupted or failed
 * call may still have switched. Restoring always rereads the current source,
 * so it also repairs a switch made by someone else during the round.
 */
export class InputSourceGuard {
  private changed = false;
  private record: RestoreRecord | undefined;
  private readonly ops: InputSourceOps;
  readonly original: string;
  private readonly confirmAttempts: number;

  constructor(ops: InputSourceOps, original: string, confirmAttempts = 15) {
    this.ops = ops;
    this.original = original;
    this.confirmAttempts = confirmAttempts;
  }

  async select(id: string): Promise<void> {
    if (id !== this.original) this.changed = true;
    this.record = undefined;
    await this.ops.select(id);
  }

  async restore(): Promise<RestoreRecord> {
    if (this.record?.confirmed) return this.record;
    const record: RestoreRecord = { original: this.original, changed: this.changed, selected: false, restored: undefined, confirmed: false };
    const failed = (error: unknown) => { record.error = error instanceof Error ? error.message : String(error); };
    // An unreadable source counts as not restored, so a failed query still selects the original.
    const read = async () => { try { return await this.ops.current(); } catch (error) { failed(error); return undefined; } };
    record.restored = await read();
    if (record.restored !== this.original) {
      record.selected = true;
      try { await this.ops.select(this.original); } catch (error) { failed(error); }
      for (let attempt = 0; attempt < this.confirmAttempts; attempt++) {
        record.restored = await read();
        if (record.restored === this.original) break;
        await this.ops.wait(200);
      }
    }
    record.confirmed = record.restored === this.original;
    if (record.confirmed) delete record.error;
    else if (record.restored !== undefined) record.error = `input source is ${record.restored}, expected ${this.original}`;
    this.record = record;
    return record;
  }
}

export interface KeyResult {
  name: string;
  keyCode: number;
  accelerator: string;
  expected: boolean;
  observed: boolean;
  presses: number;
  error?: string;
}

export interface FixtureCleanup {
  registered: boolean;
  windows: number;
}

export interface RunOutcome {
  drill: boolean;
  /** Missing prerequisite, unavailable layout or refused registration. */
  blocked: string[];
  locked: boolean;
  interrupted: boolean;
  error: string | undefined;
  keys: KeyResult[];
  restore: RestoreRecord | undefined;
  /** Every process group this run started is gone. */
  processesGone: boolean;
  /** Supervisor outcome of each owned Electron process. */
  executions: Execution[];
  fixtureCleanup: FixtureCleanup | undefined;
}

export interface Execution {
  phase: string;
  code: number | null;
  stopped: string | undefined;
  forced: boolean;
  error: string | undefined;
}

/** An owned process must exit by itself with 0; results written before a crash or hang do not count. */
function abnormal(execution: Execution): string | undefined {
  if (execution.error) return `${execution.phase}: ${execution.error}`;
  if (execution.stopped && execution.stopped !== "interrupted") return `${execution.phase}: stopped after ${execution.stopped}`;
  if (execution.forced) return `${execution.phase}: had to be killed`;
  if (!execution.stopped && execution.code !== 0) return `${execution.phase}: exited with ${execution.code}`;
  return undefined;
}

export type Status = "PASS" | "FAIL" | "BLOCKED";

/**
 * Exit 0 pass, 1 fail, 2 blocked, as in the other runners. Cleanup failures
 * outrank everything, a lock makes the round blocked even if keys passed, and
 * the drill is an intentional failure that never passes.
 */
export function classify(outcome: RunOutcome): { status: Status; exitCode: 0 | 1 | 2; reasons: string[]; drillDetected: boolean | undefined } {
  const cleanup = [
    ...(outcome.restore && !outcome.restore.confirmed ? [`input source not restored: ${outcome.restore.error ?? "unconfirmed"}`] : []),
    ...(outcome.processesGone ? [] : ["a fixture process group remained"]),
    ...(outcome.fixtureCleanup?.registered ? ["a global shortcut stayed registered at quit"] : []),
    ...(outcome.fixtureCleanup?.windows ? [`${outcome.fixtureCleanup.windows} window(s) stayed open at quit`] : []),
  ];
  const failedKeys = outcome.keys.filter(key => key.observed !== key.expected || key.error)
    .map(key => `${key.name}: ${key.error ?? (key.expected ? "did not fire" : "fired")}`);
  const numberRow = outcome.keys.find(key => key.keyCode === NUMBER_ROW_SEVEN);
  const drillDetected = outcome.drill && numberRow ? !numberRow.observed : undefined;
  const result = (status: Status, reasons: string[]) =>
    ({ status, exitCode: status === "PASS" ? 0 as const : status === "FAIL" ? 1 as const : 2 as const, reasons, drillDetected });
  if (cleanup.length) return result("FAIL", cleanup.map(reason => `cleanup: ${reason}`));
  if (outcome.locked) return result("BLOCKED", ["the screen locked during the round"]);
  if (outcome.interrupted) return result("FAIL", ["interrupted before completion"]);
  const processes = outcome.executions.map(abnormal).filter(reason => reason !== undefined);
  if (processes.length) return result("FAIL", processes);
  if (outcome.blocked.length) return result("BLOCKED", outcome.blocked);
  if (outcome.error) return result("FAIL", [outcome.error]);
  if (!outcome.keys.length) return result("FAIL", ["no key results"]);
  if (failedKeys.length) return result("FAIL", failedKeys);
  if (outcome.drill) return result("FAIL", ["drill: the number-row key still fired with layout lookup on; the check did not detect it"]);
  return result("PASS", []);
}

/**
 * Other RecordStuff processes own the same global shortcuts: the packaged app
 * or a report workspace bundle, and any Electron main process of this
 * checkout, whether started with the checkout as an argument (`pnpm start`,
 * other fixtures) or from its own `node_modules` with a relative entry
 * (`pnpm dev` and `pnpm preview` run `Electron .` in the checkout). The
 * checkout's Electron running an absolute entry elsewhere is not RecordStuff.
 * `ps -axo pid=,command=` lines in, offending lines out.
 */
export function otherRecordStuffProcesses(psLines: readonly string[], root: string, ownPids: readonly number[]): string[] {
  return psLines.map(line => line.trim()).filter(line => {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match || ownPids.includes(Number(match[1]))) return false;
    const command = match[2] ?? "";
    if (/RecordStuff\.app\/Contents\/MacOS\/RecordStuff(\s|$)/.test(command)) return true;
    const executable = /^(.*?Electron\.app\/Contents\/MacOS\/Electron)(?:\s+(\S+))?/.exec(command);
    if (!executable) return false;
    if (`${command} `.includes(` ${root} `)) return true;
    const entry = executable[2];
    return executable[1]!.startsWith(`${root}/node_modules/`) && entry !== undefined && !entry.startsWith("/") && !entry.startsWith("-");
  });
}
