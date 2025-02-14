import { buildApplication, buildCommand } from "@stricli/core";
import { description, name, version } from "../package.json";

const command = buildCommand({
  loader: async () => import("./impl"),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "entrypoint",
          brief: "Path to the file or project to fossilize",
          parse: String,
          default: ".",
        },
      ],
    },
    flags: {
      nodeVersion: {
        kind: "parsed",
        parse: String,
        brief: "Node.js version to fossilize with",
        default: "local",
      },
      platforms: {
        kind: "parsed",
        parse: String,
        brief: "Target platforms to fossilize for",
        variadic: true,
        optional: true,
      },
      assets: {
        kind: "parsed",
        parse: String,
        brief: "Any assets to bundle in", // Mention SEA read assets
        variadic: true,
        optional: true,
      },
      assetManifest: {
        kind: "parsed",
        parse: String,
        brief:
          "Path to the asset manifest.json from Vite (this will auto discover assets)",
        optional: true,
      },
      outDir: {
        kind: "parsed",
        parse: String,
        brief: "Output directory",
        default: "dist-bin",
      },
      outputName: {
        kind: "parsed",
        parse: String,
        brief: "Output file name (overrides inferred name from package.json)",
        optional: true,
      },
      cacheDir: {
        kind: "parsed",
        parse: String,
        brief: "Cache directory for Node.js binaries",
        default: ".node-cache", // todo, change this to global
      },
      noCache: {
        kind: "boolean",
        brief: "Do not use the cache for Node.js binaries",
        optional: true,
      },
      noBundle: {
        kind: "boolean",
        brief: "Do not bundle the entrypoint using esbuild",
        optional: false,
      },
      sign: {
        kind: "boolean",
        brief: "Skip signing for macOS and Windows",
        optional: false,
        default: false,
      },
      concurrencyLimit: {
        kind: "parsed",
        parse: Number,
        brief: "Limit the number of concurrent downloads or builds",
        default: "3",
      },
    },
    aliases: {
      n: "nodeVersion",
      d: "outDir",
      o: "outputName",
      p: "platforms",
      a: "assets",
      m: "assetManifest",
      l: "concurrencyLimit",
    },
  },
  docs: {
    brief: description,
  },
});

export const app = buildApplication(command, {
  name,
  scanner: {
    caseStyle: "allow-kebab-for-camel",
  },
  versionInfo: {
    currentVersion: version,
  },
});
