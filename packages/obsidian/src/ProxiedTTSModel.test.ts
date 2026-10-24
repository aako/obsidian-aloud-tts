import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TTSPluginSettings } from "open-tts";
import { ProxiedTTSModel } from "./ProxiedTTSModel";

const spies = vi.hoisted(() => ({
  speechify: vi.fn(),
  openai: vi.fn(),
}));

vi.mock("open-tts", () => ({
  REGISTRY: {
    speechify: {
      call: spies.speechify,
      convertToOptions: () => ({ model: "shared-model", voice: "same" }),
      validateConnection: async () => undefined,
    },
    openai: {
      call: spies.openai,
      convertToOptions: () => ({ model: "shared-model", voice: "same" }),
      validateConnection: async () => undefined,
    },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  spies.speechify.mockResolvedValue({
    data: new ArrayBuffer(4),
    format: "mp3",
  });
  spies.openai.mockResolvedValue({ data: new ArrayBuffer(4), format: "mp3" });
});

describe("provider-bound queued synthesis", () => {
  it("uses the original provider even after the selected provider changes", async () => {
    const settings = { modelProvider: "speechify" } as TTSPluginSettings;
    const proxy = ProxiedTTSModel(settings);
    const queued = proxy.convertToOptions(settings);
    expect(queued.modelProvider).toBe("speechify");

    settings.modelProvider = "openai";
    await proxy.call("Hello", queued, settings);
    expect(spies.speechify).toHaveBeenCalledTimes(1);
    expect(spies.openai).not.toHaveBeenCalled();
  });

  it("new requests use the new provider; equivalent voice names remain distinct", async () => {
    const settings = { modelProvider: "speechify" } as TTSPluginSettings;
    const proxy = ProxiedTTSModel(settings);
    const oldOptions = proxy.convertToOptions(settings);
    settings.modelProvider = "openai";
    const newOptions = proxy.convertToOptions(settings);
    expect(newOptions.modelProvider).toBe("openai");
    expect(oldOptions.model).toBe(newOptions.model);
    expect(oldOptions.voice).toBe(newOptions.voice);
    expect(oldOptions).not.toEqual(newOptions);
    await proxy.call("Hello", newOptions, settings);
    expect(spies.openai).toHaveBeenCalledTimes(1);
    expect(spies.speechify).not.toHaveBeenCalled();
  });

  it("preserves fallback routing for older untagged options", async () => {
    const settings = { modelProvider: "openai" } as TTSPluginSettings;
    await ProxiedTTSModel(settings).call(
      "Hello",
      { model: "legacy" },
      settings,
    );
    expect(spies.openai).toHaveBeenCalledTimes(1);
  });
});
