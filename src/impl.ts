import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { inject } from "postject";
import type { LocalContext } from "./context";
import { getNodeBinary, resolveNodeVersion } from "./node-util";
import pLimit from "p-limit";

interface CommandFlags {
  readonly nodeVersion: string;
  readonly platforms?: string[];
  readonly assets?: string[];
  readonly assetManifest?: string;
  readonly outDir: string;
  readonly outputName?: string;
  readonly cacheDir: string;
  readonly noCache?: boolean;
  readonly noBundle: boolean;
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
    if (errorCode && Number.isInteger(errorCode)) {
      process.exit((err as ExecError).code);
    } else {
      throw new Error("Bailing out as the command failed");
    }
  }
  if (output.stdout.trim()) {
    console.log(output.stdout);
  } else {
    console.log(`> ${[cmd, ...args].join(" ")}`);
  }
  return output.stdout;
}

export default async function (
  this: LocalContext,
  flags: CommandFlags,
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

  // Determine if any target matches the build host — code cache is only
  // valid for the same CPU architecture, so we generate two blobs when
  // cross-compiling: one with code cache (host platform) and one without.
  const hostIsTarget = platforms.includes(currentPlatform);
  const needsCrossBlob = platforms.length > 1 || !hostIsTarget;

  const seaConfig: SEAConfig = {
    main: jsBundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // Enable code cache when building only for the host platform.
    // When cross-compiling, the base blob is generated without code cache;
    // a second blob with code cache is created for the host platform below.
    useCodeCache: hostIsTarget && !needsCrossBlob,
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

  // When cross-compiling AND the host platform is a target, generate a
  // second blob with V8 code cache enabled. Code cache pre-compiles the
  // JS into bytecode, saving ~15% startup time — but the bytecode is
  // CPU-architecture-specific, so it only works for the host platform.
  const codeCacheBlobPath = `${blobPath}.codecache`;
  let hasCodeCacheBlob = false;
  if (hostIsTarget && needsCrossBlob) {
    const codeCacheConfig: SEAConfig = {
      ...seaConfig,
      useCodeCache: true,
      output: codeCacheBlobPath,
    };
    const codeCacheConfigPath = `${seaConfigPath}.codecache`;
    await fs.writeFile(codeCacheConfigPath, JSON.stringify(codeCacheConfig));
    console.log(`Generating code-cache blob for host platform (${currentPlatform})...`);
    await run(targetNodeBinary, "--experimental-sea-config", codeCacheConfigPath);
    await fs.rm(codeCacheConfigPath);
    hasCodeCacheBlob = true;
  }

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
        const stripCmd = platform.startsWith("darwin")
          ? ["strip", "-x", fossilizedBinary]
          : ["strip", "--strip-unneeded", fossilizedBinary];
        await run(stripCmd[0]!, ...stripCmd.slice(1));
      } catch {
        // Non-fatal: may fail when cross-stripping (e.g., macOS Mach-O on Linux)
        console.warn(`  Warning: strip failed for ${platform} (non-fatal)`);
      }
    }

    // Use the code-cache blob for the host platform, base blob for others
    const blobForPlatform = (hasCodeCacheBlob && platform === currentPlatform)
      ? codeCacheBlobPath
      : blobPath;
    const cacheLabel = blobForPlatform === codeCacheBlobPath ? " (with code cache)" : "";
    console.log(`Injecting blob into node executable: ${fossilizedBinary}${cacheLabel}`);
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
    fs.chmod(fossilizedBinary, 0o755);

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
      console.log("Skipping signing, add `--sign` to sign the binary");
      if (platform.startsWith("darwin")) {
        console.warn(
          `macOS binaries must be signed to run. You can run \`spctl --add ${fossilizedBinary}\` to add the binary to your system's trusted binaries for testing.`
        );
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
      const {
        APPLE_TEAM_ID,
        APPLE_CERT_PATH,
        APPLE_CERT_PASSWORD,
        APPLE_API_KEY_PATH,
      } = process.env;
      if (!APPLE_TEAM_ID || !APPLE_CERT_PATH || !APPLE_CERT_PASSWORD) {
        throw new Error(
          "Missing required environment variables for macOS signing (at least one of APPLE_TEAM_ID, APPLE_CERT_PATH, APPLE_CERT_PASSWORD)"
        );
      }
      console.log(`Signing ${fossilizedBinary}...`);
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
        fileURLToPath(import.meta.resolve("../entitlements.plist")),
        fossilizedBinary
      );
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
  const cleanups = [fs.rm(seaConfigPath), fs.rm(blobPath)];
  if (hasCodeCacheBlob) {
    cleanups.push(fs.rm(codeCacheBlobPath));
  }
  await Promise.all(cleanups);
}
