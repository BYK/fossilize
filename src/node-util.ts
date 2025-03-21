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
