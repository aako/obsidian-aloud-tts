import { afterEach, describe, expect, it, vi } from "vitest";
import {
  elevenLabsCallTextToSpeech,
  elevenLabsTextToSpeech,
} from "./elevenlabs";
import { hashAudioInputs } from "../player/AudioCache";
import { DEFAULT_SETTINGS, voiceHash } from "../player/TTSPluginSettings";

const base = {
  ...DEFAULT_SETTINGS,
  elevenlabs_apiKey: "test-key",
  elevenlabs_voice: "test-voice",
  elevenlabs_model: "eleven_multilingual_v2",
};

const optionsFor = (
  stability: number | undefined,
  similarity: number | undefined,
) =>
  elevenLabsTextToSpeech.convertToOptions({
    ...base,
    elevenlabs_stability: stability,
    elevenlabs_similarity: similarity,
  });

afterEach(() => vi.restoreAllMocks());

describe("ElevenLabs rendering identity without default-cache migration", () => {
  it("preserves the exact pre-ios.17 default cache identity", () => {
    const original = {
      apiKey: "test-key",
      model: "eleven_multilingual_v2",
      voice: "test-voice",
    };
    const defaults = optionsFor(0.5, 0.75);
    expect(voiceHash(defaults)).toBe(voiceHash(original));
    expect(hashAudioInputs("Same sentence", defaults, "mp3")).toBe(
      hashAudioInputs("Same sentence", original, "mp3"),
    );
  });

  it("gives different cache keys to different custom rendering settings", () => {
    const defaults = optionsFor(0.5, 0.75);
    const stable = optionsFor(0.2, 0.75);
    const similar = optionsFor(0.5, 0.2);
    const unset = optionsFor(undefined, 0.75);
    const keys = [defaults, stable, similar, unset].map((x) =>
      hashAudioInputs("Same sentence", x, "mp3"),
    );
    expect(new Set(keys).size).toBe(4);
    expect(hashAudioInputs("Same sentence", stable, "mp3")).toBe(keys[1]);
  });

  it("captures rendering choices at queue time instead of reading a later change", async () => {
    const settings = {
      ...base,
      elevenlabs_stability: 0.2,
      elevenlabs_similarity: 0.6,
    };
    const queued = elevenLabsTextToSpeech.convertToOptions(settings);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as Response);
    // An in-flight request should not unexpectedly use the new settings.
    settings.elevenlabs_stability = 0.95;
    settings.elevenlabs_similarity = 0.1;
    await elevenLabsCallTextToSpeech("Hello", queued, settings);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0][1];
    const body = JSON.parse(String(request?.body));
    expect(body.voice_settings).toEqual({
      stability: 0.2,
      similarity_boost: 0.6,
    });
    expect(queued.elevenLabsVoiceSettings).toEqual({
      stability: 0.2,
      similarity: 0.6,
    });
  });

  it("preserves the direct-library caller fallback when no snapshot exists", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as Response);
    await elevenLabsCallTextToSpeech(
      "Hello",
      {
        apiKey: "test-key",
        model: "eleven_multilingual_v2",
        voice: "test-voice",
      },
      { ...base, elevenlabs_stability: 0.35, elevenlabs_similarity: 0.45 },
    );
    const request = fetchSpy.mock.calls[0][1];
    const body = JSON.parse(String(request?.body));
    expect(body.voice_settings).toEqual({
      stability: 0.35,
      similarity_boost: 0.45,
    });
  });
});
