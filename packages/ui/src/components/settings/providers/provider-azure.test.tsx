import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAzureVoices } from "open-tts";
import type { TTSPluginSettingsStore } from "open-tts";
import { AzureVoiceComponent } from "./provider-azure";

vi.mock("open-tts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("open-tts")>()),
  listAzureVoices: vi.fn(),
}));

function makeStore(initialFavorites: string[] = []) {
  const settings = observable({
    azure_apiKey: "test-key",
    azure_region: "eastus",
    azure_voice: "en-US-JennyNeural",
    azure_favoriteVoices: initialFavorites,
  });
  const updateModelSpecificSettings = vi.fn(
    async (_provider: string, patch: Record<string, unknown>) => {
      runInAction(() => Object.assign(settings, patch));
    },
  );
  const store = {
    settings,
    updateModelSpecificSettings,
  } as unknown as TTSPluginSettingsStore;
  return { store, settings, updateModelSpecificSettings };
}

const voices = [
  { id: "en-US-JennyNeural", name: "Jenny", gender: "Female", locale: "en-US" },
  { id: "en-US-GuyNeural", name: "Guy", gender: "Male", locale: "en-US" },
  {
    id: "en-GB-OliviaNeural",
    name: "Olivia",
    gender: "Female",
    locale: "en-GB",
  },
];

beforeEach(() => {
  vi.mocked(listAzureVoices).mockReset().mockResolvedValue(voices);
});

describe("Azure voice search and favorites", () => {
  it("searches name and voice ID, filters locale and gender without synthesizing", async () => {
    const { store, updateModelSpecificSettings } = makeStore();
    render(<AzureVoiceComponent store={store} />);
    await screen.findByText(/3 matching voices/);
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search Azure voices" }),
      {
        target: { value: "Olivia" },
      },
    );
    expect(screen.getByText(/1 matching voices/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Select voice Olivia/ }),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search Azure voices" }),
      {
        target: { value: "" },
      },
    );
    fireEvent.change(screen.getByLabelText("Filter voice locale"), {
      target: { value: "en-US" },
    });
    fireEvent.change(screen.getByLabelText("Filter voice gender"), {
      target: { value: "Male" },
    });
    expect(screen.getByText(/1 matching voices/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Select voice Guy/ }));
    expect(updateModelSpecificSettings).toHaveBeenCalledWith("azure", {
      azure_voice: "en-US-GuyNeural",
    });
  });

  it("pins favorites, filters to them, and persists IDs via existing settings", async () => {
    const { store, settings, updateModelSpecificSettings } = makeStore();
    const view = render(<AzureVoiceComponent store={store} />);
    await screen.findByText(/3 matching voices/);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add en-GB-OliviaNeural to favorites",
      }),
    );
    await waitFor(() =>
      expect(settings.azure_favoriteVoices).toEqual(["en-GB-OliviaNeural"]),
    );
    expect(updateModelSpecificSettings).toHaveBeenCalledWith("azure", {
      azure_favoriteVoices: ["en-GB-OliviaNeural"],
    });
    fireEvent.click(screen.getByLabelText("Favorites only"));
    expect(screen.getByText(/1 matching voices/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Select voice Olivia/ }),
    ).toBeTruthy();
    view.unmount();
    // A fresh picker reading the persisted settings shows the same favorite.
    render(<AzureVoiceComponent store={store} />);
    await screen.findByText(/3 matching voices/);
    fireEvent.click(screen.getByLabelText("Favorites only"));
    expect(screen.getByText(/1 matching voices/)).toBeTruthy();
  });

  it("never resets an existing voice if Azure returns a partial catalog", async () => {
    const { store, settings, updateModelSpecificSettings } = makeStore();
    runInAction(() => {
      settings.azure_voice = "en-US-MAI-Voice-2.1";
    });
    render(<AzureVoiceComponent store={store} />);
    await screen.findByText(/3 matching voices/);
    expect(screen.getByText("en-US-MAI-Voice-2.1")).toBeTruthy();
    expect(updateModelSpecificSettings).not.toHaveBeenCalled();
  });

  it("ignores obsolete results after switching regions", async () => {
    let resolveOld: (value: typeof voices) => void = () => undefined;
    vi.mocked(listAzureVoices)
      .mockImplementationOnce(
        () =>
          new Promise<typeof voices>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce([voices[2]]);
    const { store, settings } = makeStore();
    render(<AzureVoiceComponent store={store} />);
    await act(async () => {
      runInAction(() => {
        settings.azure_region = "uksouth";
      });
    });
    await screen.findByText(/1 matching voices/);
    await act(async () => {
      resolveOld(voices);
    });
    expect(screen.getByText(/1 matching voices/)).toBeTruthy();
  });
});
