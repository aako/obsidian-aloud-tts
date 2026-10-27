import { describe, expect, it, afterEach } from "vitest";
import { buildTrack } from "open-tts";
import {
  chunkIndexAtSourceOffset,
  exactReadingViewSourceRange,
  isMarkdownReadingView,
  readingViewSelection,
  sourceLineForPlayingChunk,
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

  it("starts from a containing sentence without changing whole-note audio chunks", () => {
    const text =
      "The first sentence is long enough to stand by itself. " +
      "The second sentence is also long enough to stand by itself. " +
      "The third sentence comes after both of the previous ones.";
    const options = {
      filename: "article.md",
      sourcePath: "article.md",
      text,
      start: 0,
      end: text.length,
    };
    const offset = text.indexOf("third sentence") + 5;
    const chunks = buildTrack(options, "sentence").chunks;
    const index = chunkIndexAtSourceOffset(options, "sentence", offset);
    expect(index).toBeDefined();
    expect(index).toBeGreaterThan(0);
    expect(chunks[index!].start).toBeLessThanOrEqual(offset);
    expect(chunks[index!].end).toBeGreaterThan(offset);
    expect(chunks[index!].rawText).toContain("third sentence");
  });

  it("maps an offscreen audio chunk to the original Markdown line", () => {
    const source =
      "# Article\n\nFirst sentence.\n\nSecond sentence.\n\nThird sentence.";
    const start = source.indexOf("Third sentence.");
    expect(
      sourceLineForPlayingChunk(source, {
        start,
        end: start + "Third sentence.".length,
        rawText: "Third sentence.",
      }),
    ).toBe(6);
  });

  it("refuses to navigate by offsets when the note was edited or truncated", () => {
    const source = "# Heading\n\nOriginal sentence.";
    const chunk = {
      start: source.indexOf("Original"),
      end: source.length,
      rawText: "Original sentence.",
    };
    expect(sourceLineForPlayingChunk(source, chunk)).toBe(2);
    expect(
      sourceLineForPlayingChunk(source.replace("Original", "Changed!"), chunk),
    ).toBeUndefined();
    expect(
      sourceLineForPlayingChunk(source.slice(0, -3), chunk),
    ).toBeUndefined();
    expect(
      sourceLineForPlayingChunk(source, { ...chunk, start: -1 }),
    ).toBeUndefined();
    expect(
      sourceLineForPlayingChunk(source, { ...chunk, end: chunk.end + 1 }),
    ).toBeUndefined();
  });

  it("rejects positions outside the source, including EOF", () => {
    const text = "There is something here to read.";
    const options = { filename: "a.md", text, start: 0, end: text.length };
    expect(chunkIndexAtSourceOffset(options, "sentence", -1)).toBeUndefined();
    expect(
      chunkIndexAtSourceOffset(options, "sentence", text.length),
    ).toBeUndefined();
    expect(chunkIndexAtSourceOffset(options, "sentence", 1.2)).toBeUndefined();
  });

  it("refuses ambiguous and rendered-only selections as checkpoint offsets", () => {
    expect(exactReadingViewSourceRange("A. A.", "A.")).toBeUndefined();
    expect(
      exactReadingViewSourceRange("**Bold** text", "Bold text"),
    ).toBeUndefined();
    expect(exactReadingViewSourceRange("Anything", " ")).toBeUndefined();
  });
});
