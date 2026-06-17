const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

async function responseToCappedBuffer(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File is too large: ${contentLength} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error('File exceeded download size limit');
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function downloadSlackFile(url: string, token: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);
  return responseToCappedBuffer(response);
}
