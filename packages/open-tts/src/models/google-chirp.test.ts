import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  googleChirpRequestGate,
  googleChirpSynthesize,
  listGoogleChirpVoices,
  googleChirpCharacters,
  googleChirpBytes,
} from "./google-chirp";
import { DEFAULT_SETTINGS } from "../player/TTSPluginSettings";

const settings = {
  ...DEFAULT_SETTINGS,
  googleChirpApiKey: "fake-test-key",
  googleChirpMonthlyBudget: 900000,
};
const options = {
  apiKey: "fake-test-key",
  apiUri: "https://texttospeech.googleapis.com/v1",
  model: "google-chirp3-hd-mp3-v1",
  voice: "en-US-Chirp3-HD-Aoede",
};

beforeEach(() => {
  vi.restoreAllMocks();
  googleChirpRequestGate.initialize(
    {
      month: new Date().toISOString().slice(0, 7),
      characters: 0,
      starts: [],
      blockedUntil: 0,
    },
    async () => undefined,
  );
});

describe("Google Chirp provider", () => {
  it("filters all other voice models during discovery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        voices: [
          {
            name: "en-US-Neural2-A",
            languageCodes: ["en-US"],
            ssmlGender: "MALE",
          },
          {
            name: "en-US-Chirp3-HD-Aoede",
            languageCodes: ["en-US"],
            ssmlGender: "FEMALE",
          },
        ],
      }),
    } as Response);
    const voices = await listGoogleChirpVoices("fake-test-key");
    expect(voices).toHaveLength(1);
    expect(voices[0].name).toBe("Aoede");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/voices"),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Goog-Api-Key": "fake-test-key" }),
      }),
    );
  });

  it("generates MP3 from base64, reserves budget first, and never leaks key into URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ audioContent: "//uQAQ==" }),
    } as Response);
    const audio = await googleChirpSynthesize("Hello!", options, settings);
    expect(Array.from(new Uint8Array(audio.data))).toEqual([255, 251, 144, 1]);
    expect(audio.format).toBe("mp3");
    expect(googleChirpRequestGate.used).toBe(6);
    const [url, params] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(String(url)).not.toContain("fake-test-key");
    const payload = JSON.parse(String((params as RequestInit).body));
    expect(payload.input.text).toBe("Hello!");
    expect(payload.voice.name).toBe(options.voice);
    expect(payload.audioConfig.audioEncoding).toBe("MP3");
  });

  it("fails closed on local character exhaustion without contacting Google", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      googleChirpSynthesize("Hello!", options, {
        ...settings,
        googleChirpMonthlyBudget: 5,
      }),
    ).rejects.toThrow("budget reached");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses UTF-8 bytes for the hard request size cap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(googleChirpBytes("🙂")).toBe(4);
    expect(googleChirpCharacters("🙂")).toBe(1);
    await expect(
      googleChirpSynthesize("🙂".repeat(1251), options, settings),
    ).rejects.toThrow("5,000-byte");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never uses the Google gate for Azure", async () => {
    const { azureRequestGate } = await import("./AzureRequestGate");
    expect(azureRequestGate).not.toBe(googleChirpRequestGate);
  });
});
