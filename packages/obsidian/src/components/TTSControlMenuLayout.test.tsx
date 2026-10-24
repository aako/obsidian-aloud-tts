import * as React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AudioStore, TTSActions, TTSPluginSettingsStore } from "open-tts";
import type { ObsidianBridge } from "../ObsidianBridge";
import { TTSControlMenuContent } from "./TTSControlMenu";

vi.mock("obsidian", () => ({ setIcon: vi.fn() }));

function renderControls() {
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
    playDocument: vi.fn(),
    openArticleCache: vi.fn(),
    hasSavedReading: vi.fn(() => true),
    readingProgressLabel: vi.fn(() => "Saved: group 74"),
    resumeSavedReading: vi.fn(),
    startOver: vi.fn(),
  } as unknown as ObsidianBridge;
  const settings = {
    settings: { playbackSpeed: 1.2 },
    setSpeed: vi.fn(),
  } as unknown as TTSPluginSettingsStore;
  return render(
    <TTSControlMenuContent
      actions={actions}
      bridge={bridge}
      player={{ activeText: null } as unknown as AudioStore}
      settings={settings}
      onClose={vi.fn()}
    />,
  );
}

describe("Aloud menu full-width layout contract", () => {
  it("uses a scoped unconditional rule even above a mobile media breakpoint", () => {
    const css = readFileSync("packages/obsidian/styles.css", "utf8");
    const marker = "/* ios.27: Aloud menu action layout baseline";
    const offset = css.indexOf(marker);
    expect(offset).toBeGreaterThan(-1);
    const baseline = css.slice(offset);
    expect(baseline).toContain(
      ".menu-scroll.tts-aloud-controls > .menu-group > button.menu-item.tappable",
    );
    expect(baseline).toContain("width: 100% !important;");
    expect(baseline).not.toContain("@media");
  });

  it("keeps full-width actions compact without shrinking touch targets", () => {
    const css = readFileSync("packages/obsidian/styles.css", "utf8");
    const marker = "/* ios.27: Aloud menu action layout baseline";
    const baseline = css.slice(css.indexOf(marker));
    expect(baseline).toContain("min-height: 44px !important;");
    expect(baseline).toContain("padding: 4px 12px !important;");
    expect(baseline).toContain("line-height: 1.2;");
    expect(baseline).toContain("margin: 6px 0 !important;");
    const style = document.createElement("style");
    style.textContent = baseline;
    document.head.append(style);
    try {
      const { container } = renderControls();
      const button = container.querySelector(
        ".menu-scroll.tts-aloud-controls > .menu-group > button.menu-item.tappable",
      );
      expect(button).not.toBeNull();
      expect(getComputedStyle(button!).minHeight).toBe("44px");
      expect(getComputedStyle(button!).paddingTop).toBe("4px");
      expect(getComputedStyle(button!).width).toBe("100%");
      expect(getComputedStyle(button!).lineHeight).toBe("1.2");
    } finally {
      style.remove();
    }
  });

  it("renders all controls in the scoped container and matches the full-row CSS", () => {
    const css = readFileSync("packages/obsidian/styles.css", "utf8");
    const marker = "/* ios.27: Aloud menu action layout baseline";
    const style = document.createElement("style");
    style.textContent = css.slice(css.indexOf(marker));
    document.head.append(style);
    try {
      const { container } = renderControls();
      const root = container.querySelector(".menu-scroll.tts-aloud-controls");
      expect(root).not.toBeNull();
      const rows = root?.querySelectorAll(
        ":scope > .menu-group > button.menu-item.tappable",
      );
      expect(rows?.length).toBeGreaterThanOrEqual(7);
      const first = screen.getByText("Play Selection / From Cursor");
      expect(first.tagName).toBe("BUTTON");
      expect(getComputedStyle(first).display).toBe("flex");
      expect(getComputedStyle(first).width).toBe("100%");
      const group = first.closest(".menu-group");
      expect(group).not.toBeNull();
      expect(getComputedStyle(group!).width).toBe("100%");
    } finally {
      style.remove();
    }
  });
});
