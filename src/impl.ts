import * as esbuild from "esbuild";
import { unsign } from "macho-unsign";
import { execFile } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { signatureSet } from "portable-executable-signature";
import { inject } from "postject";
import yauzl from "yauzl";
import type { LocalContext } from "./context";

interface CommandFlags {
  readonly nodeVersion: string;
  readonly platforms?: string[];
  readonly assets?: string[];
  readonly assetManifest?: string;
  readonly outDir: string;
  readonly cacheDir: string;
  readonly noCache?: boolean;
  readonly noBundle: boolean;
}

export type SEAConfig = {
  main: string;
  output: string;
  disableExperimentalSEAWarning?: boolean;
  useSnapshot?: boolean;
  useCodeCache?: boolean;
  assets?: Record<string, string>;
};

const PACKAGE_JSON = "package.json";
const SEA_CONFIG_JSON = "sea-config.json";
const SEA_BLOB = "sea.blob";
const NODE_SEA_FUSE = "fce680ab2cc467b6e072b8b5df1996b2";

const yauzlOpen = promisify(yauzl.open);
async function unzip(sourceFile: string, targetFile: string): Promise<Buffer> {
  let found = false;
  // @ts-expect-error -- For some reason, TS is selecting the wrong overload for yauzl.open with promisify above
  const zipfile = await yauzlOpen(sourceFile, { lazyEntries: true });
  const { resolve, reject, promise } = Promise.withResolvers<Buffer>();
  zipfile.on("entry", (entry) => {
    if (entry.fileName !== targetFile) {
      zipfile.readEntry();
      return;
    }
    zipfile.openReadStream(entry, async (err, readStream) => {
      if (err) {
        reject(err);
        return;
      }
      found = true;
      resolve(Buffer.concat(await Array.fromAsync(readStream)));
    });
  });
  zipfile.once("end", () => {
    if (!found)
      reject(
        new Error(
          `File "${targetFile}" not found in zip archive: ${sourceFile}`
        )
      );
  });
  zipfile.readEntry();

  return promise;
}

const execFileAsync = promisify(execFile);
async function run(cmd: string, ...args: string[]): Promise<string> {
  let output;
  try {
    output = await execFileAsync(cmd, args, { encoding: "utf8" });
  } catch (err: any) {
    // todo: type this error
    console.error(`Failed to \`run ${cmd} ${args.join(" ")}\``);
    console.error(err.stdout);
    console.error(err.stderr);
    process.exit(err.code);
  }
  if (output.stdout.trim()) {
    console.log(output.stdout);
  } else {
    console.log(`> ${[cmd, ...args].join(" ")}`);
  }
  return output.stdout;
}

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
  targetPath: string
): Promise<string> {
  const { name, ext } = getNodeBinaryCacheName(version, platform);
  const cacheSourceFile = path.join(cacheDir, name);
  const targetFile = `${targetPath}-${platform}${ext}`;
  await fs.copyFile(cacheSourceFile, targetFile);
  return targetFile;
}

async function getNodeBinary(
  version: string,
  platform: string,
  targetPath: string,
  cacheDir: string
): Promise<string> {
  try {
    return await getNodeBinaryFromCache(
      cacheDir,
      version,
      platform,
      targetPath
    );
  } catch (err) {
    if ((err as any).code !== "ENOENT") {
      throw err;
    }
  }

  const remoteArchiveName = `node-v${version}-${platform}.${
    platform.startsWith("win") ? "zip" : "tar.xz"
  }`;
  await fs.mkdir(cacheDir, { recursive: true });
  const nodeDir = await fs.mkdtemp(path.join(cacheDir, remoteArchiveName));
  const url = `https://nodejs.org/dist/v${version}/${remoteArchiveName}`;
  const resp = await fetch(url);
  if (!resp.ok)
    throw new Error(
      `Failed to fetch ${url}: ${resp.status} ${resp.statusText}`
    );
  if (!resp.body)
    throw new Error(
      `Response body is null for ${url}: ${resp.status} ${resp.statusText}`
    );

  const stream = createWriteStream(path.join(nodeDir, remoteArchiveName));
  await finished(Readable.fromWeb(resp.body).pipe(stream));
  let sourceFile;
  const cacheTargetFile = path.join(
    cacheDir,
    getNodeBinaryCacheName(version, platform).name
  );

  // There's a slight chance of a race condition regarding all write operations
  // for the `cacheTargetFile` below (fs.write() and fs.copy()) when concurrent
  // fossilize instances try to write to the same file. We may add a try-catch
  // block here to recover but we'll cross that bridge when we get there.

  if (platform.startsWith("win")) {
    sourceFile = path.join(`node-v${version}-${platform}`, "node.exe");
    const data = await unzip(stream.path as string, sourceFile);
    const unsigned = signatureSet(data, null);
    await fs.writeFile(cacheTargetFile, Buffer.from(unsigned));
  } else {
    // TODO: Use node native tar - https://www.npmjs.com/package/tar
    await run("tar", "-xf", stream.path as string, "-C", nodeDir);
    sourceFile = path.join(
      nodeDir,
      `node-v${version}-${platform}`,
      "bin",
      "node"
    );
    if (platform.startsWith("darwin")) {
      const unsigned = unsign(await fs.readFile(sourceFile));
      if (!unsigned)
        throw new Error(`Failed to unsign macOS binary: ${sourceFile}`);
      await fs.writeFile(cacheTargetFile, Buffer.from(unsigned));
    } else {
      await fs.copyFile(sourceFile, cacheTargetFile);
    }
  }

  try {
    await fs.rm(nodeDir, { recursive: true });
  } catch (err) {
    console.error(`Failed to remove ${nodeDir}: ${err}`);
  }
  return await getNodeBinaryFromCache(cacheDir, version, platform, targetPath);
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

  await fs
    .rm(flags.outDir, { recursive: true })
    .catch(() => {})
    .finally(() => fs.mkdir(flags.outDir, { recursive: true }));

  let jsBundlePath;
  if (flags.noBundle) {
    jsBundlePath = entrypointPath;
  } else {
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
      inject: ["./import-meta-url.js"],
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
      const nodeBinary = await getNodeBinary(
        flags.nodeVersion,
        platform,
        path.join(flags.outDir, outputName),
        flags.cacheDir
      );
      console.log(`Injecting blob into node executable: ${nodeBinary}`);
      await inject(nodeBinary, "NODE_SEA_BLOB", await fs.readFile(blobPath), {
        // NOTE: Split the string into 2 as `postject` naively looks for that exact string
        //       for the fuse and gets confused when we try to bundle fossilize.
        sentinelFuse: `NODE_SEA_FUSE_${NODE_SEA_FUSE}`,
        machoSegmentName: platform.startsWith("darwin")
          ? "NODE_SEA"
          : undefined,
      });
      console.log("Created executable", nodeBinary);
      await run("chmod", "+x", nodeBinary);
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
        console.log(`Signing ${nodeBinary}...`);
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
          nodeBinary
        );
        if (!APPLE_API_KEY_PATH) {
          console.warn(
            "Missing required environment variable for macOS notarization, you won't be able to notarize this binary which will annoy people trying to run it."
          );
          console.info({ APPLE_API_KEY_PATH });
          return;
        }
        const zipFile = `${nodeBinary}.zip`;
        await run("zip", zipFile, nodeBinary);
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
