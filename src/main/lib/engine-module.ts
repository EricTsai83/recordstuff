/** The native engine as main's processes reach it: where its module lies, and how its rejections read. */
import path from "node:path";

/**
 * The engine's module beside main's bundle in `dir` (`out/main`). Native code cannot load from inside the asar
 * archive; packaging unpacks `out/native`, so a packaged path is turned to its unpacked copy.
 */
export function engineAddonPath(dir: string): string {
  return path.join(path.dirname(dir), "native", "recordstuff-capture.node").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/** The engine rejects with `code|detail`: the code, if the text has one, and the detail (the whole text otherwise). */
export function engineRejection(cause: unknown): { code: string | undefined; detail: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const split = message.indexOf("|");
  return split > 0 ? { code: message.slice(0, split), detail: message.slice(split + 1) } : { code: undefined, detail: message };
}
