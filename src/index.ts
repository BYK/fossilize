export type { FossilizeOptions } from "./impl";
export type { AssetMap, ViteManifest, ViteManifestChunk } from "./assets";
export { collectAssets, collectViteManifestAssets } from "./assets";

import type { FossilizeOptions } from "./impl";
import { buildContext } from "./context";

export async function fossilize(
  options: FossilizeOptions,
  entrypoint: string = ".",
): Promise<void> {
  const impl = (await import("./impl")).default;
  const context = buildContext(process);
  return impl.call(context, options, entrypoint);
}
