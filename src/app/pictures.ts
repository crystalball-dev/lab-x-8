import { MAX_IMAGE_SIZE } from '../gfx/Renderer';

/** Largest size of a preview in the control panel, in pixels: twice the size it shows at. */
const THUMBNAIL_WIDTH = 96;
const THUMBNAIL_HEIGHT = 64;

/**
 * Decodes a picture file for an image layer, downscaled when it is larger than the renderer
 * takes. Bitmaps ignore the GL flip and premultiply flags, so both are baked in while decoding.
 */
export async function decodePicture(file: File): Promise<ImageBitmap> {
  const decode: ImageBitmapOptions = { imageOrientation: 'flipY', premultiplyAlpha: 'premultiply' };
  const bitmap = await createImageBitmap(file, decode);
  const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return bitmap;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  bitmap.close();
  return createImageBitmap(file, { ...decode, resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
}

/**
 * A small preview of a picture for the control panel, as a data URL.
 * @param flipped  whether its rows are upside down, as in a bitmap decoded for upload
 */
export function thumbnail(source: CanvasImageSource, width: number, height: number, flipped: boolean): string {
  const scale = Math.min(THUMBNAIL_WIDTH / width, THUMBNAIL_HEIGHT / height, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const g = canvas.getContext('2d')!;
  if (flipped) {
    g.translate(0, canvas.height);
    g.scale(1, -1);
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
