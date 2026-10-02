/** Network boundary for release-record.test.ts; no request reaches the network or the real `gh`. */
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const fixturePath = process.env.RELEASE_FIXTURE;
if (!fixturePath) throw new Error('RELEASE_FIXTURE is required');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  commit: string;
  release: unknown;
  metadata: { sha256: string; file: string };
  windows?: { sha256: string; file: string };
};
// `gh api` answers from the fixture. Replacing the builtin export, rather than
// putting a script named gh on PATH, works where shebang scripts cannot run (Windows).
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = ((command: string, args: readonly string[], options: object) => {
  if (command !== 'gh') return spawnSync(command, args, options);
  const endpoint = args[1] ?? '';
  const answer = endpoint.includes('/commits/') ? { sha: fixture.commit }
    : endpoint.includes('/releases/tags/') ? fixture.release : undefined;
  if (answer === undefined) return { pid: 0, output: [], stdout: '', stderr: `Unexpected gh request: ${endpoint}`, status: 1, signal: null };
  return { pid: 0, output: [], stdout: JSON.stringify(answer), stderr: '', status: 0, signal: null };
}) as typeof childProcess.spawnSync;
syncBuiltinESMExports();
globalThis.fetch = async (url, init = {}) => {
  if (init.method === 'HEAD') return new Response(null, { status: init.redirect === 'follow' ? 200 : 302 });
  if (String(url).includes('api.github.com')) return Response.json(fixture.release);
  if (String(url).endsWith('/release.json')) return Response.json(fixture.metadata);
  if (fixture.windows && String(url).endsWith('/release-win32-x64.json')) return Response.json(fixture.windows);
  if (String(url).endsWith('SHA256SUMS')) {
    return new Response([fixture.metadata, ...(fixture.windows ? [fixture.windows] : [])].map(f => `${f.sha256}  ${f.file}\n`).join(''));
  }
  throw new Error(`Unexpected network request: ${url}`);
};
