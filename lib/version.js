/**
 * The package version, read once so the panel can show it and the API can
 * report it without importing JSON.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/version
 */
import { readFileSync } from 'node:fs';

/**
 * Read `version` from this package's manifest.
 * @returns {string} the version, or `0.0.0` when the manifest is unreadable.
 */
function readVersion() {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The published version of this package. */
export const PLUGIN_VERSION = readVersion();
