import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TTSControlMenuContent } from "./TTSControlMenu";
import type { TTSActions, AudioStore, TTSPluginSettingsStore } from "open-tts";
import type { ObsidianBridge } from "../ObsidianBridge";

vi.mock("obsidian", () => ({ setIcon: vi.fn() }));

const mockProps = () => {
  const actions = {
    playSelection: vi.fn(),
    playPause: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    stop: vi.fn(),
    toggleAutoscroll: vi.fn(),
    autoscrollEnabled: vi.fn(() => false),
  } as unknown as TTSActions;
  const bridge = {
    playDocument: vi.fn().mockResolvedValue(undefined),
    openArticleCache: vi.fn().mockResolvedValue(undefined),
    hasSavedReading: vi.fn(() => false),
    readingProgressLabel: vi.fn((): string | undefined => undefined),
    resumeSavedReading: vi.fn().mockResolvedValue(undefined),
    startOver: vi.fn().mockResolvedValue(undefined),
  } as unknown as ObsidianBridge;
  const player = { activeText: null } as unknown as AudioStore;
  const settings = {
    settings: { playbackSpeed: 1 },
    setSpeed: vi.fn(),
  } as unknown as TTSPluginSettingsStore;
  const onClose = vi.fn();
  return { actions, bridge, player, settings, onClose };
};

describe("Desktop's shared Aloud controls", () => {
  it("offers an explicit document action without starting it automatically", () => {
    const props = mockProps();
    render(<TTSControlMenuContent {...props} />);
    expect(screen.getByText("Play Entire Document")).toBeTruthy();
    expect(props.bridge.playDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Play Entire Document"));
    expect(props.bridge.playDocument).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("preserves explicit selection and shows finished cache controls", () => {
    const props = mockProps();
    render(<TTSControlMenuContent {...props} />);
    fireEvent.click(screen.getByText("Play Selection / From Cursor"));
    expect(props.actions.playSelection).toHaveBeenCalledOnce();
    expect(screen.getByText("Pre-cache Entire Article")).toBeTruthy();
    fireEvent.click(screen.getByText("Pre-cache Entire Article"));
    expect(props.bridge.openArticleCache).toHaveBeenCalledWith("document");
  });

  it("keeps detached controls free of note-specific actions", () => {
    const props = mockProps();
    render(<TTSControlMenuContent {...props} showRestartFromCursor={false} />);
    expect(screen.queryByText("Play Entire Document")).toBeNull();
    expect(screen.getByLabelText("Play Selection")).toBeTruthy();
  });
});
