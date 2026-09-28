/** Preference side effects share admission, persistence and UI refresh rules. */
export interface PreferenceSave {
  locked?: boolean;
  write(): Promise<void>;
  applied?(): void;
  notifyFailure?(): void;
}
export function createPreferenceActions(deps: {
  settled(): boolean;
  chooseFolder(): Promise<string | undefined>;
  saveFolder(folder: string): Promise<void>;
  folderChanged(): void;
  folderFailed(folder: string): void;
  refresh(): void;
  log(message: string): void;
  /** Brings the open dialog forward when a second request joins it. */
  focus?(): void;
}) {
  let choosing: Promise<boolean> | undefined;
  return {
    async save(what: string, save: PreferenceSave): Promise<void> {
      if (save.locked && !deps.settled()) return;
      try { await save.write(); save.applied?.(); }
      catch (cause) { deps.log(`settings: ${what} save failed: ${String(cause)}`); save.notifyFailure?.(); }
      deps.refresh();
    },
    changeOutputDir(): Promise<boolean> {
      if (choosing) { deps.focus?.(); return choosing; }
      if (!deps.settled()) return Promise.resolve(false);
      choosing = Promise.resolve().then(async () => {
        const folder = await deps.chooseFolder();
        if (!folder) return true;
        if (!deps.settled()) return false;
        try { await deps.saveFolder(folder); }
        catch (cause) { deps.log(`settings: failed to save outputDir: ${String(cause)}`); deps.folderFailed(folder); return false; }
        deps.folderChanged(); deps.refresh(); return true;
      }).finally(() => { choosing = undefined; });
      return choosing;
    },
  };
}
