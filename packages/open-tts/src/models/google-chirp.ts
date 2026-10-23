import type { TTSPluginSettings } from "../player/TTSPluginSettings";
import {
  type AudioData,
  type AudioTextContext,
  type TTSModel,
  type TTSModelOptions,
  TTSErrorInfo,
  REQUIRE_API_KEY,
} from "./tts-model";
import { AzureRequestGate } from "./AzureRequestGate";

/** Independent instance: Google's usage never touches the Azure ledger. */
export const googleChirpRequestGate = new AzureRequestGate("Google Chirp");
const ENDPOINT = "https://texttospeech.googleapis.com/v1";
const CHIRP_NAME = /-Chirp3-HD-/;

export interface GoogleChirpVoice {
  id: string;
  name: string;
  locale: string;
  gender: string;
}

export function googleChirpCharacters(text: string): number {
  return Array.from(text).length;
}

/** Google has a hard input limit of 5,000 UTF-8 BYTES, not characters. */
export function googleChirpBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// Chirp synchronous SSML is currently a Google Preview feature.
// A trailing <break> MAY be trimmed by Google's synthesizer; validate on a
// short sample before caching entire documents.
const BASE_MODEL = "google-chirp3-hd-mp3-v1";
const PAUSE_MODEL = /^google-chirp3-hd-mp3-v1-pause-(\d{1,4})$/;

export function chirpPauseFromModel(model: string): number {
  const match = model.match(PAUSE_MODEL);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) && value >= 0 && value <= 1200 ? value : 0;
}

export function chirpPauseDuration(text: string, baseMs: number): number {
  if (!baseMs) return 0;
  const end = text.trimEnd();
  // Punctuation-aware durations: a question gets a slightly more reflective gap;
  // a paragraph/ellipsis gets a longer one. Hard limit is 2,000 milliseconds.
  const factor =
    /\n\s*\n\s*$/.test(text) || /(\.{3,}|…)$/.test(end)
      ? 1.65
      : /[?？]["'’”)]*$/.test(end)
        ? 1.35
        : /[!！]["'’”)]*$/.test(end)
          ? 1.15
          : 1;
  return Math.min(2000, Math.round((baseMs * factor) / 25) * 25);
}

function escapeSSML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function chirpSynthesisInput(
  text: string,
  model: string,
): { text: string } | { ssml: string } {
  const ms = chirpPauseDuration(text, chirpPauseFromModel(model));
  if (!ms) return { text };
  return { ssml: `<speak>${escapeSSML(text)}<break time="${ms}ms"/></speak>` };
}

function requireVoice(value?: string): string {
  if (!value || !CHIRP_NAME.test(value)) {
    throw new Error("Select a Chirp 3 HD voice before synthesis.");
  }
  return value;
}

async function googleError(response: Response): Promise<never> {
  let message = `Google Cloud TTS HTTP ${response.status}`;
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object" && "error" in data) {
      const error = (data as { error?: { message?: string } }).error;
      if (typeof error?.message === "string") message += `: ${error.message}`;
    }
  } catch {
    /* Google sometimes returns empty/non-JSON bodies. */
  }
  throw new TTSErrorInfo(message, undefined, response.status);
}

/** Only lists Chirp 3 HD voices. Does not synthesize or use the request ledger. */
export async function listGoogleChirpVoices(
  apiKey: string,
): Promise<GoogleChirpVoice[]> {
  if (!apiKey.trim()) throw new Error("Enter a Google Cloud API key.");
  const response = await fetch(`${ENDPOINT}/voices`, {
    headers: { "X-Goog-Api-Key": apiKey },
  });
  if (!response.ok) return googleError(response);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("voices" in body) ||
    !Array.isArray((body as { voices: unknown }).voices)
  ) {
    throw new Error("Google returned an invalid voice catalog.");
  }
  const voices = (
    body as {
      voices: Array<{
        name?: string;
        languageCodes?: string[];
        ssmlGender?: string;
      }>;
    }
  ).voices;
  return voices
    .filter(
      (voice) => typeof voice.name === "string" && CHIRP_NAME.test(voice.name),
    )
    .map((voice) => ({
      id: voice.name!,
      name: voice.name!.split("-Chirp3-HD-")[1] || voice.name!,
      locale:
        voice.languageCodes?.[0] ??
        voice.name!.split("-").slice(0, 2).join("-"),
      gender: voice.ssmlGender ?? "UNSPECIFIED",
    }));
}

