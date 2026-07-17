/**
 * Still-image sources (photos, logos, SVG…). An image asset has no decoder
 * pipeline: it is rasterized once into an ImageBitmap and drawn like a video
 * frame that never changes. Shared by probing, the preview and the export.
 */

/** Raster formats every WebCodecs-capable browser decodes natively. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|bmp|ico|svg)$/i;

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name);
}

/**
 * The subset of mediabunny's VideoSample the compositor actually draws with.
 * A rasterized still satisfies it too, so preview and export composite images
 * through the exact same code path as video frames.
 */
export interface DrawableFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** A rasterized still image, drawable exactly like a decoded video frame. */
export class StillFrame implements DrawableFrame {
  constructor(readonly bitmap: ImageBitmap) {}

  get displayWidth(): number {
    return this.bitmap.width;
  }

  get displayHeight(): number {
    return this.bitmap.height;
  }

  draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    // A closed bitmap (asset removed while a stale reference is still drawn)
    // reports 0×0 and drawImage would throw: skip instead of crashing a frame.
    if (this.bitmap.width === 0) return;
    ctx.drawImage(this.bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  close(): void {
    this.bitmap.close();
  }
}

/**
 * Fallback raster size for an SVG with no intrinsic dimensions (width/height
 * omitted on the root element): large enough to stay sharp full-frame in a
 * 1080p export.
 */
const SVG_FALLBACK_W = 1920;
const SVG_FALLBACK_H = 1080;

/**
 * Rasterize an image file into an ImageBitmap. `createImageBitmap(blob)`
 * handles every raster format; SVG blobs are rejected by it (no intrinsic
 * bitmap), so they go through an <img> element instead - which also catches
 * any other format the direct path cannot decode. Throws if nothing can
 * decode the file.
 */
export async function decodeImageFile(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    return await decodeViaImageElement(file);
  }
}

async function decodeViaImageElement(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || SVG_FALLBACK_W;
    const h = img.naturalHeight || SVG_FALLBACK_H;
    // Rasterize through a canvas: unlike createImageBitmap(img), drawImage
    // accepts an SVG with no intrinsic size (it fills the given rectangle).
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}
