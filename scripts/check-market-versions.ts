import { marketCatalog, type MarketEntry } from '../src/market/catalog.js';

type Source = { registry: 'npm' | 'pypi'; package: string };

function sourceFor(entry: MarketEntry): Source | undefined {
  if (entry.installer?.type === 'npm') return { registry: 'npm', package: entry.installer.package };
  if (entry.installer?.type === 'uvx')
    return { registry: 'pypi', package: entry.installer.package };
  if (entry.package && entry.kind === 'home-stdio')
    return { registry: 'npm', package: entry.package };
  if (entry.package && entry.kind === 'uvx') return { registry: 'pypi', package: entry.package };
  return undefined;
}

async function inspect(entry: MarketEntry) {
  const source = sourceFor(entry);
  if (!source || !entry.version)
    return { id: entry.id, status: 'unsupported', pinned: entry.version ?? null };
  const url =
    source.registry === 'npm'
      ? `https://registry.npmjs.org/${encodeURIComponent(source.package)}/latest`
      : `https://pypi.org/pypi/${encodeURIComponent(source.package)}/json`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { version?: unknown; info?: { version?: unknown } };
    const latest = source.registry === 'npm' ? body.version : body.info?.version;
    if (typeof latest !== 'string' || latest.length === 0) throw new Error('missing version');
    return {
      id: entry.id,
      status: latest === entry.version ? 'equal' : 'different',
      pinned: entry.version,
      latest,
      source,
    };
  } catch (error) {
    return {
      id: entry.id,
      status: 'error',
      pinned: entry.version,
      source,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = await Promise.all(marketCatalog.map(inspect));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some((item) => item.status === 'error')) process.exitCode = 1;
