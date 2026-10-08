import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildStampPath, runtimeInputFiles, writeBuildStamp } from "./lib/runner/runtime-inputs.mjs";

type Call = { name: string; args: string[]; nodeMode?: string; releaseSecret?: string; discovery?: string };
let fixtures: string;
let hash: string;
let otherHash: string;
let issuedHash: string;

// No user keychain, real signing, app launch or repo output is touched by these tests.
function certificate(name: string, ca = false): string {
  const certPath = path.join(fixtures, `${name}.pem`);
  const config = path.join(fixtures, `${name}.cnf`);
  writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nbasicConstraints=critical,CA:${ca ? "true" : "false"}\nkeyUsage=critical,${ca ? "keyCertSign" : "digitalSignature"}\nextendedKeyUsage=codeSigning\n`);
  const result = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-subj", `/CN=${name}`, "-config", config, "-keyout", path.join(fixtures, `${name}.key`), "-out", certPath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return new X509Certificate(readFileSync(certPath)).fingerprint.replaceAll(":", "");
}

const appDir = (root: string): string => path.join(root, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "RecordStuff.app");
/** A valid build record for the bundle `invoke` creates, as a previous `start:app` would leave it. */
const stamped = (root: string): void => {
  mkdirSync(path.dirname(appDir(root)), { recursive: true });
  writeBuildStamp(root, appDir(root), hash, runtimeInputFiles(root));
};

/** Runs `command` to its end without blocking the worker, so the cases of this file can run side by side. */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

async function invoke(overrides: Record<string, string> = {}, args: string[] = [], prepare?: (root: string) => void) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "recordstuff-local-sign-")));
  const root = path.join(dir, "project with spaces");
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "calls.jsonl");
  try {
    mkdirSync(path.join(root, "scripts/lib/runner"), { recursive: true });
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/main.ts"), "export {};\n");
    copyFileSync(path.resolve("scripts/lib/runner/runtime-inputs.mjs"), path.join(root, "scripts/lib/runner/runtime-inputs.mjs"));
    mkdirSync(bin);
    const electron = path.join(root, "node_modules/.pnpm/electron@fixture/node_modules/electron");
    mkdirSync(path.join(electron, "dist/Electron.app/Contents/MacOS"), { recursive: true });
    writeFileSync(path.join(electron, "dist/Electron.app/Contents/MacOS/Electron"), "");
    symlinkSync(electron, path.join(root, "node_modules/electron"));
    copyFileSync(path.resolve("scripts/start-app.mjs"), path.join(root, "scripts/start-app.mjs"));
    if (args.includes("--open") || args.includes("--verify-app")) {
      mkdirSync(path.join(root, "dist", process.arch === "arm64" ? "mac-arm64" : "mac",
        "RecordStuff.app/Contents/Frameworks/RecordStuff Helper.app/Contents"), { recursive: true });
    }
    prepare?.(root);
    writeFileSync(calls, "");
    const stub = path.join(dir, "stub.cjs");
    writeFileSync(stub, `
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[2]);
const args = process.argv.slice(3);
const env = process.env;
fs.appendFileSync(env.CALLS, JSON.stringify({ name, args, nodeMode: env.ELECTRON_RUN_AS_NODE, releaseSecret: env.CSC_LINK || env.APPLE_API_KEY, discovery: env.CSC_IDENTITY_AUTO_DISCOVERY }) + '\\n');
if (env.FAIL_COMMAND === name || (env.FAIL_VERIFY && name === 'codesign' && args[0] === '--verify')) process.exit(2);
if (env.FAIL_SIGN && name === 'codesign' && args[0] === '--force') { process.stderr.write(env.FAIL_SIGN + '\\n'); process.exit(1); }
if (name === 'ditto') fs.mkdirSync(path.join(args[1], 'Contents/Frameworks/Electron Helper.app/Contents'), { recursive: true });
if (name === 'pgrep' && env.PGREP_STATUS3) {
  // The first PGREP_STATUS3 calls fail as macOS pgrep does while the process table changes.
  const count = path.join(path.dirname(env.CALLS), 'pgrep-count');
  const seen = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0;
  fs.writeFileSync(count, String(seen + 1));
  if (seen < Number(env.PGREP_STATUS3)) { process.stderr.write('pgrep: Cannot get process list\\n'); process.exit(3); }
}
if (name === 'pgrep') {
  const running = (env.RUNNING || '').replaceAll('{root}', env.ROOT);
  process.exit(running && new RegExp(args[1]).test(running) ? 0 : 1);
}
if (name === 'security' && args[0] === 'find-identity') {
  process.stdout.write(env.IDENTITIES ?? '  1) ' + env.HASH + ' "RecordStuff Dev"\\n  1 valid identities found\\n');
}
if (name === 'security' && args[0] === 'find-certificate') process.stdout.write(fs.readFileSync(env.PUBLIC_CERT));
if (name === 'pnpm' && args.includes('--dir')) {
  const output = args.find(arg => arg.startsWith('-c.directories.output=')).split('=')[1];
  fs.mkdirSync(path.join(env.ROOT, output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'RecordStuff.app/Contents/Frameworks/RecordStuff Helper.app/Contents'), { recursive: true });
}
if (name === 'codesign' && args.some(arg => arg.startsWith('--extract-certificates='))) {
  const bundle = args.at(-1);
  const isHelper = bundle.endsWith('Helper.app');
  const cert = env.WRONG_CERT === 'outer' && !isHelper || env.WRONG_CERT === 'helper' && isHelper ? env.OTHER_CERT : env.PUBLIC_CERT;
  if (env.ADHOC) process.stderr.write('Signature=adhoc\\n');
  else fs.copyFileSync(cert, args.find(arg => arg.startsWith('--extract-certificates=')).slice('--extract-certificates='.length) + '0');
  const outer = bundle.endsWith('Electron.app') ? 'com.github.Electron' : 'com.ericts.record';
  process.stderr.write('Identifier=' + (env.WRONG_ID || (isHelper ? outer + '.helper' : outer)) + '\\n');
  process.stderr.write('CodeDirectory v=20500 flags=0x10000(' + (env.NO_RUNTIME ? '' : 'runtime') + ')\\n');
}
if (name === 'codesign' && args.includes('-r-')) {
  const id = args.at(-1).endsWith('Electron.app') ? 'com.github.Electron' : 'com.ericts.record';
  process.stderr.write(env.WRONG_REQUIREMENT ? 'designated => cdhash H"abcd"\\n' : 'designated => identifier "' + id + '" and certificate leaf = H"' + env.HASH.toLowerCase() + '"\\n');
}
`);
    const wrapper = path.join(bin, "wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nexec "$TEST_NODE" "$TEST_STUB" "$0" "$@"\n', { mode: 0o755 });
    const testNode = path.join(dir, "node with spaces");
    symlinkSync(process.execPath, testNode);
    for (const name of ["pgrep", "security", "pnpm", "codesign", "open", "ditto"]) symlinkSync(wrapper, path.join(bin, name));
    const clock = path.join(dir, "clock.mjs");
    writeFileSync(clock, 'if (process.env.TEST_NOW) Date.now = () => Number(process.env.TEST_NOW);');
    const result = await run(process.execPath, ["--import", clock, path.join(root, "scripts/start-app.mjs"), ...args], {
      cwd: root,
      env: {
        ...process.env, PATH: bin, CALLS: calls, ROOT: root, TEST_NODE: testNode, TEST_STUB: stub,
        HASH: hash, PUBLIC_CERT: path.join(fixtures, "selected.pem"), OTHER_CERT: path.join(fixtures, "other.pem"),
        ELECTRON_RUN_AS_NODE: "1", CSC_LINK: "must-not-import", APPLE_API_KEY: "must-not-notarize",
        RECORDSTUFF_SIGN_IDENTITY: "RecordStuff Dev",
        // Never an outer recipe's file: this run's phases are not the outer phase's.
        RECORDSTUFF_TIMING_FILE: path.join(dir, "timing.jsonl"), ...overrides,
      },
    });
    const timing = existsSync(path.join(dir, "timing.jsonl"))
      ? readFileSync(path.join(dir, "timing.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { runner: string; phase: string; ok: boolean })
      : [];
    const commands: Call[] = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let stamp: { inputs: string; files: Record<string, string> } | undefined;
    try { stamp = JSON.parse(readFileSync(buildStampPath(appDir(root)), "utf8")); } catch { stamp = undefined; }
    const fixtureReport = existsSync(path.join(root, "round/signature.json"))
      ? JSON.parse(readFileSync(path.join(root, "round/signature.json"), "utf8")) as Record<string, unknown> : undefined;
    return { ...result, commands, stamp, timing, fixtureReport };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectNoDelivery(result: Awaited<ReturnType<typeof invoke>>) {
  expect(result.status).toBe(1);
  expect(result.commands.some(call => call.name === "open" || call.args.includes("--prepackaged"))).toBe(false);
}

describe.skipIf(process.platform !== "darwin")("local self-signed app/DMG", { concurrent: true }, () => {
  beforeAll(() => {
    fixtures = mkdtempSync(path.join(tmpdir(), "recordstuff-test-certificates-"));
    hash = certificate("selected");
    otherHash = certificate("other");
    certificate("ca", true);
    for (const args of [
      ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=issued", "-keyout", path.join(fixtures, "issued.key"), "-out", path.join(fixtures, "issued.csr")],
      ["x509", "-req", "-in", path.join(fixtures, "issued.csr"), "-CA", path.join(fixtures, "ca.pem"), "-CAkey", path.join(fixtures, "ca.key"), "-set_serial", "2", "-days", "30", "-extfile", path.join(fixtures, "selected.cnf"), "-extensions", "ext", "-out", path.join(fixtures, "issued.pem")],
    ]) {
      const result = spawnSync("/usr/bin/openssl", args, { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    issuedHash = new X509Certificate(readFileSync(path.join(fixtures, "issued.pem"))).fingerprint.replaceAll(":", "");
  });
  afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

  it.each([
    "/Applications/RecordStuff.app/Contents/MacOS/RecordStuff",
    "{root}/dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff",
    "{root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron {root}",
    "{root}/node_modules/.pnpm/electron@fixture/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron {root}",
  ])("blocks competing main process before touching the keychain: %s", async (running) => {
    const result = await invoke({ RUNNING: running });
    expectNoDelivery(result);
    expect(result.commands.map(call => call.name)).toEqual(["pgrep"]);
  });

  it.each(["", '  1) FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF "Other"\n'])
    ("refuses missing or invalid identities", async identities => {
      const result = await invoke({ IDENTITIES: identities });
      expectNoDelivery(result);
      expect(result.stderr).toContain("found 0");
      expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
    });

  it("rejects duplicate names even when selecting the exact fingerprint", async () => {
    const identities = ` 1) ${hash} "RecordStuff Dev"\n 2) ${otherHash} "RecordStuff Dev"\n`;
    const ambiguous = await invoke({ IDENTITIES: identities });
    expectNoDelivery(ambiguous);
    expect(ambiguous.stderr).toContain("found 2");
    const pinned = await invoke({ IDENTITIES: identities, RECORDSTUFF_SIGN_IDENTITY: hash.toLowerCase() });
    expectNoDelivery(pinned);
    expect(pinned.stderr).toContain("name is duplicated");
    expect(pinned.commands.some(call => call.name === "pnpm")).toBe(false);
    expect((await invoke({ RECORDSTUFF_SIGN_IDENTITY: hash.toLowerCase() })).status).toBe(0);
  });

  it("rejects an issued certificate even when security lists it as valid", async () => {
    const result = await invoke({ IDENTITIES: ` 1) ${issuedHash} "RecordStuff Dev"\n`, PUBLIC_CERT: path.join(fixtures, "issued.pem") });
    expectNoDelivery(result);
    expect(result.stderr).toContain("require a self-signed certificate");
    expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
  });

  it("rejects a public certificate that does not match the selected identity", async () => {
    const result = await invoke({ PUBLIC_CERT: path.join(fixtures, "other.pem") });
    expectNoDelivery(result);
    expect(result.stderr).toContain("Could not find the public certificate matching");
  });

  it("rejects an empty explicit selector instead of using the default", async () => {
    expectNoDelivery(await invoke({ RECORDSTUFF_SIGN_IDENTITY: " " }));
  });

  it("checks certificate validity independently of security output", async () => {
    const cert = new X509Certificate(readFileSync(path.join(fixtures, "selected.pem")));
    for (const now of [Date.parse(cert.validFrom) - 1000, Date.parse(cert.validTo) + 1000]) {
      const result = await invoke({ TEST_NOW: String(now) });
      expectNoDelivery(result);
      expect(result.stderr).toContain("expired or not yet valid");
      expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
    }
  });

  it.each(["outer", "helper"])("blocks a valid bundle signed with the wrong %s certificate", async wrong => {
    const result = await invoke({ WRONG_CERT: wrong }, ["--dmg"]);
    expectNoDelivery(result);
    expect(result.stderr).toContain("Unexpected signing certificate");
  });

  it.each([
    { ADHOC: "1" }, { NO_RUNTIME: "1" }, { WRONG_ID: "com.other.app" }, { FAIL_VERIFY: "1" }, { WRONG_REQUIREMENT: "1" },
  ])("rejects ad-hoc, missing runtime, wrong identifier or damaged signatures: %j", async overrides => {
    expectNoDelivery(await invoke(overrides));
  });

  it.each(["pgrep", "security", "pnpm"])("stops on a %s failure without opening an old app", async command => {
    expectNoDelivery(await invoke({ FAIL_COMMAND: command }));
  });

  it("asks pgrep again after a passing internal error, and names the error when it persists", async () => {
    const passing = await invoke({ PGREP_STATUS3: "2" });
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.commands.filter(call => call.name === "pgrep")).toHaveLength(3);
    const persistent = await invoke({ PGREP_STATUS3: "3" });
    expectNoDelivery(persistent);
    expect(persistent.stderr).toContain("Could not check for a running RecordStuff.app (pgrep exit 3: pgrep: Cannot get process list).");
    expect(persistent.commands.map(call => call.name)).toEqual(["pgrep", "pgrep", "pgrep"]);
  });

  it("is not blocked by a process that only names this checkout's Electron in its arguments", async () => {
    const result = await invoke({ RUNNING: "/usr/bin/tail -f {root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.at(-1)?.name).toBe("open");
  });

  it("opens verified outer and helper bundles, supports spaces, and excludes release credentials", async () => {
    const result = await invoke({ RUNNING: "/Applications/Other.app/Contents/MacOS/Electron" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.at(-1)?.name).toBe("open");
    const guard = result.commands.find(call => call.name === "pgrep")!;
    // macOS pgrep uses POSIX ERE, unlike the JavaScript matching in the stub.
    const nativeGuard = spawnSync("/usr/bin/pgrep", guard.args, { encoding: "utf8" });
    expect([0, 1], nativeGuard.stderr).toContain(nativeGuard.status);
    expect(result.commands.filter(call => call.args.some(arg => arg.startsWith("--extract-certificates=")))).toHaveLength(2);
    const builder = result.commands.find(call => call.args.includes("--dir"));
    expect(builder?.args).toContain(`-c.mac.identity=${hash}`);
    expect(builder?.args).toContain("-c.mac.notarize=false");
    expect(builder?.args).toContain("-c.mac.timestamp=none");
    expect(builder?.args).toContain("never");
    expect(builder?.args).toContain("electron-builder.local.yml");
    expect(result.commands.every(call => call.nodeMode === undefined && call.releaseSecret === undefined && call.discovery === "false")).toBe(true);
  });

  it("builds a DMG from the verified app only and does not launch or publish", async () => {
    const result = await invoke({}, ["--dmg"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.some(call => call.name === "open")).toBe(false);
    const final = result.commands.at(-1);
    expect(final?.name).toBe("pnpm");
    expect(final?.args).toContain("--prepackaged");
    expect(final?.args).toContain("-c.directories.output=dist");
    expect(final?.args).toContain("never");
  });

  it("reopens a verified existing build without rebuilding its TCC identity", async () => {
    const result = await invoke({}, ["--open"], stamped);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
    expect(result.commands.at(-1)?.name).toBe("open");
    expect(result.stdout).toMatch(/Timing: preflight \d+\.\d\d s, freshness \d+\.\d\d s, verify \d+\.\d\d s, open \d+\.\d\d s/);
    expectNoDelivery(await invoke({ WRONG_CERT: "outer" }, ["--open"], stamped));
  });

  it("records the inputs of a verified build, and only after verification", async () => {
    const built = await invoke();
    expect(built.status, built.stderr).toBe(0);
    expect(built.stamp?.files["src/main.ts"]).toMatch(/^[\da-f]{64}$/);
    expect(built.stdout).toMatch(/Timing: preflight .* build .* package .* verify .* open /);
    expect(built.timing.map(({ runner, phase, ok }) => `${runner}:${phase}:${ok}`))
      .toEqual(["start-app:preflight:true", "start-app:build:true", "start-app:package:true", "start-app:verify:true", "start-app:open:true"]);
    // A stale record from an earlier build is removed before rebuilding, even when verification then fails.
    const failed = await invoke({ FAIL_VERIFY: "1" }, [], stamped);
    expect(failed.stamp).toBeUndefined();
    expect(failed.timing.at(-1)).toMatchObject({ phase: "verify", ok: false });
  });

  it.each([
    ["no build record", (): void => undefined, "has no build record"],
    ["a changed source", (root: string): void => { stamped(root); writeFileSync(path.join(root, "src/main.ts"), "export const changed = 1;\n"); }, "src/main.ts"],
    ["a new source", (root: string): void => { stamped(root); writeFileSync(path.join(root, "src/extra.ts"), "export {};\n"); }, "src/extra.ts"],
  ])("refuses to reopen a bundle with %s", async (_label, prepare, reason) => {
    const result = await invoke({}, ["--open"], prepare);
    expectNoDelivery(result);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain("pnpm start:app");
    expect(result.commands.some(call => call.name === "codesign")).toBe(false);
  });

  it("reopens after a change that cannot reach the bundle", async () => {
    const result = await invoke({}, ["--open"], (root) => {
      stamped(root);
      writeFileSync(path.join(root, "src/main.test.ts"), "// test only\n");
      writeFileSync(path.join(root, "scripts/helper.mts"), "// tooling only\n");
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.at(-1)?.name).toBe("open");
  });

  it("verifies a packaged App without private keys, building or launching", async () => {
    const app = `dist/${process.arch === "arm64" ? "mac-arm64" : "mac"}/RecordStuff.app`;
    const result = await invoke({ RECORDSTUFF_SIGN_IDENTITY: hash }, ["--verify-app", app]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.every(call => call.name === "codesign")).toBe(true);
    expectNoDelivery(await invoke({ RECORDSTUFF_SIGN_IDENTITY: hash, WRONG_CERT: "helper" }, ["--verify-app", app]));
    expectNoDelivery(await invoke({ RECORDSTUFF_SIGN_IDENTITY: hash, FAIL_VERIFY: "1" }, ["--verify-app", app]));
    expectNoDelivery(await invoke({}, ["--verify-app", app]));
  });

  describe("signed Electron copy for the quit-dialog fixture (plan 062)", () => {
    const fixtureArgs = ["--fixture-app", "round/Electron.app", "round/signature.json"];
    const round = (root: string): void => { mkdirSync(path.join(root, "round")); };
    const fixture = (overrides: Record<string, string> = {}) => invoke(overrides, fixtureArgs, round);
    const signed = (result: Awaited<ReturnType<typeof invoke>>): boolean => result.commands.some(call => call.name === "codesign" && call.args[0] === "--force");

    it("copies, fully signs and verifies the copy, then reports its provenance", async () => {
      const result = await fixture();
      expect(result.status, result.stderr).toBe(0);
      expect(result.commands.map(call => call.name)).toEqual(["security", "security", "ditto", "codesign", "codesign", "codesign", "codesign", "codesign"]);
      const ditto = result.commands.find(call => call.name === "ditto")!;
      expect(ditto.args[0]).toMatch(/node_modules\/\.pnpm\/electron@fixture\/node_modules\/electron\/dist\/Electron\.app$/);
      expect(ditto.args[1]).toMatch(/round\/Electron\.app$/);
      expect(result.commands.find(call => call.args[0] === "--force")?.args).toEqual(
        ["--force", "--deep", "--timestamp=none", "--sign", hash.toUpperCase(), ditto.args[1]]);
      expect(result.commands.some(call => call.args.join(" ") === `--verify --deep --strict ${ditto.args[1]}`)).toBe(true);
      expect(result.fixtureReport).toMatchObject({ bundleIdentifier: "com.github.Electron", bundles: 2,
        certificate: { sha1: hash.toUpperCase(), name: "RecordStuff Dev" },
        designatedRequirement: `designated => identifier "com.github.Electron" and certificate leaf = H"${hash.toLowerCase()}"` });
      expect(result.timing.map(({ phase, ok }) => `${phase}:${ok}`)).toEqual(["preflight:true", "copy:true", "sign:true", "verify:true"]);
      // Never the normal bundle, its build record, the running-app guard or a launch.
      expect(result.commands.some(call => ["pgrep", "pnpm", "open"].includes(call.name))).toBe(false);
      expect(result.stamp).toBeUndefined();
    });

    it.each([
      ["missing", { IDENTITIES: "" }, "found 0"],
      ["ambiguous", { IDENTITIES: ` 1) ${"A".repeat(40)} "RecordStuff Dev"\n 2) ${"B".repeat(40)} "RecordStuff Dev"\n` }, "found 2"],
      ["expired", { TEST_NOW: String(Date.now() + 365 * 86_400_000) }, "expired or not yet valid"],
      ["inaccessible", { FAIL_COMMAND: "security" }, "security failed"],
    ])("is blocked (exit 2) by a %s identity before copying or signing", async (_label, overrides, reason) => {
      const result = await fixture(overrides);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(reason);
      expect(result.commands.some(call => call.name === "ditto" || call.name === "codesign")).toBe(false);
      expect(result.fixtureReport).toBeUndefined();
    });

    it("is blocked when codesign cannot use the key without user permission", async () => {
      const result = await fixture({ FAIL_SIGN: "errSecInternalComponent" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("not usable without user permission");
      expect(result.fixtureReport).toBeUndefined();
    });

    it.each([
      ["a signing failure", { FAIL_SIGN: "resource fork, Finder information, or similar detritus not allowed" }, "codesign failed"],
      ["an ad-hoc signature", { ADHOC: "1" }, "Ad-hoc signature"],
      ["a damaged bundle", { FAIL_VERIFY: "1" }, "codesign failed"],
      ["the wrong outer certificate", { WRONG_CERT: "outer" }, "Unexpected signing certificate"],
      ["the wrong helper certificate", { WRONG_CERT: "helper" }, "Unexpected signing certificate"],
      ["a changed identifier", { WRONG_ID: "com.ericts.record" }, "incorrect bundle identifier"],
      ["the wrong designated requirement", { WRONG_REQUIREMENT: "1" }, "designated requirement"],
    ])("fails (exit 1) after a valid identity on %s and writes no report", async (_label, overrides, reason) => {
      const result = await fixture(overrides);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(reason);
      expect(signed(result)).toBe(true);
      expect(result.fixtureReport).toBeUndefined();
      expect(result.timing.at(-1)?.ok).toBe(false);
    });

    it("does not require the hardened runtime the RecordStuff bundle needs", async () => {
      expect((await fixture({ NO_RUNTIME: "1" })).status).toBe(0);
    });

    it.each([
      [["--fixture-app", "round/Electron.app"]],
      [["--fixture-app", "round/Electron", "round/signature.json"]],
      [["--fixture-app", "missing/Electron.app", "round/signature.json"]],
    ])("rejects bad arguments before the keychain: %j", async args => {
      const result = await invoke({}, args, round);
      expect(result.status).toBe(1);
      expect(result.commands).toEqual([]);
    });
  });

  it("rejects unsupported arguments without side effects", async () => {
    const result = await invoke({}, ["--publish"]);
    expectNoDelivery(result);
    expect(result.commands).toEqual([]);
  });
});
