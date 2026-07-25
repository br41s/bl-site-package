import sharp from "sharp";
import { createHash } from "node:crypto";

// Max size of a decoded upload we'll accept before re-encoding. The base64
// JSON body is capped separately in server.js (route-scoped express.json
// limit); this guards the decoded buffer so a small-but-adversarial payload
// (e.g. a highly compressed image that decodes huge) can't exhaust memory.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Longest edge of the stored image. Blog covers and page heroes never need
// more than this on the web; downscaling keeps pages fast and files small.
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 80;

// Formats sharp is allowed to READ. SVG is deliberately absent: sharp would
// rasterize it, but parsing attacker-controlled SVG opens XXE / density-bomb
// vectors, and an SVG served same-origin is a stored-XSS shape we already ban
// for the logo. Everything here is a raster format that re-encodes safely.
const ALLOWED_INPUT_FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "tiff"]);

/**
 * Decode a base64 image, validate it's a safe raster format, downscale to fit
 * within MAX_DIMENSION, and re-encode to optimized WebP. Re-encoding is the
 * security boundary: the bytes written to disk are always freshly authored by
 * sharp, never the client's original file.
 *
 * Accepts a bare base64 string or a data URI ("data:image/png;base64,...").
 * Returns { buffer, filename } where filename is "<sha256-of-webp>.webp".
 * Throws Error("...") with a user-safe message on any invalid input.
 */
export async function optimizeToWebp(base64) {
  if (typeof base64 !== "string" || !base64.trim()) {
    throw new Error("No se recibió ninguna imagen");
  }
  // Strip an optional data-URI prefix, then decode.
  const raw = base64.replace(/^data:[^;]+;base64,/, "").trim();
  const input = Buffer.from(raw, "base64");
  if (input.length === 0) throw new Error("La imagen no es un base64 válido");
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new Error("La imagen supera el tamaño máximo (10 MB)");
  }

  let image;
  try {
    // limitInputPixels guards against decompression-bomb dimensions.
    image = sharp(input, { failOn: "error", limitInputPixels: 268402689 });
    const meta = await image.metadata();
    if (!ALLOWED_INPUT_FORMATS.has(meta.format)) {
      throw new Error("Formato de imagen no soportado");
    }
  } catch (err) {
    // Normalize sharp's internal errors into one user-safe message.
    if (err.message === "Formato de imagen no soportado") throw err;
    throw new Error("El archivo no es una imagen válida");
  }

  const buffer = await image
    .rotate() // honor EXIF orientation before we strip metadata
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  return { buffer, filename: `${hash}.webp` };
}
