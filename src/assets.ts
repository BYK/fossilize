import { promises as fs } from "node:fs";
import path from "node:path";

/** SEA asset key → path on disk to read the bytes from. */
export type AssetMap = Record<string, string>;

/**
 * Subset of a Vite build manifest chunk (`build.manifest: true`).
 * https://vite.dev/guide/backend-integration
 */
export interface ViteManifestChunk {
  file: string;
  src?: string;
  name?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  css?: string[];
  assets?: string[];
  imports?: string[];
  dynamicImports?: string[];
}

export type ViteManifest = Record<string, ViteManifestChunk>;

const ASSET_KEY_SEPARATOR = "=";
const VITE_MANIFEST_DIR = ".vite";

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

function joinKey(prefix: string, rel: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  return trimmed ? `${trimmed}/${rel}` : rel;
}

/**
 * Directory Vite wrote its build output to. Vite 5+ places the manifest in
 * `<outDir>/.vite/manifest.json`; older versions and `build.manifest:
 * "manifest.json"` put it directly in `<outDir>`.
 */
export function viteOutDir(manifestPath: string): string {
  const dir = path.dirname(manifestPath);
  return path.basename(dir) === VITE_MANIFEST_DIR ? path.dirname(dir) : dir;
}

/**
 * Every build output referenced by a Vite manifest, keyed by its path relative
 * to the Vite outDir: each chunk's `file` plus the `css` and `assets` it pulls
 * in (the CSS of an HTML entry is only listed there). Dynamic imports are
 * chunks of their own in the manifest, so they are covered by `file`.
 *
 * The manifest itself is embedded under its basename so the app can read it
 * back with `sea.getRawAsset("manifest.json")`, and an `isEntry` chunk whose
 * manifest key exists as a build output (e.g. `index.html`) is embedded under
 * that key too.
 */
export async function collectViteManifestAssets(
  manifestPath: string
): Promise<AssetMap> {
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf-8")
  ) as ViteManifest;
  const outDir = viteOutDir(manifestPath);
  const assets: AssetMap = {
    [path.basename(manifestPath)]: manifestPath,
  };
  const add = (rel: string): void => {
    assets[rel] = path.join(outDir, rel);
  };
  for (const [key, chunk] of Object.entries(manifest)) {
    add(chunk.file);
    chunk.css?.forEach(add);
    chunk.assets?.forEach(add);
    if (chunk.isEntry && !(key in assets)) {
      const candidate = path.join(outDir, key);
      if (await isFile(candidate)) {
        assets[key] = candidate;
      }
    }
  }
  return assets;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isRegular = entry.isFile();
    if (entry.isSymbolicLink()) {
      const stat = await fs.stat(full);
      isDir = stat.isDirectory();
      isRegular = stat.isFile();
    }
    if (isDir) {
      yield* walk(full);
    } else if (isRegular) {
      yield full;
    }
  }
}

/**
 * Resolve `--assets` specs. Each spec is `<path>[=<key>]`:
 *
 * - a file is embedded under `<key>` (default: the path as given, so
 *   `-a asset.txt` stays readable as `getRawAsset("asset.txt")`);
 * - a directory is embedded recursively, each file under
 *   `<key>/<posix relative path>` (default key: the normalized path as given,
 *   so `-a ./dist/ui` yields `dist/ui/index.html`). An empty key
 *   (`-a dist/ui=`) embeds the tree at the root of the asset namespace.
 */
export async function collectAssets(specs: string[]): Promise<AssetMap> {
  const assets: AssetMap = {};
  for (const spec of specs) {
    const sep = spec.indexOf(ASSET_KEY_SEPARATOR);
    const source = sep === -1 ? spec : spec.slice(0, sep);
    const key = sep === -1 ? spec : spec.slice(sep + 1);
    if (!source) {
      throw new Error(`Invalid asset spec "${spec}": missing path`);
    }
    const resolved = path.resolve(source);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const prefix =
        sep === -1 ? path.posix.normalize(toPosix(key)) : toPosix(key);
      for await (const file of walk(resolved)) {
        assets[joinKey(prefix, toPosix(path.relative(resolved, file)))] = file;
      }
    } else {
      if (!key) {
        throw new Error(
          `Invalid asset spec "${spec}": a file asset needs a non-empty key`
        );
      }
      assets[key] = resolved;
    }
  }
  return assets;
}
