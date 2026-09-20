/**
 * Checks every link in the built site (dist/): internal hrefs must resolve to a
 * built file (and, for fragments, an element id in that file); external URLs
 * must answer with a non-error status. `--offline` skips external checks.
 * `--dir <path>` selects another build output, relative to the working directory.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { dir: { type: "string" }, offline: { type: "boolean" } } });
const dist = values.dir ? path.resolve(values.dir) : fileURLToPath(new URL("../dist", import.meta.url));
const offline = values.offline || process.env.SITE_MANIFEST_OFFLINE === "1";
/** Absolute URLs on the configured site origin (canonical, og:image) are checked as internal paths. */
const siteOrigin = new URL(process.env.SITE_URL ?? "https://record.ericts.com").origin;

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith(".html")) files.push(full);
  }
  return files;
}

/** True only for regular files; a directory such as dist/a/help must resolve through its index.html. */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Resolves a site path to the built file: /a/ → dist/a/index.html, /x.png → dist/x.png. */
async function resolveInternal(pathname: string): Promise<string | null> {
  const clean = decodeURIComponent(pathname.split("?")[0]);
  const candidates = clean.endsWith("/")
    ? [path.join(dist, clean, "index.html")]
    : [path.join(dist, clean), path.join(dist, clean, "index.html"), path.join(dist, `${clean}.html`)];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

const idCache = new Map<string, Set<string>>();
async function idsIn(file: string): Promise<Set<string>> {
  let ids = idCache.get(file);
  if (!ids) {
    const html = await readFile(file, "utf8");
    ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    idCache.set(file, ids);
  }
  return ids;
}

const files = await htmlFiles(dist);
if (files.length === 0) throw new Error(`No HTML in ${dist}; run the build first.`);

const problems: string[] = [];
const external = new Map<string, string[]>();
let internalCount = 0;

for (const file of files) {
  const html = await readFile(file, "utf8");
  const page = `/${path.relative(dist, file).replace(/\\/g, "/")}`;
  const refs = [...html.matchAll(/\s(?:href|src|srcset)="([^"]*)"/g)].flatMap((match) =>
    match[0].trimStart().startsWith("srcset")
      ? match[1].split(",").map((part) => part.trim().split(/\s+/)[0])
      : [match[1]],
  );
  for (const ref of refs) {
    if (!ref || ref.startsWith("data:") || ref.startsWith("mailto:") || ref.startsWith("javascript:")) continue;
    const onSite = ref.startsWith(`${siteOrigin}/`) ? ref.slice(siteOrigin.length) : ref;
    if (/^https?:\/\//.test(onSite)) {
      const pages = external.get(ref) ?? [];
      pages.push(page);
      external.set(ref, pages);
      continue;
    }
    internalCount += 1;
    const [pathname, fragment] = onSite.split("#");
    const targetPath = pathname === "" ? page : pathname;
    const resolved = await resolveInternal(targetPath);
    if (!resolved) {
      problems.push(`${page}: internal link ${ref} does not resolve in dist/`);
      continue;
    }
    if (fragment && resolved.endsWith(".html") && !(await idsIn(resolved)).has(fragment)) {
      problems.push(`${page}: fragment #${fragment} not found in ${path.relative(dist, resolved)}`);
    }
  }
}

if (!offline) {
  const results = await Promise.all(
    [...external.keys()].map(async (url) => {
      try {
        let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
        if (response.status === 405 || response.status === 403) {
          response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
        }
        return { url, status: response.status };
      } catch (error) {
        return { url, status: 0, error: (error as Error).message };
      }
    }),
  );
  for (const result of results) {
    if (result.status < 200 || result.status >= 400) {
      problems.push(`external ${result.url} → ${result.status || result.error} (used on ${external.get(result.url)?.join(", ")})`);
    }
  }
}

console.log(
  `Checked ${files.length} pages, ${internalCount} internal references and ${external.size} external URLs${offline ? " (external skipped: offline)" : ""}.`,
);
if (problems.length > 0) {
  console.error(problems.map((problem) => `  ${problem}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("No broken links.");
}
