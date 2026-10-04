import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PICTURE_BYTES, PICTURE_ID, hex, pictureExtension } from '../src/util/pictureFiles';

/** What a write leaves behind when it is cut short. */
const PARTIAL = /^[0-9a-f]{64}\.(png|jpg|gif|bmp|webp|avif)\.part$/;

/**
 * The pictures that presets and the current session use, copied into the data folder, so a
 * look keeps its pictures when the originals are moved or deleted.
 */
export class PictureFolder {
  constructor(private readonly dir: string) {}

  /** Keeps a picture. Returns its id, or null when it is not a picture or is too large. */
  put(bytes: Uint8Array): string | null {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PICTURE_BYTES) return null;
    const extension = pictureExtension(bytes);
    if (!extension) return null;
    const id = `${hex(createHash('sha256').update(bytes).digest())}.${extension}`;
    const path = join(this.dir, id);
    if (!existsSync(path)) {
      mkdirSync(this.dir, { recursive: true });
      // Written aside and then renamed, so a crash never leaves half a picture under its name.
      writeFileSync(`${path}.part`, bytes);
      renameSync(`${path}.part`, path);
    }
    return id;
  }

  /** The bytes of a kept picture, or null when there is none by that id. */
  get(id: string): Uint8Array | null {
    if (!PICTURE_ID.test(id)) return null;
    try {
      return readFileSync(join(this.dir, id));
    } catch {
      return null;
    }
  }

  /** Deletes the kept pictures that are not in `ids`, and leftovers of cut-short writes. */
  keepOnly(ids: Iterable<string>): number {
    const keep = new Set(ids);
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if ((PICTURE_ID.test(name) && !keep.has(name)) || PARTIAL.test(name)) {
        rmSync(join(this.dir, name), { force: true });
        removed++;
      }
    }
    return removed;
  }
}
