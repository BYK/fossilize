import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { inject } from "postject";
import type { LocalContext } from "./context";
import {
  getNodeBinary,
  neutralizeNodeOptions,
  resolveNodeVersion,
  unsignBinaryInPlace,
} from "./node-util";
import pLimit from "p-limit";

export interface FossilizeOptions {
  readonly nodeVersion: string;
  readonly platforms?: string[];
  readonly assets?: string[];
  readonly assetManifest?: string;
  readonly outDir: string;
  readonly outputName?: string;
  readonly cacheDir: string;
  readonly noCache?: boolean;
  readonly noBundle: boolean;
  readonly noCodeCache?: boolean;
  readonly ignoreNodeOptions?: boolean;
  readonly sign: boolean;
  readonly holePunch: boolean;
  readonly concurrencyLimit: number;
}

export type SEAConfig = {
  main: string;
  output: string;
  disableExperimentalSEAWarning?: boolean;
  useSnapshot?: boolean;
  useCodeCache?: boolean;
  assets?: Record<string, string>;
};

type ExecResult = { stdout: string; stderr: string };
type ExecError = Error & { code: string } & ExecResult;

const PACKAGE_JSON = "package.json";
const SEA_CONFIG_JSON = "sea-config.json";
const SEA_BLOB = "sea.blob";
const NODE_SEA_FUSE = "fce680ab2cc467b6e072b8b5df1996b2";

const execFileAsync = promisify(execFile);
async function run(cmd: string, ...args: string[]): Promise<string> {
  let output: ExecResult;
  try {
    output = await execFileAsync(cmd, args, { encoding: "utf8" });
  } catch (err) {
    console.error(`Failed to \`run ${cmd} ${args.join(" ")}\``);
    console.error((err as ExecError).stdout);
    console.error((err as ExecError).stderr);
    const errorCode = (err as ExecError).code;
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")} (exit code: ${errorCode})`
    );
  }
  if (output.stdout.trim()) {
    console.log(output.stdout);
  } else {
    console.log(`> ${[cmd, ...args].join(" ")}`);
  }
  return output.stdout;
}

// Apply the macOS code signature (ad-hoc or full identity) to a binary.
// This intentionally does NOT notarize — it is the smallest unit of work that
// puts the binary into its final signing state. It is extracted so the exact
// same signature can be applied during code-cache generation (on the prepared
// host binary, before injection) and to the final executable: V8 only accepts
// a code cache when the consuming binary runs with the same hardened-runtime /
// JIT entitlements (and therefore the same V8 flag-hash) as the binary that
// generated it. See issue #28.
// No-op on non-darwin platforms (linux is unsigned; Windows signing is the
// user's responsibility).
async function signBinary(
  binaryPath: string,
  platform: string,
  sign: boolean
): Promise<void> {
  if (!platform.startsWith("darwin")) {
    return;
  }
  const entitlements = fileURLToPath(
    import.meta.resolve("../entitlements.plist")
  );
  if (!sign) {
    // Ad-hoc sign with entitlements — minimum required for Apple Silicon
    // execution. Use native codesign on macOS, rcodesign elsewhere.
    if (process.platform === "darwin") {
      await run(
        "codesign",
        "--sign",
        "-",
        "--force",
        "--entitlements",
        entitlements,
        binaryPath
      );
    } else {
      await run(
        "rcodesign",
        "sign",
        "--code-signature-flags",
        "runtime",
        "--entitlements-xml-path",
        entitlements,
        binaryPath
      );
    }
    return;
  }
  const { APPLE_TEAM_ID, APPLE_CERT_PATH, APPLE_CERT_PASSWORD } = process.env;
  if (!APPLE_TEAM_ID || !APPLE_CERT_PATH || !APPLE_CERT_PASSWORD) {
    throw new Error(
      "Missing required environment variables for macOS signing (at least one of APPLE_TEAM_ID, APPLE_CERT_PATH, APPLE_CERT_PASSWORD)"
    );
  }
  await run(
    "rcodesign",
    "sign",
    "--team-name",
    APPLE_TEAM_ID,
    "--p12-file",
    APPLE_CERT_PATH,
    "--p12-password",
    APPLE_CERT_PASSWORD,
    "--for-notarization",
    "-e",
    entitlements,
    binaryPath
  );
}

