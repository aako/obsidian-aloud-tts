import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArticleCacheView } from "./ArticleCacheModal";
import type { ArticleCache, ArticleJob, CacheEstimate } from "../ArticleCache";
import type { TTSPluginSettingsStore } from "open-tts";

const article = {
  id: "leash",
  path: "Reading/Whose Leash.md",
  start: 0,
  end: 20,
  fingerprint: "abc",
  voice: "speechify:test",
  chunkType: "sentence",
  chunks: [
    { key: "a", size: 0, state: "missing" },
    { key: "b", size: 0, state: "missing" },
  ],
  state: "paused",
  message: "Estimate only; no synthesis requested.",
  generation: 0,
} as ArticleJob;

function fixture() {
  const estimate: CacheEstimate = {
    characters: 220,
    cached: 2,
    persistentCached: 2,
    localOnlyCached: 0,
    persistentUnavailable: 0,
    missing: 0,
    requests: 0,
    additionalCharacters: 0,
    approximateBytes: 2500,
    remaining: 100000,
    exceedsBudget: false,
  };
  const manager = {
    jobs: [article],
    estimate: vi.fn().mockResolvedValue(estimate),
    start: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    vault: { getStorageSize: vi.fn().mockResolvedValue(2500) },
  } as unknown as ArticleCache;
  const settings = {
    settings: {
      modelProvider: "speechify",
      speechifyMonthlyBudget: 100000,
      persistentCacheFolder: "_Aloud Audio Cache",
      persistentCacheMaxMB: 500,
      audioFolder: "Aloud",
    },
  } as unknown as TTSPluginSettingsStore;
  return { manager, settings };
}

describe("Article Audio Cache UI", () => {
  it("does not silently select the first job in Manage mode", async () => {
    const { manager, settings } = fixture();
    render(<ArticleCacheView manager={manager} settings={settings} />);
    const selector = screen.getByRole("combobox") as HTMLSelectElement;
    expect(selector.value).toBe("");
    expect(
      screen.getByText(/Nothing is selected for rendering or deletion/),
    ).toBeTruthy();
    expect(screen.queryByText("Delete Selected Audio")).toBeNull();
    expect(manager.estimate).not.toHaveBeenCalled();
    fireEvent.change(selector, { target: { value: "leash" } });
    await waitFor(() => expect(manager.estimate).toHaveBeenCalled());
  });

  it("shows verified vault status and blocks redundant rendering", async () => {
    const { manager, settings } = fixture();
    render(
      <ArticleCacheView
        manager={manager}
        settings={settings}
        initial={article}
        version="0.15.1-ios.25"
      />,
    );
    expect(
      await screen.findByText(/All article chunks are verified/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Verified persistent vault:/).textContent,
    ).toContain("2/2");
    expect(screen.queryByText(/0\/2 chunks processed/)).toBeNull();
    const button = screen.getByRole("button", { name: "All Audio Verified" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(manager.start).not.toHaveBeenCalled();
    expect(screen.queryByText("Pause Render")).toBeNull();
    expect(screen.getByLabelText("Aloud version").textContent).toContain(
      "ios.25",
    );
  });
});