function mp3FromBase64(value: unknown): AudioData {
  if (
    typeof value !== "string" ||
    !value.length ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("Google returned no valid MP3 audio.");
  }
  const binary = atob(value);
  if (!binary.length) throw new Error("Google returned an empty MP3.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { data: bytes.buffer, format: "mp3" };
}

export async function googleChirpSynthesize(
  text: string,
  options: TTSModelOptions,
  settings: TTSPluginSettings,
  context: AudioTextContext = {},
  signal?: AbortSignal,
): Promise<AudioData> {
  const voice = requireVoice(options.voice);
  if (!options.apiKey?.trim())
    throw new Error("Google Cloud TTS API key is missing.");
  if (!text.trim()) throw new Error("Cannot synthesize empty text.");
  const synthesisInput = chirpSynthesisInput(text, options.model);
  const requestText = "ssml" in synthesisInput ? synthesisInput.ssml : text;
  if (googleChirpBytes(requestText) > 5000)
    throw new Error(
      "Chirp 3 HD input exceeds Google's 5,000-byte limit including SSML. Use sentence chunking.",
    );
  const locale = voice.split("-").slice(0, 2).join("-");
  signal ??= context.request?.signal;
  const body = JSON.stringify({
    input: synthesisInput,
    voice: { languageCode: locale, name: voice },
    audioConfig: { audioEncoding: "MP3" },
  });
  // Retry only transient failures; every retry consumes another local reservation.
  for (let attempt = 0; ; attempt++) {
    try {
      return await googleChirpRequestGate.request(
        async () => {
          const response = await fetch(`${ENDPOINT}/text:synthesize`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": options.apiKey!,
            },
            body,
            ...(signal ? { signal } : {}),
          });
          if (!response.ok) return googleError(response);
          const result: unknown = await response.json();
          const content =
            result && typeof result === "object" && "audioContent" in result
              ? (result as { audioContent: unknown }).audioContent
              : null;
          return mp3FromBase64(content);
        },
        {
          // Conservatively reserve the complete SSML payload as an upper bound.
          characters: googleChirpCharacters(requestText),
          budget:
            context.request?.budgetLimit ?? settings.googleChirpMonthlyBudget,
          priority: context.request?.priority,
          signal,
          onWait: context.request?.onWait,
        },
      );
    } catch (error) {
      if (
        signal?.aborted ||
        attempt >= 2 ||
        !(error instanceof TTSErrorInfo) ||
        !error.isRetryable
      )
        throw error;
      googleChirpRequestGate.defer(Math.min(30000, (attempt + 1) * 2000));
    }
  }
}

export const googleChirpTTS: TTSModel = {
  call: googleChirpSynthesize,
  convertToOptions: (settings): TTSModelOptions => ({
    apiKey: settings.googleChirpApiKey,
    apiUri: ENDPOINT,
    // Changing pauses creates a new audio cache key. Selecting zero restores
    // the original ios.6 key and reuses all previously generated audio.
    model:
      Number.isSafeInteger(settings.googleChirpSentencePauseMs) &&
      settings.googleChirpSentencePauseMs > 0 &&
      settings.googleChirpSentencePauseMs <= 1200
        ? `${BASE_MODEL}-pause-${settings.googleChirpSentencePauseMs}`
        : BASE_MODEL,
    voice: settings.googleChirpVoice,
  }),
  validateConnection: async (settings) => {
    if (!settings.googleChirpApiKey?.trim()) return REQUIRE_API_KEY;
    try {
      const voices = await listGoogleChirpVoices(settings.googleChirpApiKey);
      if (!voices.length)
        return "No Chirp 3 HD voices returned by Google for this key.";
      return undefined;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Cannot connect to Google Cloud TTS.";
    }
  },
};