export default async function (
  this: LocalContext,
  flags: FossilizeOptions,
  entrypoint: string
): Promise<void> {
  const entrypointStat = await fs.stat(entrypoint);
  let entrypointPath = entrypoint;
  let appVersion = "0.0.0";
  let outputName: string | undefined;
  if (entrypointStat.isDirectory()) {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(entrypoint, PACKAGE_JSON), "utf-8")
    );
    appVersion = packageJson.version;
    const binDefs = Object.entries(packageJson.bin || {});
    if (binDefs.length === 1) {
      outputName = binDefs[0]![0];
      entrypointPath = binDefs[0]![1] as string;
    } else {
      outputName = packageJson.name.split("/").pop();
      entrypointPath = packageJson.main;
    }
  } else {
    outputName = path.basename(entrypoint).split(".")[0];
  }
  outputName = flags.outputName || outputName || "bundled";
  // For Windows, `process.platform` is `win32` but the archives just use `win`, sigh...
  const normalizedPlatform =
    process.platform === "win32" ? "win" : process.platform;
  const currentPlatform = `${normalizedPlatform}-${process.arch}`;
  const platforms = [
    ...new Set(
      !flags.platforms || flags.platforms.length === 0
        ? (process.env["FOSSILIZE_PLATFORMS"] || currentPlatform)
            .split(",")
            .map((platform) => platform.trim())
        : flags.platforms
    ),
  ];
  this.process.stdout.write(`Platforms: ${platforms.join(", ")}\n`);

  const seaConfigPath = path.join(flags.outDir, SEA_CONFIG_JSON);
  const blobPath = path.join(flags.outDir, SEA_BLOB);

  console.log(`Cleaning up ${flags.outDir}...`);
  await fs
    .rm(flags.outDir, { recursive: true })
    .catch(() => {})
    .finally(() => fs.mkdir(flags.outDir, { recursive: true }));

  let jsBundlePath: string;
  if (flags.noBundle) {
    jsBundlePath = entrypointPath;
  } else {
    console.log(`Bundling ${entrypointPath}...`);
    jsBundlePath = path.join(flags.outDir, `${outputName}.cjs`);
    const bundleResult = await esbuild.build({
      logLevel: "info",
      entryPoints: [entrypointPath],
      bundle: true,
      minify: true,
      platform: "node",
      target: `node${
        (await resolveNodeVersion(flags.nodeVersion)).split(".", 1)[0]
      }`,
      format: "cjs",
      treeShaking: true,
      inject: [fileURLToPath(import.meta.resolve("../import-meta-url.js"))],
      define: {
        "import.meta.url": "import_meta_url",
        "process.env.npm_package_version": JSON.stringify(appVersion),
        "process.env.NODE_ENV": JSON.stringify(
          process.env["NODE_ENV"] || "development"
        ),
      },
      outfile: jsBundlePath,
      allowOverwrite: true,
    });

    if (bundleResult.errors.length) {
      throw new Error(bundleResult.errors.map((e) => e.text).join("\n"));
    }
  }

  // The base blob never carries a V8 code cache. Code cache is both
  // CPU-architecture- AND signing-state-specific: V8 rejects it at runtime
  // unless the consuming binary runs with the same flag-hash as the binary
  // that produced it. We therefore generate the host platform's code-cache
  // blob lazily inside createBinaryForPlatform() using a copy of the prepared
  // (unsigned, stripped) host binary signed exactly like the final executable.
  // See issue #28.
  const seaConfig: SEAConfig = {
    main: jsBundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  if (flags.assetManifest) {
    const manifest = JSON.parse(
      await fs.readFile(flags.assetManifest, "utf-8")
    ) as Record<
      string,
      { file: string; isEntry?: boolean; name: string; src: string }
    >;
    const assetsDir = path.dirname(flags.assetManifest);
    seaConfig.assets = {
      [path.basename(flags.assetManifest)]: flags.assetManifest,
      ...Object.fromEntries(
        Object.values(manifest).map((entry) => [
          entry.file,
          path.join(assetsDir, entry.file),
        ])
      ),
    };
    const entryPointName = Object.entries(manifest).find(
      ([_, value]) => value.isEntry
    )?.[0];
    if (entryPointName) {
      seaConfig.assets[entryPointName] = path.join(assetsDir, entryPointName);
    }
  }

  if (flags.assets) {
    seaConfig.assets = seaConfig.assets || {};
    for (const asset of flags.assets) {
      const assetPath = path.resolve(asset);
      seaConfig.assets[asset] = assetPath;
    }
  }

  await fs.writeFile(seaConfigPath, JSON.stringify(seaConfig));
  const targetNodeBinary = await getNodeBinary(
    flags.nodeVersion,
    currentPlatform,
    flags.cacheDir
  );
  await run(targetNodeBinary, "--experimental-sea-config", seaConfigPath);

  // Fail fast when signing is requested for darwin targets but the required
  // environment variables are missing — avoids a confusing intermediate
  // "could not generate code cache" warning before the real crash.
  if (flags.sign && platforms.some((p) => p.startsWith("darwin"))) {
    const { APPLE_TEAM_ID, APPLE_CERT_PATH, APPLE_CERT_PASSWORD } =
      process.env;
    if (!APPLE_TEAM_ID || !APPLE_CERT_PATH || !APPLE_CERT_PASSWORD) {
      throw new Error(
        "Missing required environment variables for macOS signing " +
          "(at least one of APPLE_TEAM_ID, APPLE_CERT_PATH, APPLE_CERT_PASSWORD)"
      );
    }
  }

  // Path for the host platform's code-cache blob. It is generated lazily
  // inside createBinaryForPlatform() once the prepared host binary exists, so
  // that the cache is produced by a binary in the same signing state as the
  // final executable (otherwise V8 rejects it — see issue #28).
  const codeCacheBlobPath = `${blobPath}.codecache`;

  const createBinaryForPlatform = async (platform: string): Promise<void> => {
    const outputPath = path.join(flags.outDir, outputName);
    console.log(`Creating binary for ${platform} (${outputPath})...`);
    const fossilizedBinary = await getNodeBinary(
      flags.nodeVersion,
      platform,
      flags.noCache ? null : flags.cacheDir,
      path.join(flags.outDir, outputName)
    );
    // Strip debug symbols before SEA injection. Node.js ships with full
    // symbol tables (~17 MiB on linux-x64). Must strip BEFORE postject
    // injection — postject corrupts the ELF section-to-segment layout.
    // Windows PE binaries don't ship debug symbols in release builds.
    if (!platform.startsWith("win")) {
      try {
        const stripArgs = platform.startsWith("darwin")
          ? ["-x", fossilizedBinary]
          : ["--strip-unneeded", fossilizedBinary];
        // Use execFileAsync directly instead of run() — run() calls
        // process.exit() on numeric error codes, bypassing try/catch.
        // Cross-stripping (e.g., ARM64 binary on x86_64 host) legitimately
        // fails and must be non-fatal.
        await execFileAsync("strip", stripArgs, { encoding: "utf8" });
        console.log(`> strip ${stripArgs.join(" ")}`);
      } catch {
        // Non-fatal: may fail when cross-stripping (e.g., macOS Mach-O on Linux)
        console.warn(`  Warning: strip failed for ${platform} (non-fatal)`);
      }
    }

    // Optionally make the binary ignore the NODE_OPTIONS env var (like
    // `./configure --without-node-options`). User-set V8 flags in NODE_OPTIONS
    // (e.g. --max-old-space-size) change V8's FlagList::Hash() at runtime and
    // would otherwise make V8 reject the embedded code cache below ("Code
    // cache data rejected"). Done before code-cache generation and signing so
    // both the generated cache and the final signature cover the patched bytes
    // (and the cache is produced in the same "NODE_OPTIONS-ignored" state the
    // final binary runs in).
    if (flags.ignoreNodeOptions) {
      await neutralizeNodeOptions(fossilizedBinary);
      console.log(`> neutralized NODE_OPTIONS lookup in ${fossilizedBinary}`);
    }

    // The host platform gets a V8 code cache for faster startup (~15%). Code
    // cache is CPU-arch- AND signing-state-specific, so it must be generated by
    // a binary in the same state the final executable will run in. We sign the
    // prepared (stripped) host binary in place — exactly as the final binary
    // will be signed — generate the cache with it, then strip that signature
    // again so postject injects into an unsigned binary (the final signature is
    // applied after inject + hole-punch). Generating with a differently-signed
    // binary makes V8 reject the cache at runtime ("Code cache data
    // rejected"). See #28.
    let blobForPlatform = blobPath;
    if (platform === currentPlatform && !flags.noCodeCache) {
      try {
        // The freshly written binary is 0o644 on darwin/win (it was rewritten
        // to strip the official signature) — make it executable before we run
        // it to generate the cache.
        await fs.chmod(fossilizedBinary, 0o755);
        await signBinary(fossilizedBinary, platform, flags.sign);
        const codeCacheConfig: SEAConfig = {
          ...seaConfig,
          useCodeCache: true,
          output: codeCacheBlobPath,
        };
        const codeCacheConfigPath = `${seaConfigPath}.codecache`;
        await fs.writeFile(codeCacheConfigPath, JSON.stringify(codeCacheConfig));
        console.log(
          `Generating code-cache blob for host platform (${currentPlatform})...`
        );
        await run(
          fossilizedBinary,
          "--experimental-sea-config",
          codeCacheConfigPath
        );
        await fs.rm(codeCacheConfigPath, { force: true });
        blobForPlatform = codeCacheBlobPath;
      } catch (err) {
        console.warn(
          `  Warning: could not generate V8 code cache for ${platform}, ` +
            `falling back to no code cache (non-fatal): ${
              (err as Error).message
            }`
        );
        blobForPlatform = blobPath;
      } finally {
        // Restore the unsigned state postject expects before injection
        // (no-op if the binary was never signed).
        await unsignBinaryInPlace(fossilizedBinary, platform).catch(() => {});
      }
    }
    const cacheLabel =
      blobForPlatform === codeCacheBlobPath ? " (with code cache)" : "";
    console.log(
      `Injecting blob into node executable: ${fossilizedBinary}${cacheLabel}`
    );
    await inject(
      fossilizedBinary,
      "NODE_SEA_BLOB",
      await fs.readFile(blobForPlatform),
      {
        // NOTE: Split the string into 2 as `postject` naively looks for that exact string
        //       for the fuse and gets confused when we try to bundle fossilize.
        sentinelFuse: `NODE_SEA_FUSE_${NODE_SEA_FUSE}`,
        machoSegmentName: platform.startsWith("darwin")
          ? "NODE_SEA"
          : undefined,
      }
    );
    console.log("Created executable", fossilizedBinary);
    await fs.chmod(fossilizedBinary, 0o755);

    // Hole-punch unused ICU data before signing so the signature covers the
    // final bytes. Must run after SEA injection (ICU blob lives in the Node
    // binary's .rodata, unaffected by postject) and before sign + notarize.
    if (flags.holePunch) {
      const { processBinary } = await import("binpunch");
      const stats = processBinary(fossilizedBinary);
      if (stats && stats.removedEntries > 0) {
        console.log(
          `Hole-punched ${stats.removedEntries}/${stats.totalEntries} ICU entries in ${fossilizedBinary}`
        );
      }
    }

    if (!flags.sign) {
      if (platform.startsWith("darwin")) {
        // Ad-hoc sign with entitlements — minimum required for Apple Silicon
        // execution. Without at least ad-hoc signing, the kernel refuses to
        // run the binary.
        try {
          await signBinary(fossilizedBinary, platform, false);
          console.log(`Ad-hoc signed ${fossilizedBinary}`);
        } catch {
          console.warn(
            `Warning: Could not ad-hoc sign ${fossilizedBinary}. ` +
              `Install rcodesign or run on macOS for automatic signing. ` +
              `The binary may not run on Apple Silicon without signing.`
          );
        }
      }
      return;
    }

    if (platform.startsWith("win")) {
      console.warn(
        "Signing is not supported on Windows, you will need to sign the binary yourself."
      );
      return;
    }

    if (platform.startsWith("darwin")) {
      const { APPLE_API_KEY_PATH } = process.env;
      console.log(`Signing ${fossilizedBinary}...`);
      await signBinary(fossilizedBinary, platform, true);
      if (!APPLE_API_KEY_PATH) {
        console.warn(
          "Missing required environment variable for macOS notarization, you won't be able to notarize this binary which will annoy people trying to run it."
        );
        return;
      }
      // TODO: Use JS-based zip instead of shelling out
      const zipFile = `${fossilizedBinary}.zip`;
      await run("zip", zipFile, fossilizedBinary);
      await run(
        "rcodesign",
        "notary-submit",
        "--api-key-file",
        APPLE_API_KEY_PATH,
        "--wait",
        zipFile
      );
      await fs.rm(zipFile);
    }
  };
  const limit = pLimit(flags.concurrencyLimit);
  await Promise.all(
    platforms.map(async (platform) =>
      limit(() => createBinaryForPlatform(platform))
    )
  );
  await Promise.all([
    fs.rm(seaConfigPath, { force: true }),
    fs.rm(blobPath, { force: true }),
    fs.rm(codeCacheBlobPath, { force: true }),
  ]);
}
