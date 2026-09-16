/**
 * Client-side image normalization for Holodilnik.
 *
 * Pipeline:
 *   user selects/captures image
 *   → decode locally (correct orientation)
 *   → remove metadata by re-encoding (EXIF/GPS stripped)
 *   → resize long edge ~1440–1600px (never upscale)
 *   → compress JPEG (quality 0.84 → 0.55, bounded iterations)
 *   → if still >200KB at floor quality, reduce dimensions (1280 → 1024 → 800)
 *   → stop when <=200KB where practical; allow <=300KB rather than blurry
 *   → never intentionally exceed 300KB
 *
 * Returns structured metadata; never logs base64.
 *
 * HEIC / iPhone:
 *  - Safari 17+ decodes HEIC/HEIF natively via createImageBitmap / <img>.
 *    In that case we normalize automatically to JPEG bytes (real JPEG, not
 *    MIME rename).
 *  - Chrome/Firefox cannot decode HEIC — `createImageBitmap` / Image will
 *    error. We surface a clear recoverable error so user can convert via
 *    iOS Share → Save as JPEG (or Settings → Camera → Formats → Most Compatible).
 *  - Actual bytes are always re-encoded JPEG; we never just change MIME type.
 *
 * Tested behavior (documented):
 *  - Chrome 120+ / Firefox 120+ / Edge: JPEG/PNG/WebP OK; HEIC fails → error.
 *  - Safari iOS 17+ / macOS 14+: JPEG/PNG/WebP + HEIC OK (decoded then normalized).
 *  - Small images (<200KB, <1440 long edge) are not upscaled; re-encoded to
 *    strip EXIF but kept at original dimensions/quality.
 */

export interface CompressionMetadata {
  originalBytes: number;
  compressedBytes: number;
  originalWidth: number;
  originalHeight: number;
  outputWidth: number;
  outputHeight: number;
  mimeType: string; // always image/jpeg in this phase (JPEG is widest compatible)
}

export interface CompressionResult {
  base64: string; // without data: prefix — ready for POST {imageBase64}
  mimeType: string;
  blob: Blob;
  dataUrl: string; // for preview (normalized image that is actually sent to model)
  metadata: CompressionMetadata;
}

export const TARGET_BYTES = 200 * 1024;
export const HARD_CEILING = 300 * 1024;
export const LONG_EDGE_INITIAL = 1440; // spec: 1440–1600; we use 1440 for balance detail/size
export const QUALITIES = [0.84, 0.8, 0.75, 0.7, 0.62, 0.55] as const; // floor 0.55 prevents blurry
export const DIMENSION_FALLBACKS = [1280, 1024, 800, 640] as const;
export const MIME_OUTPUT = "image/jpeg";

export function calculateSize(
  origW: number,
  origH: number,
  longEdge: number,
): { w: number; h: number } {
  const long = Math.max(origW, origH);
  if (long <= longEdge) {
    return { w: origW, h: origH };
  }
  const scale = longEdge / long;
  const w = Math.round(origW * scale);
  const h = Math.round(origH * scale);
  // Guard: never return 0
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

export function isHeicFile(file: File): boolean {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  return (
    t === "image/heic" ||
    t === "image/heif" ||
    t === "image/heic-sequence" ||
    t === "image/heif-sequence" ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  );
}

async function loadImage(
  file: File,
): Promise<{ image: CanvasImageSource; width: number; height: number; close?: () => void }> {
  // Prefer createImageBitmap with orientation correction (modern browsers)
  // `imageOrientation: "from-image"` handles EXIF orientation.
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as never);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch (err) {
      // Fall through to Image fallback — will surface HEIC error if truly unsupported
      if (isHeicFile(file)) {
        // createImageBitmap failed for HEIC — let Image attempt as well before throwing
      } else {
        // For non-HEIC, treat createImageBitmap failure as still try Image
      }
      // console debug without bytes
      if (import.meta.env?.DEV) {
        console.warn(
          "[compress] createImageBitmap failed, fallback to Image:",
          (err as Error).message,
        );
      }
    }
  }

  // Fallback: <img>
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      // Do not set crossOrigin for local files
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(new Error(isHeicFile(file) ? "HEIC_DECODE_FAILED" : "IMAGE_DECODE_FAILED"));
      el.src = url;
    });
    // `naturalWidth/Height` already reflect decoded size; EXIF orientation
    // is auto-applied in browsers that support `image-orientation: from-image`
    // (Chrome/Safari apply for JPEG). For HEIC where unsupported, we would
    // have already errored.
    return {
      image: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("CANVAS_ENCODE_FAILED"));
        } else {
          resolve(blob);
        }
      },
      mime,
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("READ_FAILED"));
    fr.readAsDataURL(blob);
  });
}

