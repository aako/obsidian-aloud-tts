import { describe, expect, it } from "vitest";
import { findReadingHighlightRange } from "./ReadingViewHighlight";

describe("Reading View current sentence paint ranges", () => {
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

  it("does not mistake text inside a longer word for the spoken group", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Unforgettable moments matter.</p>";
    expect(findReadingHighlightRange(root, "forgettable moments")).toBeNull();
  });
});
