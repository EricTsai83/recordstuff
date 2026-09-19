import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

function invoke(overrides: Record<string, string> = {}, args: string[] = []) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "recordstuff-local-sign-")));
  const root = path.join(dir, "project with spaces");
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "calls.jsonl");
  try {
    mkdirSync(path.join(root, "scripts"), { recursive: true });
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
  if (!env.ADHOC) fs.copyFileSync(cert, args.find(arg => arg.startsWith('--extract-certificates=')).slice('--extract-certificates='.length) + '0');
  process.stderr.write('Identifier=' + (env.WRONG_ID || (isHelper ? 'com.ericts.record.helper' : 'com.ericts.record')) + '\\n');
  process.stderr.write('CodeDirectory v=20500 flags=0x10000(' + (env.NO_RUNTIME ? '' : 'runtime') + ')\\n');
}
if (name === 'codesign' && args.includes('-r-')) process.stderr.write(env.WRONG_REQUIREMENT ? 'designated => cdhash H"abcd"\\n' : 'designated => identifier "com.ericts.record" and certificate leaf = H"' + env.HASH.toLowerCase() + '"\\n');
`);
    const wrapper = path.join(bin, "wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nexec "$TEST_NODE" "$TEST_STUB" "$0" "$@"\n', { mode: 0o755 });
    const testNode = path.join(dir, "node with spaces");
    symlinkSync(process.execPath, testNode);
    for (const name of ["pgrep", "security", "pnpm", "codesign", "open"]) symlinkSync(wrapper, path.join(bin, name));
    const clock = path.join(dir, "clock.mjs");
    writeFileSync(clock, 'if (process.env.TEST_NOW) Date.now = () => Number(process.env.TEST_NOW);');
    const result = spawnSync(process.execPath, ["--import", clock, path.join(root, "scripts/start-app.mjs"), ...args], {
      encoding: "utf8", cwd: root,
      env: {
        ...process.env, PATH: bin, CALLS: calls, ROOT: root, TEST_NODE: testNode, TEST_STUB: stub,
        HASH: hash, PUBLIC_CERT: path.join(fixtures, "selected.pem"), OTHER_CERT: path.join(fixtures, "other.pem"),
        ELECTRON_RUN_AS_NODE: "1", CSC_LINK: "must-not-import", APPLE_API_KEY: "must-not-notarize",
        RECORDSTUFF_SIGN_IDENTITY: "RecordStuff Dev", ...overrides,
      },
    });
    const commands: Call[] = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, commands };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectNoDelivery(result: ReturnType<typeof invoke>) {
  expect(result.status).toBe(1);
  expect(result.commands.some(call => call.name === "open" || call.args.includes("--prepackaged"))).toBe(false);
}

describe.skipIf(process.platform !== "darwin")("local self-signed app/DMG", () => {
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
  ])("blocks competing main process before touching the keychain: %s", (running) => {
    const result = invoke({ RUNNING: running });
    expectNoDelivery(result);
    expect(result.commands.map(call => call.name)).toEqual(["pgrep"]);
  });

  it.each(["", '  1) FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF "Other"\n'])
    ("refuses missing or invalid identities", identities => {
      const result = invoke({ IDENTITIES: identities });
      expectNoDelivery(result);
      expect(result.stderr).toContain("found 0");
      expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
    });

  it("rejects duplicate names even when selecting the exact fingerprint", () => {
    const identities = ` 1) ${hash} "RecordStuff Dev"\n 2) ${otherHash} "RecordStuff Dev"\n`;
    const ambiguous = invoke({ IDENTITIES: identities });
    expectNoDelivery(ambiguous);
    expect(ambiguous.stderr).toContain("found 2");
    const pinned = invoke({ IDENTITIES: identities, RECORDSTUFF_SIGN_IDENTITY: hash.toLowerCase() });
    expectNoDelivery(pinned);
    expect(pinned.stderr).toContain("name is duplicated");
    expect(pinned.commands.some(call => call.name === "pnpm")).toBe(false);
    expect(invoke({ RECORDSTUFF_SIGN_IDENTITY: hash.toLowerCase() }).status).toBe(0);
  });

  it("rejects an issued certificate even when security lists it as valid", () => {
    const result = invoke({ IDENTITIES: ` 1) ${issuedHash} "RecordStuff Dev"\n`, PUBLIC_CERT: path.join(fixtures, "issued.pem") });
    expectNoDelivery(result);
    expect(result.stderr).toContain("require a self-signed certificate");
    expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
  });

  it("rejects a public certificate that does not match the selected identity", () => {
    const result = invoke({ PUBLIC_CERT: path.join(fixtures, "other.pem") });
    expectNoDelivery(result);
    expect(result.stderr).toContain("Could not find the public certificate matching");
  });

  it("rejects an empty explicit selector instead of using the default", () => {
    expectNoDelivery(invoke({ RECORDSTUFF_SIGN_IDENTITY: " " }));
  });

  it("checks certificate validity independently of security output", () => {
    const cert = new X509Certificate(readFileSync(path.join(fixtures, "selected.pem")));
    for (const now of [Date.parse(cert.validFrom) - 1000, Date.parse(cert.validTo) + 1000]) {
      const result = invoke({ TEST_NOW: String(now) });
      expectNoDelivery(result);
      expect(result.stderr).toContain("expired or not yet valid");
      expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
    }
  });

  it.each(["outer", "helper"])("blocks a valid bundle signed with the wrong %s certificate", wrong => {
    const result = invoke({ WRONG_CERT: wrong }, ["--dmg"]);
    expectNoDelivery(result);
    expect(result.stderr).toContain("Unexpected signing certificate");
  });

  it.each([
    { ADHOC: "1" }, { NO_RUNTIME: "1" }, { WRONG_ID: "com.other.app" }, { FAIL_VERIFY: "1" }, { WRONG_REQUIREMENT: "1" },
  ])("rejects ad-hoc, missing runtime, wrong identifier or damaged signatures: %j", overrides => {
    expectNoDelivery(invoke(overrides));
  });

  it.each(["pgrep", "security", "pnpm"])("stops on a %s failure without opening an old app", command => {
    expectNoDelivery(invoke({ FAIL_COMMAND: command }));
  });

  it("opens verified outer and helper bundles, supports spaces, and excludes release credentials", () => {
    const result = invoke({ RUNNING: "/Applications/Other.app/Contents/MacOS/Electron" });
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

  it("builds a DMG from the verified app only and does not launch or publish", () => {
    const result = invoke({}, ["--dmg"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.some(call => call.name === "open")).toBe(false);
    const final = result.commands.at(-1);
    expect(final?.name).toBe("pnpm");
    expect(final?.args).toContain("--prepackaged");
    expect(final?.args).toContain("-c.directories.output=dist");
    expect(final?.args).toContain("never");
  });

  it("reopens a verified existing build without rebuilding its TCC identity", () => {
    const result = invoke({}, ["--open"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.some(call => call.name === "pnpm")).toBe(false);
    expect(result.commands.at(-1)?.name).toBe("open");
    expectNoDelivery(invoke({ WRONG_CERT: "outer" }, ["--open"]));
  });

  it("verifies a packaged App without private keys, building or launching", () => {
    const app = `dist/${process.arch === "arm64" ? "mac-arm64" : "mac"}/RecordStuff.app`;
    const result = invoke({ RECORDSTUFF_SIGN_IDENTITY: hash }, ["--verify-app", app]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.every(call => call.name === "codesign")).toBe(true);
    expectNoDelivery(invoke({ RECORDSTUFF_SIGN_IDENTITY: hash, WRONG_CERT: "helper" }, ["--verify-app", app]));
    expectNoDelivery(invoke({ RECORDSTUFF_SIGN_IDENTITY: hash, FAIL_VERIFY: "1" }, ["--verify-app", app]));
    expectNoDelivery(invoke({}, ["--verify-app", app]));
  });

  it("rejects unsupported arguments without side effects", () => {
    const result = invoke({}, ["--publish"]);
    expectNoDelivery(result);
    expect(result.commands).toEqual([]);
  });
});
