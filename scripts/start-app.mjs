// Self-signed app/DMG for development and macOS releases, and the signed Electron copy of the quit-dialog fixture.
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { removeBuildStamp, runtimeInputFiles, staleBundleReason, writeBuildStamp } from "./lib/runner/runtime-inputs.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
// Never import a release certificate, contact notarization or publish from this flow.
for (const key of Object.keys(env)) {
  if (/^(?:CSC_|WIN_CSC_|APPLE_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
}
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

/** A missing, ambiguous, expired or inaccessible signing identity: the caller's round is blocked, not failed (exit 2). */
class BlockedError extends Error {}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    // As release.mts failureReason: an empty captured stderr must not leave the reason blank.
    const reason = result.error?.message ?? (result.stderr?.trim() || (result.signal ? `killed by ${result.signal}` : `exit status ${result.status}`));
    throw new Error(`${command} failed: ${reason}`);
  }
  return result;
}

// Phase durations for `pnpm acceptance:recipe` (scripts/lib/runner/verification-timing.mts) and the console.
const timings = [];
function timed(phase, action) {
  const start = performance.now();
  let ok = false;
  try {
    const value = action();
    ok = true;
    return value;
  } finally {
    const ms = Math.round(performance.now() - start);
    timings.push({ phase, ms, ok });
    if (process.env.RECORDSTUFF_TIMING_FILE) {
      appendFileSync(process.env.RECORDSTUFF_TIMING_FILE, `${JSON.stringify({ runner: "start-app", phase, ms, ok })}\n`);
    }
  }
}

const fingerprint = (cert) => cert.fingerprint.replaceAll(":", "").toUpperCase();

function checkCertificate(cert) {
  const now = Date.now();
  if (now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo)) {
    throw new Error("The selected certificate is expired or not yet valid.");
  }
  // A self-signed Code Signing leaf need not have CA/keyCertSign privileges.
  if (cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) {
    throw new Error("Local builds require a self-signed certificate, not an Apple/release identity.");
  }
}

function resolveIdentity() {
  const selector = (process.env.RECORDSTUFF_SIGN_IDENTITY ?? "RecordStuff Dev").trim();
  if (!selector) throw new Error("RECORDSTUFF_SIGN_IDENTITY must be an exact certificate name or SHA-1 fingerprint.");
  const output = run("security", ["find-identity", "-v", "-p", "codesigning"], true).stdout;
  const identities = new Map();
  const allIdentities = new Map();
  for (const match of output.matchAll(/^\s*\d+\)\s+([\da-f]{40})\s+"([^"]+)"\s*$/gmi)) {
    const hash = match[1].toUpperCase();
    allIdentities.set(hash, match[2]);
    if (match[2] === selector || hash === selector.toUpperCase()) identities.set(hash, match[2]);
  }
  if (identities.size !== 1) {
    throw new Error(`Expected one valid signing identity for ${JSON.stringify(selector)}, found ${identities.size}. Check its private key/trust/expiry and use a uniquely named certificate.`);
  }
  const [hash, name] = [...identities][0];
  // electron-builder selects by hash but passes the name to osx-sign/codesign.
  if ([...allIdentities.values()].filter(value => value === name).length !== 1) {
    throw new Error("The signing certificate name is duplicated. Use a certificate with a unique name; electron-builder signs by name even when selected by SHA-1.");
  }
  const pem = run("security", ["find-certificate", "-a", "-p", "-c", name], true).stdout;
  const cert = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])
    .map((value) => new X509Certificate(value)).find((value) => fingerprint(value) === hash);
  if (!cert) throw new Error("Could not find the public certificate matching the selected signing identity.");
  checkCertificate(cert);
  return { hash, name, expires: cert.validTo };
}

