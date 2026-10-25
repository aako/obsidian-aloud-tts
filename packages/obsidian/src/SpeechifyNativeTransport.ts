import type { requestUrl } from "obsidian";
import type { SpeechifyHttpTransport } from "open-tts";

/**
 * On iOS, Obsidian's native requestUrl cannot abort a dispatched request.
 * If it completes after the user cancels, its audio may already be billable.
 *
 * Keep the response: Speechify's normal decoder and ChunkLoader can validate
 * and cache the received bytes. The caller's playback cancellation remains
 * separate, so caching a late response does not reactivate playback.
 *
 * A signal that is already aborted BEFORE dispatch still prevents the POST.
 */
export function createObsidianSpeechifyTransport(
  send: typeof requestUrl,
): SpeechifyHttpTransport {
  return async ({ url, method, headers, body, signal }) => {
    if (signal?.aborted)
      throw new DOMException("Speechify request cancelled.", "AbortError");

    const response = await send({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      throw: false,
    });

    // Deliberately do not check signal.aborted after send(). The native request
    // cannot be stopped mid-flight, and discarding its completed response
    // would lose potentially paid audio. Other callers decide whether that
    // audio is still eligible to play.
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: {
        get: (name: string): string | null =>
          Object.entries(response.headers).find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
          )?.[1] ?? null,
      },
      json: async (): Promise<unknown> => response.json,
      arrayBuffer: async (): Promise<ArrayBuffer> => response.arrayBuffer,
    };
  };
}
