import { afterEach, expect, it } from "vitest";
import { ProcessTableServer } from "./process-table";

/** A stand-in for the PowerShell loop, with the same protocol: per request line, rows and then the end line. */
const fake = (behaviour: string): ProcessTableServer => new ProcessTableServer(process.execPath, ["-e", `
  const readline = require("node:readline");
  let n = 0;
  readline.createInterface({ input: process.stdin }).on("line", request => {
    n += 1;
    ${behaviour}
  });
`]);
let server: ProcessTableServer | undefined;
afterEach(() => server?.stop());

it("answers every read from one shell, in order, each with only its own rows", async () => {
  server = fake(`process.stdout.write(n + " 1 node\\n" + process.pid + " 1 shell\\n<<<process-table-end " + request + "\\n");`);
  const [first, second] = await Promise.all([server.read(), server.read()]);
  expect(first.trim().split("\n")[0]).toBe("1 1 node");
  expect(second.trim().split("\n")[0]).toBe("2 1 node");
  // The same shell answered both.
  expect(first.trim().split("\n")[1]).toBe(second.trim().split("\n")[1]);
});

it("reports the shell's query error, and starts a fresh shell after one ends", async () => {
  server = fake(`if (n === 1) process.stdout.write("ERROR Access denied\\n<<<process-table-end " + request + "\\n"); else process.exit(5);`);
  await expect(server.read()).rejects.toThrow("process table query failed: Access denied");
  await expect(server.read()).rejects.toThrow(/shell ended \(code 5/);
  // A new shell: its first answer is an error again, not a hang.
  await expect(server.read()).rejects.toThrow("Access denied");
});

it("ends a shell that stops answering, and drops its late answer", async () => {
  server = fake(`if (request === "1") setTimeout(() => process.stdout.write("late 1 old\\n<<<process-table-end " + request + "\\n"), 300); else process.stdout.write("9 1 new\\n<<<process-table-end " + request + "\\n");`);
  await expect(server.read(100)).rejects.toThrow("timed out after 100 ms");
  expect((await server.read()).trim()).toBe("9 1 new");
});

it("keeps a row whose command line contains the end text, as the shell's own row does", async () => {
  server = fake(`process.stdout.write("5 1 electron.exe\\r\\n7 1 powershell.exe -Command ... \\"<<<process-table-end $request\\" ...\\r\\n<<<process-table-end " + request + "\\r\\n");`);
  const rows = (await server.read()).trim().split("\n");
  expect(rows).toEqual(["5 1 electron.exe", "7 1 powershell.exe -Command ... \"<<<process-table-end $request\" ..."]);
});

it("ends a shell whose input pipe failed, and answers the next read from a new one", async () => {
  // The first read is answered at once; the second waits, so the pipe fails while it is outstanding.
  server = fake(`setTimeout(() => process.stdout.write(process.pid + " 1 shell\\n<<<process-table-end " + request + "\\n"), request === "2" ? 2000 : 0);`);
  const first = Number((await server.read()).split(" ")[0]);
  const reading = server.read(5_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  // As a write into a pipe the shell has just closed would.
  (server as unknown as { child: { stdin: NodeJS.EventEmitter } }).child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await expect(reading).rejects.toThrow("EPIPE");
  await expect.poll(() => { try { process.kill(first, 0); return true; } catch { return false; } }).toBe(false);
  const next = Number((await server.read()).split(" ")[0]);
  expect(next).not.toBe(first);
});
