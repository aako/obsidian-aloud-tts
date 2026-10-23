import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, voiceHash } from "../player/TTSPluginSettings";
import {
  listSpeechifyVoices,
  speechifySynthesize,
  speechifyRequestGate,
  speechifyTextToSpeech,
  configureSpeechifyTransport,
  type SpeechifyHttpRequest,
  type SpeechifyHttpResponse,
} from "./speechify";

const settings = {
  ...DEFAULT_SETTINGS,
  speechifyApiKey: "test-only-key",
  speechifyVoice: "geffen_32",
  speechifyModel: "simba-3.2" as const,
  speechifyMonthlyBudget: 1000,
};
const options = speechifyTextToSpeech.convertToOptions(settings);

beforeEach(() => {
  vi.restoreAllMocks();
  configureSpeechifyTransport();
  speechifyRequestGate.initialize(
    {
      month: new Date().toISOString().slice(0, 7),
      characters: 0,
      starts: [],
      blockedUntil: 0,
    },
    async () => undefined,
  );
});

describe("Speechify streaming", () => {
  it("routes both catalog and MP3 through an injected native transport, never browser fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const calls: SpeechifyHttpRequest[] = [];
    configureSpeechifyTransport(
      async (request): Promise<SpeechifyHttpResponse> => {
        calls.push(request);
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) =>
              name.toLowerCase() === "content-type" ? "audio/mpeg" : null,
          },
          json: async () => ({
            voices: [
              {
                id: "geffen_32",
                display_name: "Geffen",
                locale: "en-US",
                gender: "male",
              },
            ],
            has_more: false,
          }),
          arrayBuffer: async () =>
            new Uint8Array([0xff, 0xfb, 0x90, 0x01]).buffer,
        };
      },
    );
    expect(
      await listSpeechifyVoices("test-only-key", "simba-3.2"),
    ).toHaveLength(1);
    expect(
      (await speechifySynthesize("Hello!", options, settings)).format,
    ).toBe("mp3");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(calls[0].url).toContain("locale=en-US");
    expect(calls[1].url).toBe("https://api.speechify.ai/v1/audio/stream");
    expect(calls[1].headers.Authorization).toBe("Bearer test-only-key");
    expect(JSON.parse(String(calls[1].body))).toEqual({
      input: "Hello!",
      voice_id: "geffen_32",
      model: "simba-3.2",
    });
    expect(speechifyRequestGate.used).toBe(6);
  });

  it("reports the native HTTP error rather than retrying a billable request", async () => {
    const requests: SpeechifyHttpRequest[] = [];
    configureSpeechifyTransport(
      async (request): Promise<SpeechifyHttpResponse> => {
        requests.push(request);
        return {
          ok: false,
          status: 401,
          headers: { get: () => "application/json" },
          json: async () => ({ error: { code: "unauthorized" } }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    );
    await expect(
      speechifySynthesize("Hello!", options, settings),
    ).rejects.toThrow("401");
    expect(requests).toHaveLength(1);
    expect(speechifyRequestGate.used).toBe(6);
  });

  it("sends a bearer token and receives MP3 bytes without sending a real request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x01]).buffer,
    } as unknown as Response);
    const audio = await speechifySynthesize("Hello!", options, settings);
    expect(audio.format).toBe("mp3");
    expect(new Uint8Array(audio.data)).toEqual(
      new Uint8Array([0xff, 0xfb, 0x90, 0x01]),
    );
    expect(speechifyRequestGate.used).toBe(6);
    const [url, request] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.speechify.ai/v1/audio/stream");
    const config = request as RequestInit;
    expect(config.headers).toMatchObject({
      Authorization: "Bearer test-only-key",
      Accept: "audio/mpeg",
    });
    expect(JSON.parse(String(config.body))).toEqual({
      input: "Hello!",
      voice_id: "geffen_32",
      model: "simba-3.2",
    });
  });

  it("starts with synthesis blocked and makes no request when the cap is zero", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      speechifySynthesize("Hello!", options, {
        ...settings,
        speechifyMonthlyBudget: 0,
      }),
    ).rejects.toThrow("budget reached");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized chunks before the reservation or network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      speechifySynthesize("A".repeat(20001), options, settings),
    ).rejects.toThrow("exceeds stream input limit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on unsuccessful or non-audio responses", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: async () => ({ error: { code: "payment_required" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response);
    await expect(speechifySynthesize("One", options, settings)).rejects.toThrow(
      "402",
    );
    await expect(speechifySynthesize("Two", options, settings)).rejects.toThrow(
      "MP3",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(speechifyRequestGate.used).toBe(6);
  });

  it("has unique cache identities for different voices and models", () => {
    const changedVoice = speechifyTextToSpeech.convertToOptions({
      ...settings,
      speechifyVoice: "beatrice_32",
    });
    const changedModel = speechifyTextToSpeech.convertToOptions({
      ...settings,
      speechifyModel: "simba-3.5",
    });
    expect(voiceHash(options)).not.toBe(voiceHash(changedVoice));
    expect(voiceHash(options)).not.toBe(voiceHash(changedModel));
  });

  it("lists US voices using the documented envelope without billable synthesis", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        voices: [
          {
            id: "geffen_32",
            display_name: "Geffen",
            locale: "en-US",
            gender: "male",
          },
          {
            id: "british",
            display_name: "British",
            locale: "en-GB",
            gender: "male",
          },
        ],
        has_more: false,
      }),
    } as Response);
    expect(await listSpeechifyVoices("fake", "simba-3.2")).toEqual([
      { id: "geffen_32", name: "Geffen", locale: "en-US", gender: "male" },
    ]);
    expect(String(spy.mock.calls[0][0])).toContain("locale=en-US");
    expect(String(spy.mock.calls[0][0])).toContain("model=simba-3.2");
  });
});
