import { describe, expect, it, vi } from "vitest";
import type { App, MarkdownView } from "obsidian";
import type { AudioStore } from "open-tts";
import {
  findReadingHighlightRange,
  ReadingViewHighlight,
  scrollToSpokenRange,
} from "./ReadingViewHighlight";

describe("Reading View current sentence paint ranges", () => {
  function readerHarness(
    opts: { playing?: boolean; follow?: boolean; stale?: boolean } = {},
  ) {
    const text =
      "# A long article\n\nAn opening paragraph is at the top.\n\n" +
      "The spoken passage is much farther down the article.";
    const start = text.indexOf("The spoken passage");
    const chunk = {
      text: "The spoken passage is much farther down the article.",
      rawText: "The spoken passage is much farther down the article.",
      start,
      end: text.length,
    };
    const containerEl = document.createElement("div");
    containerEl.innerHTML =
      '<div class="markdown-preview-view"><p>An opening paragraph is at the top.</p></div>';
    document.body.append(containerEl);
    const view = {
      file: { path: "Article.md" },
      containerEl,
      getMode: () => "preview",
      getViewData: () =>
        opts.stale ? text.replace("spoken passage", "changed passage") : text,
      setEphemeralState: vi.fn(),
    } as unknown as MarkdownView;
    const app = {
      workspace: {
        getActiveViewOfType: vi.fn(() => view),
        on: vi.fn(),
        off: vi.fn(),
      },
    } as unknown as App;
    const player = {
      activeText: {
        audio: { sourcePath: "Article.md" },
        currentChunk: chunk,
        position: 170,
        isPlaying: opts.playing ?? true,
      },
      autoScrollEnabled: opts.follow ?? true,
      disableAutoScroll: vi.fn(() => {
        player.autoScrollEnabled = false;
      }),
      markProgrammaticScroll: vi.fn(),
    } as unknown as AudioStore;
    const highlight = new ReadingViewHighlight(app, player);
    const paint = (): void => {
      (highlight as unknown as { paint: () => void }).paint();
    };
    return { app, view, player, highlight, paint, containerEl };
  }

  it("automatically follows a distant spoken source line only once", () => {
    const test = readerHarness();
    try {
      test.paint();
      expect(test.view.setEphemeralState).toHaveBeenCalledWith({ line: 4 });
      test.paint();
      expect(test.view.setEphemeralState).toHaveBeenCalledTimes(1);
      expect(test.player.markProgrammaticScroll).toHaveBeenCalledOnce();
    } finally {
      test.highlight.destroy();
      test.containerEl.remove();
    }
  });

  it("never auto-follows paused audio, disabled settings or stale source", () => {
    for (const options of [
      { playing: false },
      { follow: false },
      { stale: true },
    ]) {
      const test = readerHarness(options);
      try {
        test.paint();
        expect(test.view.setEphemeralState).not.toHaveBeenCalled();
      } finally {
        test.highlight.destroy();
        test.containerEl.remove();
      }
    }
  });

  it("suspends Reader auto-follow when the user scrolls by touch", () => {
    const test = readerHarness();
    try {
      test.paint();
      const preview = test.containerEl.querySelector(".markdown-preview-view")!;
      preview.dispatchEvent(new Event("touchmove", { bubbles: true }));
      expect(test.player.disableAutoScroll).toHaveBeenCalledOnce();
      expect(test.player.autoScrollEnabled).toBe(false);
    } finally {
      test.highlight.destroy();
      test.containerEl.remove();
    }
  });

  it("matches a sentence across emphasized inline text without altering HTML", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>Before <strong>these emphasized</strong> words. After that.</p>";
    const before = root.innerHTML;
    const range = findReadingHighlightRange(
      root,
      "Before these emphasized words.",
    );
    expect(range?.toString()).toBe("Before these emphasized words.");
    expect(root.innerHTML).toBe(before);
  });

  it("highlights only the current sentence, not preceding or following text", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>The first sentence. The current sentence. The final sentence.</p>";
    const range = findReadingHighlightRange(root, "The current sentence.");
    expect(range?.toString()).toBe("The current sentence.");
  });

  it("refuses ambiguous repeats, unrelated text and tiny fragments", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>The repeated sentence.</p><p>The repeated sentence.</p>";
    expect(
      findReadingHighlightRange(root, "The repeated sentence."),
    ).toBeNull();
    expect(findReadingHighlightRange(root, "Not in this document.")).toBeNull();
    expect(findReadingHighlightRange(root, "A")).toBeNull();
  });

  it("does not match hidden embedded content or footnote markers", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p>Visible words.<span class="footnote-ref">¹</span></p>' +
      '<div class="internal-embed"><p>Embedded sentence.</p></div>';
    expect(findReadingHighlightRange(root, "Embedded sentence.")).toBeNull();
    expect(findReadingHighlightRange(root, "Visible words.")).not.toBeNull();
  });

  it("jumps only to a unique rendered sentence without modifying Markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>First sentence. Spoken sentence. Last sentence.</p>";
    const original = root.innerHTML;
    const block = root.querySelector("p")!;
    block.scrollIntoView = vi.fn();
    expect(scrollToSpokenRange(root, "Spoken sentence.")).toBe(true);
    expect(block.scrollIntoView).toHaveBeenCalled();
    expect(root.innerHTML).toBe(original);
    root.innerHTML = "<p>Repeated sentence.</p><p>Repeated sentence.</p>";
    expect(scrollToSpokenRange(root, "Repeated sentence.")).toBe(false);
  });

  it("finds a chunk spanning a heading and paragraph in Reading View", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<h2>Remember the DNC?</h2>" +
      "<p>In August, on the final night of the convention, we were there.</p>";
    const range = findReadingHighlightRange(
      root,
      "Remember the DNC?\n\nIn August, on the final night of the convention, we were there.",
    );
    expect(range?.toString()).toContain("Remember the DNC?");
    expect(range?.toString()).toContain("In August");
  });

  it("tolerates smart quotes while preserving original visible text", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>“You're complicit,” the protester said.</p>";
    const html = root.innerHTML;
    expect(
      findReadingHighlightRange(
        root,
        `"You're complicit," the protester said.`,
      )?.toString(),
    ).toBe("“You're complicit,” the protester said.");
    expect(root.innerHTML).toBe(html);
  });

  it("uses a long unique opening phrase when rendered tail differs", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>One particular account of that very surprising evening begins with people arriving at the party. The visible ending.</p>";
    const range = findReadingHighlightRange(
      root,
      "One particular account of that very surprising evening begins with people arriving at the party. The spoken ending is different.",
    );
    expect(range?.toString()).toContain("One particular account");
  });

  it("never guesses which duplicated opening phrase to jump to", () => {
    const root = document.createElement("div");
    const shared =
      "One particular account of that very surprising evening begins with people arriving at the party.";
    root.innerHTML = `<p>${shared} First.</p><p>${shared} Second.</p>`;
    expect(
      findReadingHighlightRange(
        root,
        `${shared} A different rendered ending from speech.`,
      ),
    ).toBeNull();
  });

  it("skips an excluded embedded copy when matching across rendered blocks", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="internal-embed"><p>The visible line.</p></div>' +
      "<p>The visible line.</p>";
    expect(
      findReadingHighlightRange(root, "The visible line.")?.toString(),
    ).toBe("The visible line.");
  });

  it("does not mistake text inside a longer word for the spoken group", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Unforgettable moments matter.</p>";
    expect(findReadingHighlightRange(root, "forgettable moments")).toBeNull();
  });
});