function blobToBase64(_blob: Blob, dataUrl: string): string {
  // dataUrl = data:image/jpeg;base64,...
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export async function compressImage(file: File): Promise<CompressionResult> {
  const originalBytes = file.size;

  if (!file.type.startsWith("image/") && !isHeicFile(file)) {
    throw Object.assign(new Error("Пожалуйста, выберите изображение"), {
      code: "INVALID_TYPE",
    });
  }

  // Decode locally
  let loaded: Awaited<ReturnType<typeof loadImage>>;
  try {
    loaded = await loadImage(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "HEIC_DECODE_FAILED") {
      throw Object.assign(
        new Error(
          "Фото в формате HEIC не удалось открыть в этом браузере. На iPhone откройте фото → Поделиться → Сохранить как JPEG (или Настройки → Камера → Форматы → Наиболее совместимый), затем загрузите снова.",
        ),
        { code: "HEIC_DECODE_FAILED" },
      );
    }
    if (msg === "IMAGE_DECODE_FAILED") {
      throw Object.assign(new Error("Не удалось прочитать изображение. Попробуйте другое фото."), {
        code: "IMAGE_DECODE_FAILED",
      });
    }
    throw Object.assign(new Error("Не удалось обработать изображение. Попробуйте другое фото."), {
      code: "IMAGE_DECODE_FAILED",
    });
  }

  const originalWidth = loaded.width;
  const originalHeight = loaded.height;

  if (!originalWidth || !originalHeight) {
    loaded.close?.();
    throw Object.assign(new Error("Изображение повреждено или пустое."), {
      code: "INVALID_IMAGE",
    });
  }

  // Small-image fast path: if original already <=200KB and dimensions <= LONG_EDGE_INITIAL,
  // still re-encode to strip EXIF but avoid aggressive downscale.
  // We still run the bounded loop — it will pick 1440 or original size and quality 0.84
  // and quickly succeed.

  // Create canvas (reuse single canvas, resize as needed)
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    loaded.close?.();
    throw new Error("Canvas не поддерживается в этом браузере");
  }
  // Ensure high quality scaling
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  let bestBlob: Blob | null = null;
  let bestQuality: number | null = null;
  let bestDimensions: { w: number; h: number } | null = null;
  let bestDataUrl: string | null = null;

  const longEdgeCandidates = [LONG_EDGE_INITIAL, ...DIMENSION_FALLBACKS];

  // Helper to try encode for given dimensions + quality
  const tryEncode = async (
    targetW: number,
    targetH: number,
    quality: number,
  ): Promise<{ blob: Blob; dataUrl: string }> => {
    canvas.width = targetW;
    canvas.height = targetH;
    // Clear and draw (white background for JPEG — transparent PNG would become black otherwise)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(loaded.image as CanvasImageSource, 0, 0, targetW, targetH);
    const blob = await canvasToBlob(canvas, MIME_OUTPUT, quality);
    const dataUrl = await blobToDataUrl(blob);
    return { blob, dataUrl };
  };

  let foundOver200Under300: {
    blob: Blob;
    dataUrl: string;
    w: number;
    h: number;
    q: number;
  } | null = null;

  outer: for (const longEdge of longEdgeCandidates) {
    const { w, h } = calculateSize(originalWidth, originalHeight, longEdge);
    for (const q of QUALITIES) {
      const { blob, dataUrl } = await tryEncode(w, h, q);
      const size = blob.size;

      // Development logging: sizes only, never bytes/base64
      if (import.meta.env?.DEV) {
        console.debug(
          `[compress] ${originalWidth}x${originalHeight} → ${w}x${h} q=${q} => ${size} bytes (${(size / 1024).toFixed(1)}KB)`,
        );
      }

      if (size <= TARGET_BYTES) {
        bestBlob = blob;
        bestDataUrl = dataUrl;
        bestQuality = q;
        bestDimensions = { w, h };
        break outer;
      }

      // Track best candidate that is >200 but <=300 (prefer smaller size / higher quality)
      if (size <= HARD_CEILING) {
        if (!foundOver200Under300 || size < foundOver200Under300.blob.size) {
          foundOver200Under300 = { blob, dataUrl, w, h, q };
        }
        // Don't break — try next quality/dimension to see if we can get <=200 still
      }

      // If at smallest dimension & lowest quality still >300, we will have to force smaller below
      // Continue loop to try next dimension (more aggressive)
    }

    // If we completed all qualities for this dimension and had a <=300 candidate,
    // we keep searching smaller dimensions for a chance to hit <=200, but
    // we remember the <=300 candidate in case no <=200 is ever found.
    // Do not `break` here — continue to smaller longEdge to try get <=200.
  }

  // Decide final
  if (!bestBlob) {
    if (foundOver200Under300) {
      // Allow <=300KB rather than blurry <=200KB destroy — spec requires this
      bestBlob = foundOver200Under300.blob;
      bestDataUrl = foundOver200Under300.dataUrl;
      bestDimensions = { w: foundOver200Under300.w, h: foundOver200Under300.h };
      bestQuality = foundOver200Under300.q;
      if (import.meta.env?.DEV) {
        console.debug(
          `[compress] target 200KB not met without destroying quality; using <=300KB candidate ${bestBlob.size} bytes q=${bestQuality} ${bestDimensions.w}x${bestDimensions.h}`,
        );
      }
    } else {
      // Even smallest fallback >300KB (very detailed large image at q=0.55 640px).
      // Force one final encode at 640px 0.55 (already tried) — pick smallest we have.
      // We already tried 640 0.55 as last combo; if still >300KB, we need to admit
      // that this image at usable quality cannot reach 300KB. Per spec "Never
      // intentionally exceed 300KB" — but we must not produce unusably blurry.
      // Re-try with 640 q=0.5 as last resort before throwing.
      const last = {
        w: calculateSize(originalWidth, originalHeight, 640).w,
        h: calculateSize(originalWidth, originalHeight, 640).h,
      };
      const { blob, dataUrl } = await tryEncode(last.w, last.h, 0.5);
      if (blob.size <= HARD_CEILING) {
        bestBlob = blob;
        bestDataUrl = dataUrl;
        bestDimensions = last;
        bestQuality = 0.5;
      } else {
        // Still >300KB — return the smallest size but log warning; server will
        // reject with 413 and we will surface Russian message.
        // This is not "intentionally" exceeding — it's the minimal blurry we allow.
        // For this edge case, we return the blob anyway and let caller decide
        // to surface IMAGE_TOO_LARGE before upload, rather than upload >300KB.
        loaded.close?.();
        throw Object.assign(
          new Error(
            "Фото слишком большое даже после сжатия. Попробуйте снять с чуть большего расстояния или выберите другое фото.",
          ),
          { code: "IMAGE_TOO_LARGE_AFTER_COMPRESSION", compressedBytes: blob.size },
        );
      }
    }
  }

  // Final validation
  if (!bestBlob || !bestDataUrl || !bestDimensions || bestQuality == null) {
    loaded.close?.();
    throw new Error("Не удалось сжать изображение");
  }

  const compressedBytes = bestBlob.size;
  const base64 = blobToBase64(bestBlob, bestDataUrl);

  // Dev-only logging of sanitized metadata (never base64)
  if (import.meta.env?.DEV) {
    console.log(
      `[compress] ${originalBytes} → ${compressedBytes} bytes (${((compressedBytes / originalBytes) * 100).toFixed(1)}% ratio) ${originalWidth}x${originalHeight} → ${bestDimensions.w}x${bestDimensions.h} q=${bestQuality}`,
    );
  }

  // Release resources
  loaded.close?.();
  // Note: canvas remains; GC will handle.

  // Safety: never intentionally exceed hard ceiling (should have been handled)
  if (compressedBytes > HARD_CEILING) {
    throw Object.assign(
      new Error("Сжатое фото всё ещё больше 300 КБ — попробуйте другое изображение."),
      { code: "IMAGE_TOO_LARGE_AFTER_COMPRESSION", compressedBytes },
    );
  }

  return {
    base64,
    mimeType: MIME_OUTPUT,
    blob: bestBlob,
    dataUrl: bestDataUrl,
    metadata: {
      originalBytes,
      compressedBytes,
      originalWidth,
      originalHeight,
      outputWidth: bestDimensions.w,
      outputHeight: bestDimensions.h,
      mimeType: MIME_OUTPUT,
    },
  };
}

/**
 * Utility to check if file needs HEIC handling note.
 * Returns true if browser likely cannot decode HEIC (Chrome/Firefox).
 */
export function isHeicProbablyUnsupported(): boolean {
  // Simple heuristic: if browser doesn't advertise heic in accept, likely unsupported
  // Safari is only engine with native HEIC decode. Check for Safari via vendor.
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  const isSafari = ua.includes("safari") && !ua.includes("chrome") && !ua.includes("chromium");
  return !isSafari;
}
