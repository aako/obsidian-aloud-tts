import { describe, expect, it } from "vitest";
import { hashAudioInputs } from "./AudioCache";
import { inFlightRequestKey, maxRetriesForRequest } from "./ChunkLoader";

describe("queued provider identity", () => {
  const speechify = {
    modelProvider: "speechify" as const,
    model: "shared-model",
    voice: "same",
  };
  const openai = {
    modelProvider: "openai" as const,
    model: "shared-model",
    voice: "same",
  };

  it("separates in-flight provider work even for otherwise equal options", () => {
    const speechifyKey = inFlightRequestKey("Hello", speechify, "openai");
    const openaiKey = inFlightRequestKey("Hello", openai, "openai");
    expect(speechifyKey).not.toBe(openaiKey);
    // Preserve existing persistent audio key scheme; migration is a separate task.
    expect(hashAudioInputs("Hello", speechify, "mp3")).toBe(
      hashAudioInputs("Hello", openai, "mp3"),
    );
  });

  it("does not enable retries for queued Speechify or Azure after a switch", () => {
    expect(maxRetriesForRequest(speechify, "openai")).toBe(0);
    expect(
      maxRetriesForRequest({ ...speechify, modelProvider: "azure" }, "openai"),
    ).toBe(0);
    expect(maxRetriesForRequest(openai, "speechify")).toBe(3);
  });

  it("retains legacy fallback for untagged options", () => {
    const legacy = { model: "old" };
    expect(maxRetriesForRequest(legacy, "speechify")).toBe(0);
    expect(maxRetriesForRequest(legacy, "openai")).toBe(3);
  });
});
