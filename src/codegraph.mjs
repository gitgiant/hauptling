/**
 * CodeGraph in workers (PRD "CodeGraph in workers"): one index per repo in a host cache, copied into each
 * worker's clone and synced there (paths in the index are repo-relative, files carry content hashes), and
 * the per-agent Claude MCP config (managed-mcp.json: exclusive, so the repo's own .mcp.json servers load
 * only when hauptling.json "mcp" names them).
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './util.mjs';

const FILES = /^codegraph\.db(-wal|-shm)?$/;

/** The MCP server line every worker gets (inside the container the clone is /work). */
export const SERVER = { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp', '--no-telemetry', '--path', '/work'] };

/** Run in the container before the agent starts: sync a seeded index, or build one. */
export const SETUP = ['sh', '-c', 'cd /work && if [ -f .codegraph/codegraph.db ]; then codegraph sync .; else codegraph init -y --local-only .; fi'];

/** CodeGraph is on unless the repo's hauptling.json says `"codegraph": false`. */
export const enabled = (repoCfg) => repoCfg?.codegraph !== false;

/**
 * managed-mcp.json for one agent: CodeGraph (when on) plus the repo servers hauptling.json "mcp" allowlists,
 * copied from the repo's .mcp.json. Unknown names are reported, not fatal. `{ mcpServers: {} }` (all off)
 * is still written: it keeps the repo's own servers out.
 * @returns {{ config: { mcpServers: Record<string, object> }, missing: string[] }}
 */
export function mcpConfig({ codegraph, repoCfg = {}, repoMcp = {} }) {
  const mcpServers = {};
  if (codegraph) mcpServers.codegraph = SERVER;
  const missing = [];
  for (const name of Array.isArray(repoCfg.mcp) ? repoCfg.mcp : []) {
    const def = repoMcp?.mcpServers?.[name];
    if (def && name !== 'codegraph') mcpServers[name] = def;
    else if (!def) missing.push(name);
  }
  return { config: { mcpServers }, missing };
}

/** Host cache directory for a repo (GitHub slug or local path). */
export const cacheDir = (repo) => join(home(), 'codegraph', String(repo).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, ''));

/** Copies the cached index into a clone (no-op without a cache) and keeps .codegraph/ out of git. */
export function seed(cache, dir) {
  const dst = join(dir, '.codegraph');
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, '.gitignore'), '*\n');
  try { appendFileSync(join(dir, '.git', 'info', 'exclude'), '.codegraph/\n'); } catch { /* not a clone: .gitignore covers it */ }
  if (!existsSync(cache)) return false;
  const files = readdirSync(cache).filter(f => FILES.test(f));
  for (const f of files) cpSync(join(cache, f), join(dst, f));
  return files.includes('codegraph.db');
}

/** Saves a clone's freshly synced index as the repo's cache (temp dir + rename: concurrent spawns never see half a copy). */
export function save(dir, cache) {
  const src = join(dir, '.codegraph');
  if (!existsSync(join(src, 'codegraph.db'))) return false;
  const tmp = `${cache}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  for (const f of readdirSync(src).filter(f => FILES.test(f))) cpSync(join(src, f), join(tmp, f));
  rmSync(cache, { recursive: true, force: true });
  renameSync(tmp, cache);
  return true;
}
