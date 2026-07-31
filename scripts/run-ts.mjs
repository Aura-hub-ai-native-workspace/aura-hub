/**
 * Entry: register the TS workspace loader and run a .ts file.
 * Usage: node scripts/run-ts.mjs <entry.ts> [args]
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <entry.ts> [args...]');
  process.exit(1);
}
const entryUrl = pathToFileURL(path.resolve(entry)).href;
process.argv = [process.argv[0], entryUrl, ...process.argv.slice(3)];
await import(entryUrl);
