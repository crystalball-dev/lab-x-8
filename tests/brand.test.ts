import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../src/brand';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  productName: string;
  author: { name: string };
};
const builder = readFileSync('electron-builder.yml', 'utf8');

describe('Brand', () => {
  it('names the program the way the packaging does', () => {
    // The packaged program, its folder and its data folder are named from productName.
    expect(pkg.productName).toBe(BRAND.name);
    expect(builder).toMatch(new RegExp(`^productName: ${BRAND.name}$`, 'm'));
    expect(builder).toContain(`artifactName: ${BRAND.name.replace(/\s+/g, '-')}-portable.exe`);
  });

  it('credits the publisher in the executable', () => {
    expect(pkg.author.name).toBe(BRAND.publisher);
    expect(builder).toContain(`copyright: Copyright ${BRAND.copyright}`);
  });

  it('writes file names from the product name', () => {
    expect(BRAND.slug).toBe(BRAND.name.toLowerCase().replace(/\s+/g, '-'));
  });
});
