import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import type { TTSModelOptions } from "open-tts";
import {
  SpeechifySynthesisJournal,
  SpeechifySynthesisNeedsReview,
} from "./SpeechifySynthesisJournal";

function fakeAdapter() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const adapter = {
    exists: vi.fn(
      async (path: string) => files.has(path) || directories.has(path),
    ),
    mkdir: vi.fn(async (path: string) => {
      directories.add(path);
    }),
    write: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing file");
      return value;
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  return {
    adapter: adapter as unknown as DataAdapter,
    files,
    writes: adapter.write,
  };
}

const options: TTSModelOptions = {
  model: "simba-3.2",
  voice: "geffen_32",
  modelProvider: "speechify",
  apiKey: "very-sensitive-secret-test-token",
};
const text =
  "A private article sentence that must never be in a recovery journal.";
const folder = ".obsidian/plugins/aloud-ios-fork/speechify-incomplete-attempts";

describe("durable Speechify synthesis safety", () => {
  it("blocks regeneration after a restart without storing raw text or keys", async () => {
    const { adapter, files } = fakeAdapter();
    const first = new SpeechifySynthesisJournal(adapter, folder);
    await first.beforeDispatch(text, options);
    const stored = [...files.entries()];
    expect(stored).toHaveLength(1);
    expect(stored[0][0]).toMatch(/\/[a-f0-9]{64}\.json$/);
    expect(JSON.stringify(stored)).not.toContain(text);
    expect(JSON.stringify(stored)).not.toContain(options.apiKey);
    const reloaded = new SpeechifySynthesisJournal(adapter, folder);
    await expect(reloaded.assertAllowed(text, options)).rejects.toBeInstanceOf(
      SpeechifySynthesisNeedsReview,
    );
    expect(
      await reloaded.assertAllowed("different words", options),
    ).toBeUndefined();
  });

  it("allows new synthesis only after a confirmed audio save", async () => {
    const { adapter, files } = fakeAdapter();
    const journal = new SpeechifySynthesisJournal(adapter, folder);
    await journal.beforeDispatch(text, options);
    await journal.audioSaved(text, options);
    expect(files.size).toBe(0);
    await expect(journal.assertAllowed(text, options)).resolves.toBeUndefined();
  });

  it("never treats a partially written record as authorization for a new request", async () => {
    const { adapter, files } = fakeAdapter();
    const journal = new SpeechifySynthesisJournal(adapter, folder);
    await journal.beforeDispatch(text, options);
    const key = [...files.keys()][0];
    files.set(key, "{incomplete");
    const restarted = new SpeechifySynthesisJournal(adapter, folder);
    await expect(restarted.assertAllowed(text, options)).rejects.toBeInstanceOf(
      SpeechifySynthesisNeedsReview,
    );
  });

  it("does not collapse distinct account, model or voice identities", async () => {
    const { adapter } = fakeAdapter();
    const journal = new SpeechifySynthesisJournal(adapter, folder);
    await journal.beforeDispatch(text, options);
    await expect(
      journal.assertAllowed(text, { ...options, apiKey: "other-account" }),
    ).resolves.toBeUndefined();
    await expect(
      journal.assertAllowed(text, { ...options, model: "simba-3.5" }),
    ).resolves.toBeUndefined();
    await expect(
      journal.assertAllowed(text, { ...options, voice: "different-voice" }),
    ).resolves.toBeUndefined();
  });

  it("never dispatches after a journal write failed", async () => {
    const { adapter } = fakeAdapter();
    const journal = new SpeechifySynthesisJournal(adapter, folder);
    vi.spyOn(adapter, "write").mockRejectedValue(
      new Error("iCloud write error"),
    );
    await expect(journal.beforeDispatch(text, options)).rejects.toBeInstanceOf(
      SpeechifySynthesisNeedsReview,
    );
    await expect(journal.assertAllowed(text, options)).rejects.toBeInstanceOf(
      SpeechifySynthesisNeedsReview,
    );
  });
});
