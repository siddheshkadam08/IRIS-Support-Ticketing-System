import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the repository root.
 *
 * Derived from this module's own location, NOT from process.cwd(). Under
 * `npm run dev --workspace=gateway` the cwd is the workspace directory, so any
 * relative path in config silently resolves somewhere different than when the
 * same service is started from the repo root. That is how the widget bundle
 * ends up unserved with only a warning in the log.
 */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

/** Resolve a possibly-relative config path against the repo root. */
export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot(), p);
}

/**
 * Loads the repo-root .env into process.env, once, before config validation.
 * Uses Node 22's built-in loader — no dotenv dependency.
 *
 * Values already present in the real environment always win, so a deployment
 * that sets real env vars is never overridden by a stray local file.
 */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(path.join(repoRoot(), '.env'));
  } catch {
    // Absent .env is normal in a real deployment — config validation will
    // fail loudly if something required is genuinely missing.
  }
}
