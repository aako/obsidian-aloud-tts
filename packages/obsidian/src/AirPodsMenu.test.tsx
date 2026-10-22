import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { createTTSActions } from "open-tts";
import { TTSControlMenuContent } from "./components/TTSControlMenu";
import {
  createMockObsidianBridge,
  createTestAudioStore,
  createTestSettingsStore,
} from "./test-utils";

describe("explicit saved-article menu", () => {
  it("exposes separate Resume and Start Over actions while idle", async () => {
    const player = createTestAudioStore();
    const settings = await createTestSettingsStore();
    const bridge = createMockObsidianBridge();
    vi.mocked(bridge.hasSavedReading).mockReturnValue(true);
    vi.mocked(bridge.readingProgressLabel).mockReturnValue(
      "Saved: sentence 10",
    );
    const onClose = vi.fn();
    render(
      <TTSControlMenuContent
        actions={createTTSActions(player, settings, bridge)}
        player={player}
        settings={settings}
        bridge={bridge}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Saved: sentence 10")).toBeTruthy();
    fireEvent.click(screen.getByText("Resume saved article"));
    expect(bridge.resumeSavedReading).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Start Over"));
    expect(bridge.startOver).toHaveBeenCalledOnce();
    expect(bridge.playSelection).not.toHaveBeenCalled();
    player.destroy();
  });
});
