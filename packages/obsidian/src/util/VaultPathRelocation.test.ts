import { describe, expect, it } from "vitest";
import { relocatedVaultPath } from "./VaultPathRelocation";

describe("Obsidian vault path relocation", () => {
  it("follows an exact note move or rename", () => {
    expect(
      relocatedVaultPath("Read/Essay.md", "Read/Essay.md", "Archive/Essay.md"),
    ).toBe("Archive/Essay.md");
  });

  it("follows a folder move for every descendant article", () => {
    expect(
      relocatedVaultPath("Read/Essays/Essay.md", "Read", "Archive/Read"),
    ).toBe("Archive/Read/Essays/Essay.md");
  });

  it("does not confuse sibling names with descendants", () => {
    expect(relocatedVaultPath("Reading/Essay.md", "Read", "Archive")).toBe(
      "Reading/Essay.md",
    );
  });

  it("does not remap unrelated notes or unchanged paths", () => {
    expect(relocatedVaultPath("Other.md", "Read", "New")).toBe("Other.md");
    expect(relocatedVaultPath("Read/Essay.md", "Read", "Read")).toBe(
      "Read/Essay.md",
    );
  });
});
