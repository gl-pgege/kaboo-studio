export interface StudioImage {
  url: string;
  width: number;
  height: number;
  mimeType: string;
}

function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

export function imageOf(bytes: Buffer): StudioImage {
  const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const mimeType = png ? 'image/png' : 'image/jpeg';
  const size = png ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : jpegSize(bytes);
  return { url: `data:${mimeType};base64,${bytes.toString('base64')}`, ...size, mimeType };
}
