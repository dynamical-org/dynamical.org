// Counts the response body bytes a fetch receives, as they stream in, for the status line's
// "12.4 MB received". Scoped: only the fetches passed through it are counted, and a metered
// response keeps its status, headers and abort behaviour (an aborted fetch errors the stream).
// Bytes are the body as fetch delivers it (after content decoding, possibly from the browser
// cache), so this is data received, not exact network transfer.

/**
 * @param {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {(bytes: number) => void} onBytes called with each body chunk's size
 * @returns {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>}
 */
export function meteredFetch(fetchImpl, onBytes) {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.body) return response;
    const count = new TransformStream({
      transform(chunk, controller) {
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(count), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Bytes as decimal megabytes, e.g. "12.4 MB". */
export const formatMB = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e6 ? 2 : 1)} MB`;
