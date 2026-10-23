import { describe, expect, it } from "vitest";
import { zippedMP3Chunks } from "./CachedAudioZip";

describe("native audiobook multipart ZIP", () => {
  it("writes a complete stored archive with numbered MP3s and central directory", () => {
    const a = new Uint8Array([255, 251, 144, 1]).buffer;
    const b = new Uint8Array([255, 251, 144, 2, 3]).buffer;
    const bytes = zippedMP3Chunks([a, b]);
    const view = new DataView(bytes);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(bytes.byteLength - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.byteLength - 22 + 10, true)).toBe(2);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("Part-0001.mp3");
    expect(text).toContain("Part-0002.mp3");
  });
  it("refuses empty MP3s and empty sets", () => {
    expect(() => zippedMP3Chunks([])).toThrow();
    expect(() => zippedMP3Chunks([new ArrayBuffer(0)])).toThrow();
  });
});