function assertNotRunning() {
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const electronPath = path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  // pnpm's symlink is resolved in the actual process command line.
  const electronPaths = [...new Set([electronPath, realpathSync(electronPath)])];
  const pgrep = () => spawnSync("pgrep", ["-f",
    // Anchored like `recordStuffPattern` and `electronPattern` (lib/processes.mts): only a process running this executable, not one naming it.
    `^/([^ ]| [^/])*/RecordStuff\\.app/Contents/MacOS/RecordStuff($| )|^(${electronPaths.map(escapeRegex).join("|")})($| )`,
  ], { env, encoding: "utf8" });
  // As `pgrepLines` (lib/processes.mts), which this file cannot import: macOS pgrep can fail with status 3 while the
  // process table changes under it, as when a runner has just quit the app, so it is asked twice more before that counts.
  let result = pgrep();
  for (let attempt = 1; attempt < 3 && !result.error && ![0, 1].includes(result.status); attempt += 1) result = pgrep();
  if (result.error || ![0, 1].includes(result.status)) {
    const why = result.error?.message ?? `pgrep exit ${result.status ?? result.signal}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ""}`;
    throw new Error(`Could not check for a running RecordStuff.app (${why}).`);
  }
  if (result.status === 0) {
    throw new Error("Quit RecordStuff.app and this project's Electron.app from their menus before rebuilding (stop and save any recording first).");
  }
}

/**
 * Rejects a bundle unless every app/framework is signed by the selected certificate. The
 * defaults are the RecordStuff bundle's; the quit-dialog fixture's Electron copy keeps
 * Electron's identifier and runs without the hardened runtime.
 */
