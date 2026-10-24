/** A child process's output, line by line, for the processes main forks (the capture host, the export worker). */
import { StringDecoder } from "node:string_decoder";

/**
 * Calls `onLine` with each non-blank, trimmed line of a process's output. Pipe chunks end anywhere: a line that spans
 * two of them stays one line and a character split between them is decoded whole (the engine's timing lines are read
 * back by the frame diagnostics). The unfinished last line is given when the stream ends.
 */
export function pipeLines(stream: NodeJS.EventEmitter, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const take = (text: string, final: boolean): void => {
    const lines = (pending + text).split("\n");
    pending = final ? "" : lines.pop()!;
    for (const line of lines) if (line.trim()) onLine(line.trim());
  };
  stream.on("data", (chunk: Buffer) => take(decoder.write(chunk), false));
  stream.once("end", () => take(decoder.end(), true));
}
