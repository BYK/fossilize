// Network-backed tests for how fossilize finds and verifies Node.js builds.
// Run after `npm run build`: they drive the built package through its public
// `fossilize()` API, so they exercise the same code path as the CLI.
import assert from "node:assert/strict";
import { mkdtemp, open, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fossilize } from "../dist/index.js";

// nodejs.org ships no linux-arm64-musl build for this version; the Node.js
// unofficial-builds project does.
const NODE_VERSION = "24.16.0";
const MUSL_PLATFORM = "linux-arm64-musl";
const MUSL_ARCHIVE = `node-v${NODE_VERSION}-${MUSL_PLATFORM}.tar.xz`;
const EM_AARCH64 = 183;
const MUSL_INTERPRETER = "/lib/ld-musl-aarch64.so.1";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.join(testDir, "sample.cjs");

let workDir;
// Shared by the tests so the host Node.js binary (needed to build the SEA
// blob) and the musl build are downloaded once.
let cacheDir;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "fossilize-test-"));
  cacheDir = path.join(workDir, "cache");
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function outDirFor(platform) {
  return path.join(workDir, `out-${platform}`);
}

function build(platform, options = {}) {
  return fossilize(
    {
      nodeVersion: NODE_VERSION,
      platforms: [platform],
      outDir: outDirFor(platform),
      cacheDir,
      noBundle: true,
      noCodeCache: true,
      sign: false,
      holePunch: false,
      concurrencyLimit: 1,
      ...options,
    },
    entrypoint
  );
}

async function readHead(file, length) {
  const handle = await open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(length),
      0,
      length,
      0
    );
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

test("builds linux-arm64-musl from the unofficial builds", async () => {
  await build(MUSL_PLATFORM);

  const binary = path.join(outDirFor(MUSL_PLATFORM), `sample-${MUSL_PLATFORM}`);
  const head = await readHead(binary, 64 * 1024);
  assert.equal(head.subarray(0, 4).toString("latin1"), "\x7fELF");
  assert.equal(head.readUInt16LE(18), EM_AARCH64);
  assert.ok(
    head.includes(MUSL_INTERPRETER),
    `expected ${MUSL_INTERPRETER} as the ELF interpreter`
  );
});

test("rejects a download that does not match SHASUMS256.txt", async (t) => {
  // Start from the shared cache minus the musl build, so only that archive
  // is downloaded again.
  const tamperedCache = path.join(workDir, "cache-tampered");
  await cp(cacheDir, tamperedCache, {
    recursive: true,
    filter: (src) => !path.basename(src).includes(MUSL_PLATFORM),
  });

  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, ...rest) => {
    const resp = await realFetch(url, ...rest);
    if (!String(url).endsWith("/SHASUMS256.txt")) {
      return resp;
    }
    const sums = (await resp.text())
      .split("\n")
      .map((line) =>
        line.endsWith(`  ${MUSL_ARCHIVE}`)
          ? `${"0".repeat(64)}  ${MUSL_ARCHIVE}`
          : line
      )
      .join("\n");
    return new Response(sums, { status: 200 });
  });

  await assert.rejects(build(MUSL_PLATFORM, { cacheDir: tamperedCache }), {
    message: new RegExp(`^Checksum mismatch for .*/${MUSL_ARCHIVE}: `),
  });
});

test("fails clearly when no source has the platform", async () => {
  await assert.rejects(build("linux-nope64-musl"), {
    message: new RegExp(
      `^No Node\\.js v${NODE_VERSION} build found for ` +
        `node-v${NODE_VERSION}-linux-nope64-musl\\.tar\\.xz\\. Tried:\\n` +
        "  https://nodejs.org/dist/.*\\n" +
        "  https://unofficial-builds\\.nodejs\\.org/download/release/"
    ),
  });
});