function verifyBundle(appPath, identity, { identifier = "com.ericts.record", runtime = true } = {}) {
  run("codesign", ["--verify", "--deep", "--strict", appPath]);
  // Check the outer app and all nested app/framework bundles, without following symlinks.
  const bundles = [appPath];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (/\.(app|framework)$/.test(entry.name)) bundles.push(child);
      walk(child);
    }
  }
  walk(path.join(appPath, "Contents"));
  const scratch = mkdtempSync(path.join(tmpdir(), "recordstuff-signature-"));
  try {
    for (const [index, bundle] of bundles.entries()) {
      const prefix = path.join(scratch, `${index}-cert`);
      const details = run("codesign", ["-d", "--verbose=4", `--extract-certificates=${prefix}`, bundle], true).stderr;
      if (/^Signature=adhoc$/m.test(details)) throw new Error(`Ad-hoc signature, not the selected identity: ${bundle}`);
      const cert = new X509Certificate(readFileSync(`${prefix}0`));
      if (fingerprint(cert) !== identity.hash) throw new Error(`Unexpected signing certificate: ${bundle}`);
      checkCertificate(cert);
      const found = /^Identifier=(.+)$/m.exec(details)?.[1];
      if (!found || (index === 0 && found !== identifier)) throw new Error(`Missing or incorrect bundle identifier: ${bundle}`);
      if (runtime && bundle.endsWith(".app") && !/^CodeDirectory .*flags=.*\bruntime\b/m.test(details)) {
        throw new Error(`Hardened runtime is missing: ${bundle}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const requirement = run("codesign", ["-d", "-r-", appPath], true);
  const expected = `designated => identifier "${identifier}" and certificate leaf = H"${identity.hash.toLowerCase()}"`;
  if (!`${requirement.stdout}${requirement.stderr}`.split(/\r?\n/).includes(expected)) {
    throw new Error("Unexpected designated requirement; refusing to open or package this app.");
  }
  console.log(`Verified ${bundles.length} bundle identities; SHA-1 ${identity.hash}\n${requirement.stdout}${requirement.stderr}`);
  return { bundles: bundles.length, designatedRequirement: expected };
}

/** codesign's errors when the private key cannot be used without a person: locked keychain, denied or pending access. */
const keychainUnavailable = /errSecInternalComponent|User interaction is not allowed|user canceled|errSecAuthFailed|errSecInteractionNotAllowed/i;

/**
 * Plan 062: a private, fully signed copy of this checkout's Electron.app for the synthetic
 * quit-dialog fixture, whose linker/ad-hoc signature macOS refuses to notify for. Only the
 * copy is touched; the caller owns `destination`'s directory and removes it after the round.
 */
function prepareFixtureApp(destination, reportPath) {
  if (!destination.endsWith(".app") || existsSync(destination) || !existsSync(path.dirname(destination))) {
    throw new Error("--fixture-app needs a new .app path inside an existing directory.");
  }
  let identity;
  try {
    identity = timed("preflight", resolveIdentity);
  } catch (error) {
    throw new BlockedError(error instanceof Error ? error.message : String(error));
  }
  const source = realpathSync(path.join(root, "node_modules/electron/dist/Electron.app"));
  timed("copy", () => run("ditto", [source, destination]));
  timed("sign", () => {
    try {
      run("codesign", ["--force", "--deep", "--timestamp=none", "--sign", identity.hash, destination], true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (keychainUnavailable.test(message)) throw new BlockedError(`The signing key is not usable without user permission: ${message}`);
      throw error;
    }
  });
  const identifier = "com.github.Electron";
  const verified = timed("verify", () => verifyBundle(destination, identity, { identifier, runtime: false }));
  writeFileSync(reportPath, `${JSON.stringify({ source, appPath: destination, bundleIdentifier: identifier,
    certificate: { sha1: identity.hash, name: identity.name, expires: identity.expires }, ...verified }, null, 2)}\n`);
}

function main() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("Local app builds require macOS arm64 or x64. On Windows, `pnpm dist:win` builds the unsigned x64 installer.");
  }
  // `pnpm start:app -- --dmg` forwards the separator itself (runnerArgs in scripts/lib/runner/runner-env.mts).
  const args = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
  if (args[0] === "--verify-app") {
    const hash = process.env.RECORDSTUFF_SIGN_IDENTITY;
    if (args.length !== 2 || !/^[A-Fa-f0-9]{40}$/.test(hash ?? "")) {
      throw new Error("--verify-app requires an app path and RECORDSTUFF_SIGN_IDENTITY SHA-1.");
    }
    verifyBundle(path.resolve(args[1]), { hash: hash.toUpperCase() });
    return;
  }
  if (args[0] === "--fixture-app") {
    if (args.length !== 3) throw new Error("Usage: node scripts/start-app.mjs --fixture-app <new.app> <report.json>");
    prepareFixtureApp(path.resolve(args[1]), path.resolve(args[2]));
    return;
  }
  if (args.length > 1 || (args.length === 1 && !["--dmg", "--open"].includes(args[0]))) {
    throw new Error("Usage: node scripts/start-app.mjs [--dmg | --open]");
  }
  const dmg = args[0] === "--dmg";
  const identity = timed("preflight", () => {
    assertNotRunning();
    return resolveIdentity();
  });
  console.log(`Local signing: ${identity.name}; SHA-1 ${identity.hash}; expires ${identity.expires}`);
  // One output directory for development and release builds: the App is the same
  // signed bundle either way, and dist:mac only adds the DMG next to it.
  const output = "dist";
  const appPath = path.join(root, output, process.arch === "arm64" ? "mac-arm64" : "mac", "RecordStuff.app");
  const config = [
    "--config", "electron-builder.local.yml",
    `-c.directories.output=${output}`, `-c.mac.identity=${identity.hash}`,
    "-c.mac.notarize=false", "-c.mac.timestamp=none", "-c.forceCodeSigning=true",
  ];
  let inputs;
  if (args[0] === "--open") {
    // Reopening is only valid for the bundle the current sources would build.
    const stale = timed("freshness", () => staleBundleReason(root, appPath));
    if (stale) throw new Error(`Refusing to reopen ${appPath}: ${stale}. Rebuild it with \`pnpm start:app\`.`);
  } else {
    // A failed rebuild must not leave the previous bundle's record behind.
    removeBuildStamp(appPath);
    inputs = runtimeInputFiles(root);
    timed("build", () => run("pnpm", ["exec", "electron-vite", "build"]));
    timed("package", () => run("pnpm", ["exec", "electron-builder", "--dir", "--mac", `--${process.arch}`, "--publish", "never", ...config]));
  }
  timed("verify", () => verifyBundle(appPath, identity));
  if (inputs && !writeBuildStamp(root, appPath, identity.hash, inputs)) {
    console.warn("Runtime inputs changed during the build; this bundle has no build record, so `pnpm open:app` will refuse it.");
  }
  if (dmg) {
    // Generate the disk image only after the embedded app has passed identity checks.
    timed("dmg", () => run("pnpm", ["exec", "electron-builder", "--mac", "dmg", `--${process.arch}`,
      "--prepackaged", appPath, "--publish", "never", ...config]));
    console.log(`Local DMG generated in ${output}/. Self-signed, not notarized; CI builds the release DMG from the tag (docs/system-design/releases.md).`);
  } else {
    timed("open", () => run("open", ["-a", appPath]));
    console.log(`Opened ${appPath}\nLog: ~/Library/Logs/recordstuff/recordstuff.log`);
  }
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof BlockedError ? 2 : 1;
} finally {
  if (timings.length) {
    console.log(`Timing: ${timings.map(({ phase, ms, ok }) => `${phase} ${(ms / 1000).toFixed(2)} s${ok ? "" : " (failed)"}`).join(", ")}`);
  }
}
