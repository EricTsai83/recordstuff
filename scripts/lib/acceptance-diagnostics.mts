/** Read-only context for a synthetic key that may not reach the registered callback. */
import { command } from "./acceptance-runtime.mts";

export async function inputDiagnostics(appPid: string): Promise<Record<string, unknown>> {
  // Independent from run cancellation so interruption still leaves useful evidence.
  const signal = AbortSignal.timeout(5000);
  const capture = async (file: string, args: string[]): Promise<string | { error: string }> => {
    try { return await command(file, args, signal, 4000); }
    catch (error) { return { error: String(error) }; }
  };
  const [systemEvents, sender, registry] = await Promise.all([
    capture("osascript", ["-e", 'tell application "System Events" to return {UI elements enabled, name of first application process whose frontmost is true}']),
    capture("ps", ["-o", "pid=,ppid=,comm=", "-p", `${process.pid},${process.ppid},${appPid}`]),
    capture("ioreg", ["-l", "-d", "1"]),
  ]);
  return {
    at: new Date().toISOString(),
    systemEventsUiEnabledAndFrontmost: systemEvents,
    senderAndAppProcesses: sender,
    // Do not preserve the complete registry (unrelated machine/user information).
    secureInputOwnersReported: typeof registry === "string"
      ? [...new Set([...registry.matchAll(/"kCGSSessionSecureInputPID"\s*=\s*(\d+)/g)].map(match => Number(match[1])))]
      : registry,
    limitation: "No reported owner does not prove Secure Input was disabled. UI enabled and osascript exit 0 do not prove key delivery; only the app callback does.",
  };
}
