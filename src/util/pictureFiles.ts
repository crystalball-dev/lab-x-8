/**
 * How kept pictures are named, shared by the desktop shell and the page. A picture is named by
 * its content: the SHA-256 of its bytes and the extension of its type, so the same picture is
 * kept once however many presets use it, and a name cannot point outside the picture folder.
 */

/** The picture types that are kept, as found in the first bytes of the file. */
const SIGNATURES: Array<{ extension: string; mime: string; test: (b: Uint8Array) => boolean }> = [
  { extension: 'png', mime: 'image/png', test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { extension: 'jpg', mime: 'image/jpeg', test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { extension: 'gif', mime: 'image/gif', test: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  { extension: 'bmp', mime: 'image/bmp', test: (b) => starts(b, [0x42, 0x4d]) },
  {
    extension: 'webp',
    mime: 'image/webp',
    test: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && text(b, 8, 4) === 'WEBP',
  },
  { extension: 'avif', mime: 'image/avif', test: (b) => text(b, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(text(b, 8, 4)) },
];

/** A kept picture's name. Anything else is never read or deleted. */
export const PICTURE_ID = /^[0-9a-f]{64}\.(png|jpg|gif|bmp|webp|avif)$/;

/** Larger pictures are not kept. */
export const MAX_PICTURE_BYTES = 256 * 1024 * 1024;

function starts(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, i) => bytes[i] === value);
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The extension of a picture file from its first bytes, or null when it is not a picture that is kept. */
export function pictureExtension(bytes: Uint8Array): string | null {
  return SIGNATURES.find((signature) => signature.test(bytes))?.extension ?? null;
}

/** The media type of a kept picture, from its name. */
export function pictureMime(id: string): string {
  const extension = id.slice(id.lastIndexOf('.') + 1);
  return SIGNATURES.find((signature) => signature.extension === extension)?.mime ?? 'application/octet-stream';
}

/** Lowercase hexadecimal of a digest. */
export function hex(digest: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
