import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { AudioStore } from "open-tts";
import { GlobalMobilePlayer } from "./GlobalMobilePlayer";
import {
  createMockObsidianBridge,
  createTestSettingsStore,
} from "../test-utils";

function samplePlayer(active: boolean): AudioStore {
  return {
    activeText: active
      ? {
          audio: {
            filename: "Articles/Whose Leash.md",
            chunks: Array.from({ length: 85 }, () => ({})),
          },
          position: 73,
          isPlaying: true,
          pause: vi.fn(),
          play: vi.fn(),
          goToPrevious: vi.fn(),
          goToNext: vi.fn(),
        }
      : null,
    closePlayer: vi.fn(),
  } as unknown as AudioStore;
}

function phoneBridge() {
  return {
    ...createMockObsidianBridge(),
    isMobile: () => true,
    activeViewType: "markdown",
    canPlayDetachedAudio: false,
    hasSavedReading: () => false,
  };
}

describe("global phone dock", () => {
  it("shows a play action on an idle Markdown note, without an editor", async () => {
    const player = samplePlayer(false);
    const bridge = phoneBridge();
    const settings = await createTestSettingsStore();
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    try {
      render(
        <GlobalMobilePlayer
          player={player}
          settings={settings}
          bridge={bridge}
        />,
      );
      expect(
        screen.getByRole("toolbar", { name: "Aloud player" }),
      ).toBeTruthy();
      expect(screen.getByText("Current note")).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Play current note" }),
      );
      expect(bridge.playSelection).toHaveBeenCalledOnce();
      expect(
        screen
          .getByRole("button", { name: "Previous sentence" })
          .hasAttribute("disabled"),
      ).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: previousWidth,
      });
    }
  });

  it("keeps previous, pause and next wired to the same active AudioStore", async () => {
    const player = samplePlayer(true);
    const settings = await createTestSettingsStore();
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    try {
      render(
        <GlobalMobilePlayer
          player={player}
          settings={settings}
          bridge={phoneBridge()}
        />,
      );
      expect(screen.getByText("Whose Leash.md")).toBeTruthy();
      expect(screen.getByText("74 / 85")).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Previous sentence" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Pause Aloud" }));
      fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
      expect(player.activeText?.goToPrevious).toHaveBeenCalledOnce();
      expect(player.activeText?.pause).toHaveBeenCalledOnce();
      expect(player.activeText?.goToNext).toHaveBeenCalledOnce();
      fireEvent.click(
        screen.getByRole("button", { name: "More Aloud controls" }),
      );
      expect(screen.getByLabelText("Aloud playback menu")).toBeTruthy();
      expect(screen.getByText("Manage Article Cache")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close Aloud menu" }));
      expect(screen.queryByLabelText("Aloud playback menu")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: previousWidth,
      });
    }
  });

  it("does not render the phone dock on a desktop", async () => {
    const player = samplePlayer(true);
    const settings = await createTestSettingsStore();
    render(
      <GlobalMobilePlayer
        player={player}
        settings={settings}
        bridge={{ ...phoneBridge(), isMobile: () => false }}
      />,
    );
    expect(screen.queryByRole("toolbar", { name: "Aloud player" })).toBeNull();
  });
});
