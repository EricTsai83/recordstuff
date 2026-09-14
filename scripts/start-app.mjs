// Self-signed app/DMG for development and macOS releases.
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
// Never import a release certificate, contact notarization or publish from this flow.
for (const key of Object.keys(env)) {
  if (/^(?:CSC_|WIN_CSC_|APPLE_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
}
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.signal ?? result.status}`);
  }
  return result;
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
  const result = spawnSync("pgrep", ["-f",
    `(^|/)RecordStuff\\.app/Contents/MacOS/RecordStuff($| )|(${electronPaths.map(escapeRegex).join("|")})($| )`,
  ], { env, encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status)) throw new Error("Could not check for a running RecordStuff.app.");
  if (result.status === 0) {
    throw new Error("Quit RecordStuff.app and this project's Electron.app from their menus before rebuilding (stop and save any recording first).");
  }
}

function verifyBundle(appPath, identity) {
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
      const cert = new X509Certificate(readFileSync(`${prefix}0`));
      if (fingerprint(cert) !== identity.hash) throw new Error(`Unexpected signing certificate: ${bundle}`);
      checkCertificate(cert);
      const expectedId = index === 0 ? /^Identifier=com\.recordstuff\.app$/m : /^Identifier=.+$/m;
      if (!expectedId.test(details)) throw new Error(`Missing or incorrect bundle identifier: ${bundle}`);
      if (bundle.endsWith(".app") && !/^CodeDirectory .*flags=.*\bruntime\b/m.test(details)) {
        throw new Error(`Hardened runtime is missing: ${bundle}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const requirement = run("codesign", ["-d", "-r-", appPath], true);
  const expected = `designated => identifier "com.recordstuff.app" and certificate leaf = H"${identity.hash.toLowerCase()}"`;
  if (!`${requirement.stdout}${requirement.stderr}`.split(/\r?\n/).includes(expected)) {
    throw new Error("Unexpected designated requirement; refusing to open or package this app.");
  }
  console.log(`Verified ${bundles.length} bundle identities; SHA-1 ${identity.hash}\n${requirement.stdout}${requirement.stderr}`);
}

function main() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("Local app builds require macOS arm64 or x64.");
  }
  const args = process.argv.slice(2);
  if (args[0] === "--verify-app") {
    const hash = process.env.RECORDSTUFF_SIGN_IDENTITY;
    if (args.length !== 2 || !/^[A-Fa-f0-9]{40}$/.test(hash ?? "")) {
      throw new Error("--verify-app requires an app path and RECORDSTUFF_SIGN_IDENTITY SHA-1.");
    }
    verifyBundle(path.resolve(args[1]), { hash: hash.toUpperCase() });
    return;
  }
  if (args.length > 1 || (args.length === 1 && !["--dmg", "--open"].includes(args[0]))) {
    throw new Error("Usage: node scripts/start-app.mjs [--dmg | --open]");
  }
  const dmg = args[0] === "--dmg";
  assertNotRunning();
  const identity = resolveIdentity();
  console.log(`Local signing: ${identity.name}; SHA-1 ${identity.hash}; expires ${identity.expires}`);
  const output = dmg ? "dist/local" : "dist/dev";
  const appPath = path.join(root, output, process.arch === "arm64" ? "mac-arm64" : "mac", "RecordStuff.app");
  const config = [
    "--config", "electron-builder.local.yml",
    `-c.directories.output=${output}`, `-c.mac.identity=${identity.hash}`,
    "-c.mac.notarize=false", "-c.mac.timestamp=none", "-c.forceCodeSigning=true",
  ];
  if (args[0] !== "--open") {
    run("pnpm", ["exec", "electron-vite", "build"]);
    run("pnpm", ["exec", "electron-builder", "--dir", "--mac", `--${process.arch}`, "--publish", "never", ...config]);
  }
  verifyBundle(appPath, identity);
  if (dmg) {
    // Generate the disk image only after the embedded app has passed identity checks.
    run("pnpm", ["exec", "electron-builder", "--mac", "dmg", `--${process.arch}`,
      "--prepackaged", appPath, "--publish", "never", ...config]);
    console.log(`Local DMG generated in ${output}. Self-signed, not notarized; follow docs/verification/releases/0.1.0.md for download/install verification.`);
  } else {
    run("open", ["-a", appPath]);
    console.log(`Opened ${appPath}\nLog: ~/Library/Logs/recordstuff/recordstuff.log`);
  }
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
