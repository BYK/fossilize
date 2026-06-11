import { createWriteStream, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { unsign } from "macho-unsign";
import { signatureSet } from "portable-executable-signature";
import { untar, unzip } from "./archive-util";

type ErrorWithCode = Error & { code: string };
type NodeJSVersionInfo = {
  version: string;
  date: string;
  files: string[];
  npm: string;
  v8: string;
  uv: string;
  zlib: string;
  openssl: string;
  modules: string;
  lts: boolean;
  security: boolean;
};

function getNodeBinaryCacheName(
  version: string,
  platform: string
): { name: string; ext: string } {
  const ext = platform.startsWith("win") ? ".exe" : "";
  return { name: `node-v${version}-${platform}${ext}`, ext };
}


async function getNodeBinaryFromCache(
  cacheDir: string,
  version: string,
  platform: string,
  targetPath?: string
): Promise<string> {
  const { name, ext } = getNodeBinaryCacheName(version, platform);
  const cacheSourceFile = path.join(cacheDir, name);
  if (!targetPath) {
    await fs.access(cacheSourceFile, fs.constants.R_OK);
    return cacheSourceFile;
  }
  const targetFile = `${targetPath}-${platform}${ext}`;
  if (platform.startsWith("darwin") || platform.startsWith("win")) {
    const nodeBuffer = await fs.readFile(cacheSourceFile);
    let unsigned: ArrayBufferLike | null = null;
    if (platform.startsWith("win")) {
      unsigned = signatureSet(nodeBuffer, null);
    } else if (platform.startsWith("darwin")) {
      unsigned = unsign(nodeBuffer.buffer);
    }
    if (!unsigned) {
      throw new Error(`Failed to unsign binary: ${cacheSourceFile}`);
    }
    await fs.writeFile(targetFile, Buffer.from(unsigned));
  } else {
    await fs.copyFile(cacheSourceFile, targetFile);
  }
  return targetFile;
}

/**
 * Strip an embedded code signature from a binary in place. Used to return a
 * binary we temporarily signed (to generate a matching V8 code cache) back to
 * the unsigned state postject expects before injection. No-op on Linux and
 * when the binary carries no signature.
 */
export async function unsignBinaryInPlace(
  filePath: string,
  platform: string
): Promise<void> {
  if (!platform.startsWith("darwin") && !platform.startsWith("win")) {
    return;
  }
  const buffer = await fs.readFile(filePath);
  const unsigned: ArrayBufferLike | null = platform.startsWith("win")
    ? signatureSet(buffer, null)
    : unsign(buffer.buffer);
  // `null` means there was no signature to strip — nothing to do.
  if (unsigned) {
    // Preserve the original file mode — fs.writeFile defaults to 0o666
    // (masked by umask → typically 0o644), which would lose the execute bit.
    const { mode } = await fs.stat(filePath);
    await fs.writeFile(filePath, Buffer.from(unsigned));
    await fs.chmod(filePath, mode);
  }
}

// The env-var name Node reads at bootstrap to source extra CLI/V8 flags.
const NODE_OPTIONS_ENV = "NODE_OPTIONS";
// Same byte length as NODE_OPTIONS (12) so nothing shifts; not a real env var,
// so `getenv()` returns null and Node applies no flags from NODE_OPTIONS.
const NODE_OPTIONS_REPLACEMENT = "NODE_OPTIQNS";

// A byte is "C-string-ish" if it could appear in a run of null-terminated
// ASCII string constants: NUL padding or printable ASCII (incl. tab/newline).
function isCStringByte(b: number): boolean {
  return b === 0 || b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e);
}

function allCStringBytes(buf: Buffer): boolean {
  for (const b of buf) {
    if (!isCStringByte(b)) return false;
  }
  return true;
}

