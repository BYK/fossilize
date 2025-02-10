import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { inject } from "postject";
import type { LocalContext } from "./context";
import { getNodeBinary } from "./node-util";

interface CommandFlags {
  readonly nodeVersion: string;
  readonly platforms?: string[];
  readonly assets?: string[];
  readonly assetManifest?: string;
  readonly outDir: string;
  readonly cacheDir: string;
  readonly noCache?: boolean;
  readonly noBundle: boolean;
  readonly sign: boolean;
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
    process.exit((err as ExecError).code);
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
  let outputName = path.basename(entrypoint).split(".")[0];
  if (entrypointStat.isDirectory()) {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(entrypoint, PACKAGE_JSON), "utf-8")
    );
    appVersion = packageJson.version;
    outputName = packageJson.name.split("/").pop();
    entrypointPath =
      (outputName && packageJson.bin?.[outputName]) || packageJson.main;
  }
  if (!outputName) {
    outputName = "bundled";
  }
  const platforms =
    !flags.platforms || flags.platforms.length === 0
      ? [`${process.platform}-${process.arch}`]
      : flags.platforms;
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
      target: "node22",
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

  const seaConfig: SEAConfig = {
    main: jsBundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false, // We do cross-compiling so disable this
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

  await fs.writeFile(seaConfigPath, JSON.stringify(seaConfig));
  await run(process.execPath, "--experimental-sea-config", seaConfigPath);
  await Promise.all(
    platforms.map(async (platform) => {
      const outputPath = path.join(flags.outDir, outputName);
      console.log(`Creating binary for ${platform} (${outputPath})...`);
      const fossilizedBinary = await getNodeBinary(
        flags.nodeVersion,
        platform,
        path.join(flags.outDir, outputName),
        flags.noCache ? null : flags.cacheDir
      );
      console.log(`Injecting blob into node executable: ${fossilizedBinary}`);
      await inject(
        fossilizedBinary,
        "NODE_SEA_BLOB",
        await fs.readFile(blobPath),
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
      await run("chmod", "+x", fossilizedBinary);
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
          console.warn(
            "Missing required environment variables for macOS signing, you won't be able to use this binary until you sign it yourself."
          );
          console.info({ APPLE_TEAM_ID, APPLE_CERT_PATH, APPLE_CERT_PASSWORD });
          return;
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
          path.join(import.meta.dirname, "entitlements.plist"),
          fossilizedBinary
        );
        if (!APPLE_API_KEY_PATH) {
          console.warn(
            "Missing required environment variable for macOS notarization, you won't be able to notarize this binary which will annoy people trying to run it."
          );
          console.info({ APPLE_API_KEY_PATH });
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
    })
  );
  await Promise.all([fs.rm(seaConfigPath), fs.rm(blobPath)]);
}
