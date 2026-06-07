export type { FossilizeOptions } from "./impl";
export type { SEAConfig } from "./impl";

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