/**
 * Find the offsets of the `NODE_OPTIONS` C-string constant(s) that the Node
 * C++ bootstrap feeds to `credentials::SafeGetenv()`.
 *
 * A Node binary holds ~10-12 copies of the literal `NODE_OPTIONS`:
 *   - the `.rodata` env-var-name C string (the lookup constant — what we want),
 *   - error-message / help fragments (`NODE_OPTIONS (invalid escape)`, …),
 *   - JS bootstrap source (`'NODE_OPTIONS'`, `process.env.NODE_OPTIONS`),
 *   - and copies inside the **checksummed V8 startup snapshot**, which MUST
 *     NOT be modified (patching them breaks startup).
 *
 * We select the C-string constant(s) in a format-agnostic way (works for
 * Mach-O, ELF and PE) by requiring the occurrence to be:
 *   1. NUL-terminated — `NODE_OPTIONS\0` (a real C string). This excludes the
 *      JS copies, which are followed by `'`/`)` rather than NUL, and the
 *      `NODE_OPTIONS (invalid escape)` fragments, where text follows the name.
 *      We intentionally do NOT require a NUL *before* the name: with the MSVC
 *      linker (Windows) the `getenv` argument is suffix-pooled into the
 *      "… is not allowed in NODE_OPTIONS" error string, so it is preceded by
 *      text, not a NUL.
 *   2. surrounded by other C-strings — the 16 bytes on each side are all
 *      NUL-or-printable-ASCII. The snapshot copies sit next to non-printable
 *      serialized bytes (e.g. `Rbz\xae C`) and are thereby excluded.
 *
 * This may match the lookup constant *and* a harmless error-message string
 * that also ends in `NODE_OPTIONS` — both are patched, which is safe (the
 * error text is only ever shown for a flag we now ignore). Verified to include
 * the lookup constant on official node-v22.14.0 and node-v24.16.0
 * darwin-arm64, linux-x64, linux-arm64 and win-x64 builds.
 */
function findNodeOptionsConstants(buffer: Buffer): number[] {
  const needle = Buffer.from(NODE_OPTIONS_ENV, "latin1");
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const j = buffer.indexOf(needle, from);
    if (j < 0) break;
    from = j + 1;
    const end = j + needle.length;
    if (buffer[end] !== 0) continue; // must be a NUL-terminated C string
    const before = buffer.subarray(Math.max(0, j - 16), j);
    const after = buffer.subarray(end + 1, end + 1 + 16);
    if (allCStringBytes(before) && allCStringBytes(after)) {
      offsets.push(j);
    }
  }
  return offsets;
}

/**
 * Neutralize the `NODE_OPTIONS` environment-variable lookup inside a Node
 * binary, in place. This makes the binary behave as if it were built with
 * `./configure --without-node-options`: V8 flags a user sets via
 * `NODE_OPTIONS` are ignored, so the runtime V8 flag-hash matches the
 * build-time default and an embedded V8 code cache is accepted instead of
 * rejected ("Code cache data rejected").
 *
 * Only the C++ `.rodata` lookup constant is renamed; the process environment
 * is untouched, so `process.env.NODE_OPTIONS` is still visible to the app and
 * still inherited by any child process it spawns.
 *
 * Throws if no candidate is found, so a layout change in a future Node release
 * fails the build loudly rather than silently shipping a binary whose code
 * cache would be rejected.
 */
export async function neutralizeNodeOptions(filePath: string): Promise<void> {
  const replacement = Buffer.from(NODE_OPTIONS_REPLACEMENT, "latin1");
  if (replacement.length !== NODE_OPTIONS_ENV.length) {
    throw new Error(
      `NODE_OPTIONS replacement must be exactly ${NODE_OPTIONS_ENV.length} bytes ` +
        `to preserve binary layout (got ${replacement.length}).`
    );
  }
  const buffer = await fs.readFile(filePath);
  const offsets = findNodeOptionsConstants(buffer);
  if (offsets.length === 0) {
    throw new Error(
      `Could not find the NODE_OPTIONS lookup constant to neutralize in ${filePath}. ` +
        `The Node.js binary layout may have changed — refusing to ship a binary whose ` +
        `embedded V8 code cache would be rejected when NODE_OPTIONS is set.`
    );
  }
  // Patch every matching `.rodata` constant (normally exactly one); leave the
  // trailing NUL and following neighbour intact by overwriting only 12 bytes.
  for (const idx of offsets) {
    replacement.copy(buffer, idx);
  }
  const { mode } = await fs.stat(filePath);
  await fs.writeFile(filePath, buffer);
  await fs.chmod(filePath, mode);
}

const NODE_VERSIONS_INDEX_URL =
  "https://nodejs.org/download/release/index.json";
