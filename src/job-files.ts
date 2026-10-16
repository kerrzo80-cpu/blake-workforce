const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class JobFileError extends Error {
  constructor(public status: 403 | 503) {
    super(status === 403 ? "This file is unavailable for your assigned work." : "Could not download this file. Please try again.");
  }
}

export async function downloadJobFile(storeUrl: string, syncSecret: string | undefined, scope: {
  companyId: string; accountId: string; jobId: string; jobDate: string; documentId: string;
}) {
  if (!syncSecret) throw new JobFileError(503);
  const response = await fetch(storeUrl + "/workforce/mobile/files/download", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(45000),
    headers: { "content-type": "application/json", "x-blake-sync-secret": syncSecret },
    body: JSON.stringify(scope),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new JobFileError([400, 403, 404].includes(response.status) ? 403 : 503);
  }
  const length = response.headers.get("content-length");
  if ((length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES)) || !response.body) {
    await response.body?.cancel();
    throw new JobFileError(503);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new JobFileError(503);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new JobFileError(503);
  return {
    bytes: Buffer.concat(chunks, size),
    mimeType: response.headers.get("content-type") || "application/octet-stream",
    disposition: response.headers.get("content-disposition")?.startsWith("attachment")
      ? response.headers.get("content-disposition")! : "attachment",
  };
}
