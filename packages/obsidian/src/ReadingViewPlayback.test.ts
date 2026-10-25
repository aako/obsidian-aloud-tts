import { describe, expect, it, afterEach } from "vitest";
import {
  exactReadingViewSourceRange,
  isMarkdownReadingView,
  readingViewSelection,
} from "./ReadingViewPlayback";

const root = document.createElement("div");
afterEach(() => {
  root.remove();
  window.getSelection()?.removeAllRanges();
});

function selectedPreviewText(text: string) {
  root.innerHTML = `<div class="markdown-preview-view"><p></p></div>`;
  const paragraph = root.querySelector("p")!;
  paragraph.textContent = text;
  document.body.append(root);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("Reading View playback source mapping", () => {
  it("recognizes Obsidian's preview mode and excludes editor mode", () => {
    expect(isMarkdownReadingView({ getMode: () => "preview" } as never)).toBe(
      true,
    );
    expect(isMarkdownReadingView({ getMode: () => "source" } as never)).toBe(
      false,
    );
  });

  it("reads only a selection belonging to this note's rendered preview", () => {
    const selection = selectedPreviewText("A selected passage.");
    expect(readingViewSelection(root, selection)).toBe("A selected passage.");
    const other = document.createElement("div");
    other.innerHTML = `<div class="markdown-preview-view"></div>`;
    document.body.append(other);
    expect(readingViewSelection(other, selection)).toBe("");
    other.remove();
  });

  it("refuses text selected in the Obsidian menu or outside the preview", () => {
    const selection = selectedPreviewText("A selected passage.");
    const menu = document.createElement("button");
    menu.textContent = "Play";
    root.append(menu);
    const range = document.createRange();
    range.selectNodeContents(menu);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readingViewSelection(root, selection)).toBe("");
  });

  it("maps a unique exact selection to the source offset without rekeying audio", () => {
    const raw = "# Title\n\nA selected passage.\n\nEnding.";
    expect(exactReadingViewSourceRange(raw, "A selected passage.")).toEqual({
      text: "A selected passage.",
      start: 9,
      end: 28,
    });
  });

  it("refuses ambiguous and rendered-only selections as checkpoint offsets", () => {
    expect(exactReadingViewSourceRange("A. A.", "A.")).toBeUndefined();
    expect(
      exactReadingViewSourceRange("**Bold** text", "Bold text"),
    ).toBeUndefined();
    expect(exactReadingViewSourceRange("Anything", " ")).toBeUndefined();
  });
});