const NODE_VERSION_REGEX = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i;
export async function _resolveNodeVersion(version: string): Promise<string> {
  let resolvedVersion: string | undefined = version;
  if (version === "local") {
    resolvedVersion = process.version.slice(1);
  }
  // TODO: expand `version` to a full version string
  // Use https://nodejs.org/download/release/index.json
  const versionBits = version
    .match(NODE_VERSION_REGEX)
    ?.slice(1)
    .filter(Boolean);
  if (!versionBits || versionBits.length < 3) {
    // TODO: try to match latest, lts
    const response = await fetch(NODE_VERSIONS_INDEX_URL);
    const availableVersions = (await response.json()) as NodeJSVersionInfo[];
    if (!availableVersions || availableVersions.length === 0) {
      throw new Error(
        `No available Node.js versions found from: ${NODE_VERSIONS_INDEX_URL}`
      );
    }
    if (version === "latest") {
      resolvedVersion = availableVersions[0]!.version.slice(1);
    } else if (version === "lts") {
      resolvedVersion = availableVersions.find((v) => v.lts)?.version.slice(1);
    } else if (versionBits) {
      const prefix = `v${versionBits.join(".")}.`;
      resolvedVersion = availableVersions
        .find((v) => v.version.startsWith(prefix))
        ?.version.slice(1);
    }
    if (!resolvedVersion) {
      throw new Error(
        `No matching Node.js version found for: ${version} from: ${NODE_VERSIONS_INDEX_URL}`
      );
    }
  } else {
    resolvedVersion = versionBits.join(".");
  }
  console.log(`Resolved Node.js version '${version}' to ${resolvedVersion}`);
  const [nodeVersionMajor, _nodeVersionMinor] = resolvedVersion
    .match(NODE_VERSION_REGEX)!
    .slice(1, 3)
    .map(Number) as [number, number];
  if (nodeVersionMajor < 20) {
    throw new Error(
      `Node.js version ${resolvedVersion} does not support SEA.\nSee https://nodejs.org/api/single-executable-applications.html#single-executable-applications`
    );
  }
  return resolvedVersion;
}
const _VERSION_CACHE: Map<string, Promise<string>> = new Map();
export function resolveNodeVersion(version: string): Promise<string> {
  if (!_VERSION_CACHE.has(version)) {
    _VERSION_CACHE.set(version, _resolveNodeVersion(version));
  }
  return _VERSION_CACHE.get(version)!;
}

export async function getNodeBinary(
  version: string,
  platform: string,
  cacheDir: string | null,
  targetPath?: string
): Promise<string> {
  if (!cacheDir) {
    // this means don't use cache
    // we still need a temp directory to download the node binary
    cacheDir = tmpdir();
  }

  const resolvedVersion = await resolveNodeVersion(version);

  try {
    return await getNodeBinaryFromCache(
      cacheDir,
      resolvedVersion,
      platform,
      targetPath
    );
  } catch (err) {
    if ((err as ErrorWithCode).code !== "ENOENT") {
      throw err;
    }
  }

  // Note for the future: There are about ~50% smaller windows
  // archives available with the 7z format but decompressing 7z
  // without any native code only seems to be available through
  // a WASM port, which is about 1.5MB. Not sure worth it.
  const remoteArchiveName = `node-v${resolvedVersion}-${platform}.${
    platform.startsWith("win") ? "zip" : "tar.xz"
  }`;
  await fs.mkdir(cacheDir, { recursive: true });
  const nodeDir = await fs.mkdtemp(path.join(cacheDir, remoteArchiveName));
  const url = `https://nodejs.org/dist/v${resolvedVersion}/${remoteArchiveName}`;
  const resp = await fetch(url);
  if (!resp.ok)
    throw new Error(
      `Failed to fetch ${url}: ${resp.status} ${resp.statusText}`
    );
  if (!resp.body)
    throw new Error(
      `Response body is null for ${url}: ${resp.status} ${resp.statusText}`
    );

  const cacheTargetFile = path.join(
    cacheDir,
    getNodeBinaryCacheName(resolvedVersion, platform).name
  );

  // There's a slight chance of a race condition regarding all write operations
  // for the `cacheTargetFile` below (fs.write() and fs.copy()) when concurrent
  // fossilize instances try to write to the same file. We may add a try-catch
  // block here to recover but we'll cross that bridge when we get there.
  if (platform.startsWith("win")) {
    const stream = createWriteStream(path.join(nodeDir, remoteArchiveName));
    await finished(Readable.fromWeb(resp.body).pipe(stream));
    const data = await unzip(
      stream.path as string,
      // Need `/` as path separator, even on Windows as that's how `unzip` works
      `node-v${resolvedVersion}-${platform}/node.exe`
    );
    await fs.writeFile(cacheTargetFile, data);
  } else {
    await fs.writeFile(
      cacheTargetFile,
      await untar(resp.body, `node-v${resolvedVersion}-${platform}/bin/node`)
    );
  }
  await fs.chmod(cacheTargetFile, 0o755);

  try {
    await fs.rm(nodeDir, { recursive: true });
  } catch (err) {
    console.error(`Failed to remove ${nodeDir}: ${err}`);
  }
  return await getNodeBinaryFromCache(
    cacheDir,
    resolvedVersion,
    platform,
    targetPath
  );
}
