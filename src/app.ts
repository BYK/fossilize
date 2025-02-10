import { buildApplication, buildCommand } from "@stricli/core";
import { name, version, description } from "../package.json";
import { tmpdir } from "node:os";

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
        brief: "NodeJS version to fossilize with",
        // TODO: Make this dynamic to get latest version
        // TODO: Also allow "local" to use the node version on the system - this should limit the platforms to the current system
        default: "22.11.0",
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
      cacheDir: {
        kind: "parsed",
        parse: String,
        brief: "Cache directory for NodeJS binaries",
        default: ".node-cache", // todo, change this to global
      },
      noCache: {
        kind: "boolean",
        brief: "Do not use the cache for NodeJS binaries",
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
    },
    aliases: {
      n: "nodeVersion",
      p: "platforms",
      a: "assets",
      m: "assetManifest",
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
