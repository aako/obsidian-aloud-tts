import { describe, expect, it, vi } from "vitest";
import { createTTSActions } from "open-tts";
import type { AudioStore, TTSPluginSettingsStore } from "open-tts";

// Regression: Stop must not tear down the audio subsystem on iOS.
describe("iOS playback recovery", () => {
  it("stops a session without destroying the reusable store", () => {
    const player = {
      activeText: null,
      closePlayer: vi.fn(),
      destroy: vi.fn(),
    } as unknown as AudioStore;
    const settings = {
      settings: { playbackSpeed: 1 },
    } as unknown as TTSPluginSettingsStore;
    createTTSActions(player, settings, { playSelection: vi.fn() }).stop();
    expect(player.closePlayer).toHaveBeenCalledOnce();
    expect(player.destroy).not.toHaveBeenCalled();
  });
});
