import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { requestUrl } from "obsidian";
import {
  ChunkLoader,
  DEFAULT_SETTINGS,
  configureSpeechifyTransport,
  speechifyRequestGate,
  speechifySynthesize,
  speechifyTextToSpeech,
  type AudioData,
  type AudioSystem,
  type TTSPluginSettings,
} from "open-tts";
import { createObsidianSpeechifyTransport } from "./SpeechifyNativeTransport";

type NativeResponse = Awaited<ReturnType<typeof requestUrl>>;

const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x01]);
const optionsText = "A paid sentence that should not be discarded.";

function nativeResponse(streaming = false): NativeResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": streaming ? "audio/mpeg" : "application/json",
    },
    json: { audio_format: "mp3", audio_data: "//uQAQ==" },
    arrayBuffer: mp3Bytes.slice().buffer,
  } as unknown as NativeResponse;
}

function deferredNativeSend() {
  let settle!: (response: NativeResponse) => void;
  const send = vi.fn(
    (_request: { url: string }) =>
      new Promise<NativeResponse>((resolve) => {
        settle = resolve;
      }),
  );
  return {
    send,
    complete: (streaming = false) => settle(nativeResponse(streaming)),
  };
}

const loaders: ChunkLoader[] = [];

function session(native: ReturnType<typeof deferredNativeSend>) {
  const settings: TTSPluginSettings = {
    ...DEFAULT_SETTINGS,
    modelProvider: "speechify",
    speechifyApiKey: "offline-test-key",
    speechifyVoice: "geffen_32",
    speechifyModel: "simba-3.2",
    speechifyMonthlyBudget: 5000,
  };
  const options = {
    ...speechifyTextToSpeech.convertToOptions(settings),
    modelProvider: "speechify" as const,
  };
  const saved = new Map<string, AudioData>();
  const storage = {
    getAudio: vi.fn(async (text: string) => saved.get(text) ?? null),
    saveAudio: vi.fn(
      async (text: string, _options: unknown, audio: AudioData) => {
        saved.set(text, audio);
      },
    ),
  };
  const system = {
    settings,
    config: { backgroundLoaderIntervalMillis: 1000 },
    ttsModel: {
      convertToOptions: vi.fn(() => options),
      call: vi.fn(speechifySynthesize),
    },
    storage,
    audioStore: { activeText: null },
  } as unknown as AudioSystem;
  configureSpeechifyTransport(
    createObsidianSpeechifyTransport(sendAsRequestUrl(native.send)),
  );
  const loader = new ChunkLoader({ system });
  loaders.push(loader);
  return { loader, options, storage, saved };
}

function sendAsRequestUrl(
  send: ReturnType<typeof deferredNativeSend>["send"],
): typeof requestUrl {
  return send as unknown as typeof requestUrl;
}

beforeEach(() => {
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

afterEach(() => {
  for (const loader of loaders.splice(0)) loader.destroy();
  configureSpeechifyTransport();
  vi.restoreAllMocks();
});

describe("native Speechify cancellation: protect already-dispatched audio", () => {
  it("refuses to dispatch if the signal was already cancelled", async () => {
    const native = deferredNativeSend();
    const transport = createObsidianSpeechifyTransport(
      sendAsRequestUrl(native.send),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport({
        url: "https://api.speechify.ai/v1/audio/speech",
        method: "POST",
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(native.send).not.toHaveBeenCalled();
  });

  it("keeps a completed native response after cancellation during the POST", async () => {
    const native = deferredNativeSend();
    const transport = createObsidianSpeechifyTransport(
      sendAsRequestUrl(native.send),
    );
    const controller = new AbortController();
    const completed = transport({
      url: "https://api.speechify.ai/v1/audio/speech",
      method: "POST",
      headers: {},
      signal: controller.signal,
    });
    expect(native.send).toHaveBeenCalledTimes(1);
    controller.abort();
    native.complete();
    const response = await completed;
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({
      audio_format: "mp3",
      audio_data: "//uQAQ==",
    });
    expect(native.send).toHaveBeenCalledTimes(1);
  });

  it("retains late successful MP3 bytes through the shared loader cache", async () => {
    const native = deferredNativeSend();
    const { loader, options, storage } = session(native);
    const controller = new AbortController();
    const synthesis = loader.load(optionsText, options, {
      request: { priority: "foreground", signal: controller.signal },
    });
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    controller.abort();
    native.complete();
    const audio = await synthesis;
    expect(new Uint8Array(audio.data)).toEqual(mp3Bytes);
    expect(storage.saveAudio).toHaveBeenCalledTimes(1);
    expect(await storage.getAudio(optionsText, options, "mp3")).toEqual(audio);
    // A subsequent read comes from the cache; no second billable request.
    await expect(loader.load(optionsText, options)).resolves.toEqual(audio);
    expect(native.send).toHaveBeenCalledTimes(1);
  });

  it("also retains a late completed MP3 stream, not only the JSON endpoint", async () => {
    const native = deferredNativeSend();
    const { loader, options, storage } = session(native);
    const controller = new AbortController();
    const longText = "Z".repeat(2001);
    const synthesis = loader.load(longText, options, {
      request: { priority: "foreground", signal: controller.signal },
    });
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    expect(native.send.mock.calls[0][0].url).toContain("/audio/stream");
    controller.abort();
    native.complete(true);
    const audio = await synthesis;
    expect(audio.format).toBe("mp3");
    expect(new Uint8Array(audio.data)).toEqual(mp3Bytes);
    expect(storage.saveAudio).toHaveBeenCalledTimes(1);
    expect(native.send).toHaveBeenCalledTimes(1);
  });

  it("still blocks a cancelled request while its usage reservation is pending", async () => {
    let finishLedger!: () => void;
    const ledgerRelease = new Promise<void>((resolve) => {
      finishLedger = resolve;
    });
    const persisted = vi.fn(async () => ledgerRelease);
    speechifyRequestGate.initialize(
      {
        month: new Date().toISOString().slice(0, 7),
        characters: 0,
        starts: [],
        blockedUntil: 0,
      },
      persisted,
    );
    const native = deferredNativeSend();
    const { loader, options, storage } = session(native);
    const controller = new AbortController();
    const synthesis = loader.load("Reserved, not sent", options, {
      request: { priority: "foreground", signal: controller.signal },
    });
    await vi.waitFor(() => expect(persisted).toHaveBeenCalledTimes(1));
    controller.abort();
    finishLedger();
    await expect(synthesis).rejects.toMatchObject({ name: "AbortError" });
    expect(native.send).not.toHaveBeenCalled();
    expect(storage.saveAudio).not.toHaveBeenCalled();
  });
});
