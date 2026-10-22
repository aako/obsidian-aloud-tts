/** Zero-dependency ZIP (STORE, no recompression) of independently playable MP3 chunks.
 * A ZIP avoids inventing a continuous MP3 frame stream or changing chunk audio.
 * Import the ZIP into a native audiobook player with multipart-MP3 support.
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zippedMP3Chunks(chunks: ArrayBuffer[]): ArrayBuffer {
  if (!chunks.length || chunks.length > 65535)
    throw new Error("Invalid cached MP3 count for ZIP export.");
  const encoder = new TextEncoder();
  const records = chunks.map((data, i) => {
    const name = encoder.encode(`Part-${String(i + 1).padStart(4, "0")}.mp3`);
    const bytes = new Uint8Array(data);
    if (!bytes.byteLength)
      throw new Error("An empty cached MP3 cannot be exported.");
    return { name, bytes, checksum: crc32(bytes) };
  });
  const localSize = records.reduce(
    (n, r) => n + 30 + r.name.length + r.bytes.length,
    0,
  );
  const centralSize = records.reduce((n, r) => n + 46 + r.name.length, 0);
  const total = localSize + centralSize + 22;
  if (total > 0xffffffff)
    throw new Error("Cached ZIP would exceed the 4 GB ZIP32 limit.");
  const result = new ArrayBuffer(total);
  const data = new Uint8Array(result);
  const view = new DataView(result);
  let position = 0;
  const little16 = (n: number): void => {
    view.setUint16(position, n, true);
    position += 2;
  };
  const little32 = (n: number): void => {
    view.setUint32(position, n, true);
    position += 4;
  };
  const bytesWrite = (value: Uint8Array): void => {
    data.set(value, position);
    position += value.byteLength;
  };
  const locations: number[] = [];
  for (const record of records) {
    locations.push(position);
    little32(0x04034b50); // PK\x03\x04 local file
    little16(20); // ZIP version 2.0
    little16(0); // flags
    little16(0); // STORE method (MP3 already compressed)
    little16(0);
    little16(0); // deterministic DOS time/date
    little32(record.checksum);
    little32(record.bytes.length);
    little32(record.bytes.length);
    little16(record.name.length);
    little16(0);
    bytesWrite(record.name);
    bytesWrite(record.bytes);
  }
  const centralStart = position;
  for (const [index, record] of records.entries()) {
    little32(0x02014b50); // central directory header
    little16(20);
    little16(20);
    little16(0);
    little16(0);
    little16(0);
    little16(0);
    little32(record.checksum);
    little32(record.bytes.length);
    little32(record.bytes.length);
    little16(record.name.length);
    little16(0);
    little16(0);
    little16(0);
    little16(0);
    little32(0);
    little32(locations[index]);
    bytesWrite(record.name);
  }
  if (position !== centralStart + centralSize)
    throw new Error("ZIP central directory size mismatch.");
  little32(0x06054b50); // end of central directory
  little16(0);
  little16(0);
  little16(records.length);
  little16(records.length);
  little32(centralSize);
  little32(centralStart);
  little16(0); // no ZIP comment
  if (position !== total) throw new Error("ZIP size mismatch.");
  return result;
}
