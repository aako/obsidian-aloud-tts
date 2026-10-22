import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  cacheFolder,
  readSnapshot,
  writeSnapshot,
} from "./PersistentVaultCache";

function adapter(): DataAdapter {
  const files = new Map<string, string>();
  return {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => {
      const value = files.get(p);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    write: async (p: string, value: string) => {
      files.set(p, value);
    },
  } as unknown as DataAdapter;
}

const valid = (value: unknown): value is { ok: boolean } =>
  !!value &&
  typeof value === "object" &&
  "ok" in value &&
  typeof value.ok === "boolean";

describe("persistent cache snapshots", () => {
  it("recovers from an interrupted newer slot", async () => {
    const storage = adapter();
    await writeSnapshot(storage, "article-abc", 1, { ok: true });
    await storage.write("article-abc.b.json", "{broken");
    const saved = await readSnapshot(storage, "article-abc", valid);
    expect(saved?.generation).toBe(1);
    expect(saved?.value.ok).toBe(true);
  });

  it("fails closed when both snapshots are unreadable", async () => {
    const storage = adapter();
    await storage.write("article-abc.a.json", "{broken");
    await expect(readSnapshot(storage, "article-abc", valid)).rejects.toThrow(
      "unavailable or corrupt",
    );
  });

  it("refuses paths outside ordinary vault folders", () => {
    expect(cacheFolder("_Aloud Audio Cache/")).toBe("_Aloud Audio Cache");
    for (const path of [
      "../outside",
      "foo/../outside",
      ".tts",
      "/absolute",
      "bad\\path",
      "",
    ])
      expect(() => cacheFolder(path)).toThrow();
  });
});
