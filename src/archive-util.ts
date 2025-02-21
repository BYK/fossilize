import { Writable } from "node:stream";
import { promisify } from "node:util";
import * as tar from "tar-stream";
import XZDecompress from "xz-decompress";
import yauzl from "yauzl";

type BufferPromiseConstructorParams = Parameters<
  ConstructorParameters<typeof Promise<Buffer>>[0]
>;

async function bufferFromAsync(iterator: {
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const yauzlOpen = promisify(yauzl.open);
export async function unzip(
  sourceFile: string,
  targetFile: string
): Promise<Buffer> {
  let found = false;
  // @ts-expect-error -- For some reason, TS is selecting the wrong overload for yauzl.open with promisify above
  const zipfile = await yauzlOpen(sourceFile, { lazyEntries: true });
  let resolve: BufferPromiseConstructorParams[0],
    reject: BufferPromiseConstructorParams[1];
  const promise = new Promise<Buffer>((res, rej) => {
    resolve = res;
    reject = rej;
  });

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
      resolve(bufferFromAsync(readStream));
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
export async function untar(
  sourceStream: ReadableStream,
  targetFile: string
): Promise<Buffer> {
  const extract = tar.extract();
  new XZDecompress.XzReadableStream(sourceStream).pipeTo(
    Writable.toWeb(extract)
  );

  let result: Buffer | undefined;
  for await (const entry of extract) {
    if (entry.header.name !== targetFile) {
      entry.resume();
      continue;
    }
    // We cannot return here as we need to consume the
    // stream to completion to avoid resource leaks and
    // early termination of the decompression, causing a
    // corrupted buffer.
    result = await bufferFromAsync(entry);
  }

  if (!result) {
    throw new Error(`File "${targetFile}" not found in tar archive.`);
  }
  return result;
}
