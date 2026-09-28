/**
 * One stored preference changed for an acceptance round against the running
 * app (plan 046's `--countdown-sound`). The app reads settings.json only at
 * launch and writes its whole in-memory copy on every save, so the value is
 * written only while the app is quit, and it is set back only once no process
 * can still hold the round's value: a restore while the app runs would be
 * overwritten by its next save. Development only, never shipped.
 */
export interface StoredOverrideDeps<T> {
  /** Quits the idle app and resolves once it has exited; rejects when it cannot. */
  quit: () => Promise<void>;
  running: () => boolean;
  write: (value: T) => void;
  /** Opens the same bundle and resolves once it is idle; rejects on failure, whether or not it started. */
  relaunch: () => Promise<void>;
}

export class StoredOverride<T> {
  private active = false;
  // Plain fields: Node's type stripping, which runs these scripts, has no parameter properties.
  private readonly deps: StoredOverrideDeps<T>;
  private readonly original: T;
  private readonly override: T;

  constructor(deps: StoredOverrideDeps<T>, original: T, override: T) {
    this.deps = deps;
    this.original = original;
    this.override = override;
  }

  /** Whether the stored value is still the round's and must be set back. */
  get pending(): boolean { return this.active; }

  /** Quit, write the round's value, relaunch. A failure after the write leaves it pending for `restore`. */
  async apply(): Promise<void> {
    await this.deps.quit();
    this.deps.write(this.override);
    this.active = true;
    await this.deps.relaunch();
  }

  /**
   * Sets the original value back once the app is gone, quitting it first when
   * `quitIfRunning`; returns why it could not, and then leaves it pending.
   */
  async restore(quitIfRunning: boolean): Promise<string | undefined> {
    if (!this.active) return undefined;
    if (this.deps.running()) {
      if (!quitIfRunning) return "RecordStuff is still running, so it could write the round's value again";
      try {
        await this.deps.quit();
      } catch (error) {
        return `RecordStuff could not be quit (${String(error)})`;
      }
      if (this.deps.running()) return "RecordStuff is still running, so it could write the round's value again";
    }
    this.deps.write(this.original);
    this.active = false;
    return undefined;
  }
}
