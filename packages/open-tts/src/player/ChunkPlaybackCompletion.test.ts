import { describe, expect, it } from "vitest";
import { hasReachedChunkEnd } from "./ChunkPlaybackCompletion";

describe("locked-screen-safe chunk completion", () => {
  it("does not complete a chunk when the media clock stalls near the end", () => {
    // Simulates delayed timers firing repeatedly after iOS backgrounds the app.
    for (let tick = 0; tick < 40; tick++) {
      expect(hasReachedChunkEnd(9.45, 10, true, true)).toBe(false);
    }
  });

  it("does not advance a paused or waiting audio track", () => {
    expect(hasReachedChunkEnd(10, 10, false, true)).toBe(false);
    expect(hasReachedChunkEnd(10, 10, true, false)).toBe(false);
  });

  it("does not complete chunks without valid timeline metadata", () => {
    expect(hasReachedChunkEnd(20, undefined, true, true)).toBe(false);
    expect(hasReachedChunkEnd(Number.NaN, 10, true, true)).toBe(false);
  });

  it("never counts an advancing media clock as completed audio while output is stalled", () => {
    // A lock-screen suspension can leave playback intent true even when the
    // HTML media element reports waiting/stalled. Clock movement isn't sound.
    expect(hasReachedChunkEnd(35, 12, true, true, true)).toBe(false);
    expect(hasReachedChunkEnd(12, 12, true, true, true)).toBe(false);
    expect(hasReachedChunkEnd(12, 12, true, true, false)).toBe(true);
  });

  it("completes only after the playing media clock reaches the boundary", () => {
    expect(hasReachedChunkEnd(9.75, 10, true, true)).toBe(false);
    expect(hasReachedChunkEnd(9.95, 10, true, true)).toBe(true);
    expect(hasReachedChunkEnd(10, 10, true, true)).toBe(true);
  });
});
