import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { AudioStore } from "open-tts";
import {
  GlobalMobilePlayer,
  GlobalMobilePlayerHost,
} from "./GlobalMobilePlayer";
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
            sourcePath: "Articles/Whose Leash.md",
            chunks: Array.from({ length: 85 }, () => ({})),
          },
          position: 73,
          currentChunk: { text: "Currently spoken words." },
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

  it("jumps to the playing line without altering audio position", async () => {
    const player = samplePlayer(true);
    const bridge = phoneBridge();
    const settings = await createTestSettingsStore();
    const before = window.innerWidth;
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
      fireEvent.click(
        screen.getByRole("button", { name: "Jump to playing line" }),
      );
      expect(bridge.jumpToPlayingLine).toHaveBeenCalledOnce();
      expect(player.activeText?.position).toBe(73);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: before,
      });
    }
  });

  it("reacts to top and full-width settings without replacing the player", async () => {
    const settings = await createTestSettingsStore();
    const host = new GlobalMobilePlayerHost(samplePlayer(false), settings, {
      ...phoneBridge(),
      isMobile: () => false,
    });
    try {
      const container = document.querySelector(".tts-global-desktop-host");
      expect(container?.classList.contains("tts-player-top")).toBe(false);
      await settings.updateSettings({
        floatingPlayerPosition: "top",
        floatingPlayerWidth: "full",
      });
      expect(container?.classList.contains("tts-player-top")).toBe(true);
      expect(container?.classList.contains("tts-player-full")).toBe(true);
    } finally {
      host.destroy();
    }
  });

  it("shows a persistent Mac toolbar with the full menu", async () => {
    const player = samplePlayer(true);
    const settings = await createTestSettingsStore();
    render(
      <GlobalMobilePlayer
        player={player}
        settings={settings}
        bridge={{ ...phoneBridge(), isMobile: () => false }}
      />,
    );
    expect(screen.getByRole("toolbar", { name: "Aloud player" })).toBeTruthy();
    expect(screen.getByText("Whose Leash.md")).toBeTruthy();
    expect(screen.getByText("74 / 85")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous sentence" }));
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
  });

  it("offers play on an idle Mac Reading View note", async () => {
    const player = samplePlayer(false);
    const bridge = { ...phoneBridge(), isMobile: () => false };
    const settings = await createTestSettingsStore();
    render(
      <GlobalMobilePlayer
        player={player}
        settings={settings}
        bridge={bridge}
      />,
    );
    expect(screen.getByRole("toolbar", { name: "Aloud player" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play current note" }));
    expect(bridge.playSelection).toHaveBeenCalledOnce();
  });

  it("hides the idle dock outside Markdown notes", async () => {
    const player = samplePlayer(false);
    const settings = await createTestSettingsStore();
    render(
      <GlobalMobilePlayer
        player={player}
        settings={settings}
        bridge={{
          ...phoneBridge(),
          isMobile: () => false,
          activeViewType: "empty",
        }}
      />,
    );
    expect(screen.queryByRole("toolbar", { name: "Aloud player" })).toBeNull();
  });

  it("does not show a Mac bar on a mobile tablet", async () => {
    const player = samplePlayer(true);
    const settings = await createTestSettingsStore();
    const before = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    try {
      render(
        <GlobalMobilePlayer
          player={player}
          settings={settings}
          bridge={phoneBridge()}
        />,
      );
      expect(
        screen.queryByRole("toolbar", { name: "Aloud player" }),
      ).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: before,
      });
    }
  });

  it("mounts and removes the app-level Mac host", async () => {
    const settings = await createTestSettingsStore();
    const host = new GlobalMobilePlayerHost(samplePlayer(false), settings, {
      ...phoneBridge(),
      isMobile: () => false,
    });
    try {
      expect(
        await screen.findByRole("toolbar", { name: "Aloud player" }),
      ).toBeTruthy();
      expect(document.querySelector(".tts-global-desktop-host")).toBeTruthy();
    } finally {
      host.destroy();
    }
    expect(document.querySelector(".tts-global-desktop-host")).toBeNull();
  });
});
