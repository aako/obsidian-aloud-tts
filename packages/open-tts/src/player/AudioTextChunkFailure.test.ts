import { describe, expect, it } from "vitest";
import { AudioTextChunk } from "./AudioTextChunk";
import { TTSErrorInfo } from "../models/tts-model";

describe("AudioTextChunk failure reporting", () => {
  it("preserves a provider error without rewriting it", () => {
    const chunk = new AudioTextChunk({ rawText: "Test", start: 0, end: 4 });
    const error = new TTSErrorInfo("Speechify HTTP 402", undefined, 402);
    chunk.setFailed(error);
    expect(chunk.failureInfo).toBe(error);
  });

  it("replaces unknown with a safe error category, without leaking messages", () => {
    const chunk = new AudioTextChunk({ rawText: "Test", start: 0, end: 4 });
    chunk.setFailed(new TypeError("private-secret-value"));
    expect(chunk.failureInfo?.message).toContain("TypeError");
    expect(chunk.failureInfo?.message).not.toContain("private-secret-value");
  });
});
