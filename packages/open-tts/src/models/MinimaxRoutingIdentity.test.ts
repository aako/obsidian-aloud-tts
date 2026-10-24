import { afterEach, describe, expect, it, vi } from "vitest";
import {
  minimaxCallTextToSpeech,
  minimaxTextToSpeech,
  MINIMAX_API_URL,
  MINIMAX_CHINA_API_URL,
} from "./minimax";
import { DEFAULT_SETTINGS, voiceHash } from "../player/TTSPluginSettings";
import { hashAudioInputs } from "../player/AudioCache";

const initial = {
  ...DEFAULT_SETTINGS,
  modelProvider: "minimax" as const,
  minimax_apiKey: "private-test-key",
  minimax_groupId: "group-alpha",
  minimax_useChinaEndpoint: false,
  minimax_ttsModel: "speech-2.6-turbo",
  minimax_ttsVoice: "English_expressive_narrator",
};
const optionsFor = (groupId: string, useChinaEndpoint: boolean) =>
  minimaxTextToSpeech.convertToOptions({
    ...initial,
    minimax_groupId: groupId,
    minimax_useChinaEndpoint: useChinaEndpoint,
  });

function stubSuccessfulAudio() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    status: 200,
    text: async () =>
      JSON.stringify({
        data: { audio: "fffb9001", status: 2 },
        base_resp: { status_code: 0, status_msg: "" },
      }),
  } as Response);
}

afterEach(() => vi.restoreAllMocks());

describe("MiniMax immutable routing and versioned cache identity", () => {
  it("takes an immutable value snapshot at enqueue time", () => {
    const settings = { ...initial };
    const queued = minimaxTextToSpeech.convertToOptions(settings);
    settings.minimax_groupId = "group-beta";
    settings.minimax_useChinaEndpoint = true;
    expect(queued.minimaxRouting).toEqual({
      groupId: "group-alpha",
      useChinaEndpoint: false,
    });
  });

  it("isolates both account groups and geographical endpoints in cache keys", () => {
    const settings = [
      optionsFor("group-alpha", false),
      optionsFor("group-beta", false),
      optionsFor("group-alpha", true),
      optionsFor("group-beta", true),
    ];
    const keys = settings.map((opt) =>
      hashAudioInputs("Same exact sentence", opt, "mp3"),
    );
    expect(new Set(keys).size).toBe(4);
    expect(hashAudioInputs("Same exact sentence", settings[0], "mp3")).toBe(
      keys[0],
    );
  });

  it("does not reuse ambiguous old MiniMax keys or alter unrelated provider keys", () => {
    const oldOptions = {
      apiKey: "private-test-key",
      model: initial.minimax_ttsModel,
      voice: initial.minimax_ttsVoice,
    };
    const captured = optionsFor("group-alpha", false);
    expect(hashAudioInputs("Hello", captured, "mp3")).not.toBe(
      hashAudioInputs("Hello", oldOptions, "mp3"),
    );
    const speechify = {
      modelProvider: "speechify" as const,
      apiKey: "different-test-key",
      model: "simba-3.2",
      voice: "geffen_32",
    };
    expect(voiceHash(speechify)).toBe(
      voiceHash({ model: speechify.model, voice: speechify.voice }),
    );
  });

  it("dispatches to the originally selected group and endpoint after live changes", async () => {
    const settings = { ...initial };
    const queued = optionsFor("group-alpha", false);
    const fetchSpy = stubSuccessfulAudio();
    settings.minimax_groupId = "group-beta";
    settings.minimax_useChinaEndpoint = true;
    const audio = await minimaxCallTextToSpeech("Hello", queued, settings);
    expect(audio.format).toBe("mp3");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      `${MINIMAX_API_URL}/v1/t2a_v2?GroupId=group-alpha`,
    );
  });

  it("honors a captured China endpoint despite subsequent settings changes", async () => {
    const settings = { ...initial, minimax_useChinaEndpoint: true };
    const queued = optionsFor("group-alpha", true);
    const fetchSpy = stubSuccessfulAudio();
    settings.minimax_groupId = "group-beta";
    settings.minimax_useChinaEndpoint = false;
    await minimaxCallTextToSpeech("Hello", queued, settings);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      `${MINIMAX_CHINA_API_URL}/v1/t2a_v2?GroupId=group-alpha`,
    );
  });

  it("keeps older direct-library callers compatible", async () => {
    const fetchSpy = stubSuccessfulAudio();
    const untagged = {
      apiKey: "private-test-key",
      model: "speech-2.6-turbo",
      voice: "English_expressive_narrator",
    };
    await minimaxCallTextToSpeech("Hello", untagged, {
      ...initial,
      minimax_groupId: "legacy-group",
      minimax_useChinaEndpoint: true,
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      `${MINIMAX_CHINA_API_URL}/v1/t2a_v2?GroupId=legacy-group`,
    );
  });
});
