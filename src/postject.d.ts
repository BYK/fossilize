declare module "postject";

function inject(
  binPath: string,
  blobName: string,
  blobData: Buffer,
  options: { sentinelFuse: string; machoSegmentName?: string }
): Promise<void>;
