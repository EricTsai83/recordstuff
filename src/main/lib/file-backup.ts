import fs from "node:fs";
import path from "node:path";
import { errnoCode } from "./errors";

/** Keep original metadata before replacement, without overwriting an earlier backup. */
export async function keepFile(file: string, suffix: string, limit = 100): Promise<string | undefined> {
  for (let index = 0; index < limit; index++) {
    const kept = `${file}.${suffix}${index ? `.${index}` : ""}`;
    try {
      await fs.promises.link(file, kept);
      return kept;
    } catch (cause) {
      const code = errnoCode(cause);
      if (code === "ENOENT") return undefined;
      if (code !== "EEXIST") throw cause;
    }
  }
  throw new Error(`every name up to ${path.basename(file)}.${suffix}.${limit - 1} is taken`);
}
