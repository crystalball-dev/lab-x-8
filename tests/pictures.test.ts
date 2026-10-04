import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PictureFolder } from '../electron/pictures';
import { createParamStore } from '../src/params/schema';
import { PresetManager } from '../src/params/presets';
import { fromBase64 } from '../src/util/base64';
import { PICTURE_ID, pictureExtension, pictureMime } from '../src/util/pictureFiles';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]);
const AVIF = new Uint8Array([0, 0, 0, 28, ...Buffer.from('ftypavif'), 0, 0, 0, 0]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lab-x-8-pictures-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Picture files', () => {
  it('are recognised by their first bytes, not their names', () => {
    expect(pictureExtension(PNG)).toBe('png');
    expect(pictureExtension(JPG)).toBe('jpg');
    expect(pictureExtension(WEBP)).toBe('webp');
    expect(pictureExtension(AVIF)).toBe('avif');
    expect(pictureExtension(new Uint8Array([...Buffer.from('GIF89a')]))).toBe('gif');
    expect(pictureExtension(new Uint8Array([...Buffer.from('<svg xmlns=')]))).toBeNull();
    expect(pictureMime(`${'a'.repeat(64)}.jpg`)).toBe('image/jpeg');
  });
});

describe('PictureFolder', () => {
  it('keeps a picture under the hash of its content, once', () => {
    const folder = new PictureFolder(join(dir, 'pictures'));
    const id = folder.put(PNG)!;
    expect(id).toBe(`${createHash('sha256').update(PNG).digest('hex')}.png`);
    expect(id).toMatch(PICTURE_ID);
    expect(folder.put(PNG)).toBe(id);
    expect(readdirSync(join(dir, 'pictures'))).toEqual([id]);
    expect([...folder.get(id)!]).toEqual([...PNG]);
  });

  it('refuses what is not a picture, and reads nothing but kept pictures', () => {
    const folder = new PictureFolder(join(dir, 'pictures'));
    expect(folder.put(new Uint8Array([...Buffer.from('#!/bin/sh')]))).toBeNull();
    expect(folder.put(new Uint8Array())).toBeNull();
    writeFileSync(join(dir, 'secret.txt'), 'private');
    expect(folder.get('../secret.txt')).toBeNull();
    expect(folder.get(`${'0'.repeat(64)}.png`)).toBeNull();
  });

  it('forgets the pictures nobody uses, and nothing else', () => {
    const pictures = join(dir, 'pictures');
    const folder = new PictureFolder(pictures);
    const keep = folder.put(PNG)!;
    const drop = folder.put(JPG)!;
    writeFileSync(join(pictures, `${'b'.repeat(64)}.png.part`), 'cut short');
    writeFileSync(join(pictures, 'notes.txt'), 'mine');
    expect(folder.keepOnly([keep])).toBe(2);
    expect(existsSync(join(pictures, keep))).toBe(true);
    expect(existsSync(join(pictures, drop))).toBe(false);
    expect(existsSync(join(pictures, 'notes.txt'))).toBe(true);
  });
});

describe('Presets with pictures', () => {
  it('remember the picture in each layer, and say which kept pictures they use', () => {
    const presets = new PresetManager(createParamStore());
    const pictures = { image: { id: `${'a'.repeat(64)}.png`, name: 'cupola.png' }, image3: { id: `${'b'.repeat(64)}.jpg`, name: 'jelly.jpg' } };
    const saved = presets.save('Under the sea', pictures);
    expect(saved.data.pictures).toEqual(pictures);
    expect(presets.save('No pictures').data.pictures).toBeUndefined();
    expect(presets.pictureIds).toEqual(new Set([pictures.image.id, pictures.image3.id]));
    expect(presets.apply(saved.id)?.data.pictures).toEqual(pictures);
  });

  it('carry pictures in files as base64', () => {
    expect([...fromBase64(Buffer.from(PNG).toString('base64'))]).toEqual([...PNG]);
  });
});
