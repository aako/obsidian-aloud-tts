import type { TTSPluginSettings } from "../player/TTSPluginSettings";
import { AzureRequestGate } from "./AzureRequestGate";
import {
  type AudioData,
  type AudioTextContext,
  type TTSModel,
  type TTSModelOptions,
  TTSErrorInfo,
  REQUIRE_API_KEY,
} from "./tts-model";

const ENDPOINT = "https://api.speechify.ai/v1";
export const speechifyRequestGate = new AzureRequestGate("Speechify");

/** Keep the shared library independent of Obsidian's native requestUrl API. */
export interface SpeechifyHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface SpeechifyHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type SpeechifyHttpTransport = (
  request: SpeechifyHttpRequest,
) => Promise<SpeechifyHttpResponse>;

let speechifyNativeTransport: SpeechifyHttpTransport | undefined;

/** Obsidian installs an uncorsed transport at startup and clears it on unload. */
export function configureSpeechifyTransport(
  transport?: SpeechifyHttpTransport,
): void {
  speechifyNativeTransport = transport;
}

async function speechifyHttpRequest(
  request: SpeechifyHttpRequest,
): Promise<SpeechifyHttpResponse> {
  if (request.signal?.aborted)
    throw new DOMException("Speechify request cancelled.", "AbortError");
  if (speechifyNativeTransport) return speechifyNativeTransport(request);
  // The standalone web app continues to use normal fetch; only Obsidian
  // installs its native requestUrl transport, which avoids WebView CORS.
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
}

export type SpeechifyModel = "simba-3.0" | "simba-3.2" | "simba-3.5";
export interface SpeechifyVoice {
  id: string;
  name: string;
  locale: string;
  gender: string;
}

/** Plain-text requests; do not send SSML for this initial provider release. */
export function speechifyCharacters(text: string): number {
  return Array.from(text).length;
}

async function speechifyError(response: SpeechifyHttpResponse): Promise<never> {
  let message = `Speechify HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const error = (body as { error?: { code?: string } }).error;
      // Do not repeat untrusted remote error messages in console logs.
      if (
        typeof error?.code === "string" &&
        /^[a-z0-9_]{1,80}$/i.test(error.code)
      ) {
        message += ` (${error.code})`;
      }
    }
  } catch {
    // Non-JSON responses are normal for some transient API failures.
  }
  throw new TTSErrorInfo(message, undefined, response.status);
}

/** Voice discovery does not synthesize audio or reserve usage. */
export async function listSpeechifyVoices(
  apiKey: string,
  model: SpeechifyModel,
): Promise<SpeechifyVoice[]> {
  if (!apiKey.trim()) throw new Error("Enter a Speechify API key.");
  const voices: SpeechifyVoice[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ locale: "en-US", model });
    if (cursor) query.set("cursor", cursor);
    const response = await speechifyHttpRequest({
      url: `${ENDPOINT}/voices?${query.toString()}`,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return speechifyError(response);
    const raw: unknown = await response.json();
    if (
      !raw ||
      typeof raw !== "object" ||
      !("voices" in raw) ||
      !Array.isArray((raw as { voices: unknown }).voices)
    ) {
      throw new Error("Speechify returned an invalid voice catalog.");
    }
    const value = raw as {
      voices: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const voice of value.voices) {
      if (
        voice &&
        typeof voice.id === "string" &&
        voice.id &&
        typeof voice.locale === "string" &&
        voice.locale.toLowerCase() === "en-us" &&
        !seen.has(voice.id)
      ) {
        seen.add(voice.id);
        voices.push({
          id: voice.id,
          name:
            typeof voice.display_name === "string"
              ? voice.display_name
              : voice.id,
          locale: voice.locale,
          gender:
            typeof voice.gender === "string" ? voice.gender : "not_specified",
        });
      }
    }
    if (!value.has_more) return voices;
    if (!value.next_cursor || value.next_cursor === cursor)
      throw new Error("Speechify voice catalog pagination is incomplete.");
    cursor = value.next_cursor;
  }
  throw new Error("Speechify voice catalog exceeded pagination limit.");
}

/** One complete streamed MP3 per existing Aloud text chunk; no auto-retries. */
export async function speechifySynthesize(
  text: string,
  options: TTSModelOptions,
  settings: TTSPluginSettings,
  context: AudioTextContext = {},
  signal?: AbortSignal,
): Promise<AudioData> {
  if (!options.apiKey?.trim()) throw new Error("Speechify API key is missing.");
  if (!options.voice?.trim()) throw new Error("Select a Speechify voice.");
  if (!["simba-3.0", "simba-3.2", "simba-3.5"].includes(options.model))
    throw new Error("Unsupported Speechify synthesis model.");
  if (!text.trim()) throw new Error("Cannot synthesize empty text.");
  const characters = speechifyCharacters(text);
  if (characters > 20000 || new TextEncoder().encode(text).length > 32000)
    throw new Error(
      "Speechify chunk exceeds stream input limit. Use sentence chunking.",
    );
  signal ??= context.request?.signal;
  return speechifyRequestGate.request(
    async () => {
      const response = await speechifyHttpRequest({
        url: `${ENDPOINT}/audio/stream`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          input: text,
          voice_id: options.voice,
          model: options.model,
        }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) return speechifyError(response);
      const contentType = response.headers?.get("Content-Type") ?? "";
      if (contentType && !/^audio\/mpeg(?:;|$)/i.test(contentType))
        throw new Error("Speechify did not return an MP3 response.");
      const audio = await response.arrayBuffer();
      if (!audio.byteLength)
        throw new Error("Speechify returned an empty MP3 stream.");
      return { data: audio, format: "mp3" };
    },
    {
      characters,
      budget: context.request?.budgetLimit ?? settings.speechifyMonthlyBudget,
      priority: context.request?.priority,
      signal,
      onWait: context.request?.onWait,
    },
  );
}

export const speechifyTextToSpeech: TTSModel = {
  call: speechifySynthesize,
  convertToOptions: (settings): TTSModelOptions => ({
    apiKey: settings.speechifyApiKey,
    apiUri: ENDPOINT,
    model: settings.speechifyModel,
    voice: settings.speechifyVoice,
  }),
  validateConnection: async (settings) => {
    if (!settings.speechifyApiKey?.trim()) return REQUIRE_API_KEY;
    try {
      await listSpeechifyVoices(
        settings.speechifyApiKey,
        settings.speechifyModel,
      );
      return undefined;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Cannot connect to Speechify.";
    }
  },
};
