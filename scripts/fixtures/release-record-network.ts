/** Network boundary for release-record.test.ts; no request reaches the network. */
import fs from 'node:fs';
const fixturePath = process.env.RELEASE_FIXTURE;
if (!fixturePath) throw new Error('RELEASE_FIXTURE is required');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  release: unknown;
  metadata: { sha256: string; file: string };
};
globalThis.fetch = async (url, init = {}) => {
  if (init.method === 'HEAD') return new Response(null, { status: 302 });
  if (String(url).includes('api.github.com')) return Response.json(fixture.release);
  if (String(url).endsWith('release.json')) return Response.json(fixture.metadata);
  if (String(url).endsWith('SHA256SUMS')) return new Response(`${fixture.metadata.sha256}  ${fixture.metadata.file}\n`);
  throw new Error(`Unexpected network request: ${url}`);
};
