/**
 * Preview renderer — annotates images with region bounding boxes
 * using sharp SVG overlay. Lightweight, no canvas dependency.
 */
const sharp = require('sharp');

/**
 * Render a preview image with region rectangles overlaid.
 *
 * @param {Buffer} imageBuffer - source image buffer
 * @param {Array} regions - array of { srcX, srcY, srcWidth, srcHeight, tgtX, tgtY }
 * @param {string} role - "base" or "reference"
 * @returns {Promise<Buffer>} annotated PNG buffer
 */
async function renderPreview(imageBuffer, regions, role) {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width;
  const h = meta.height;

  const isBase = role === 'base';
  const strokeColor = isBase ? '#3399ff' : '#ff3333';
  const label = isBase ? 'BASE (target)' : 'REFERENCE (source)';

  let svgParts = [];

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];

    // Draw source region rectangle (on reference image)
    if (!isBase) {
      svgParts.push(
        `<rect x="${r.srcX}" y="${r.srcY}" width="${r.srcWidth}" height="${r.srcHeight}" ` +
        `fill="none" stroke="${strokeColor}" stroke-width="3" stroke-dasharray="8,4"/>`
      );
      svgParts.push(
        `<text x="${r.srcX + 4}" y="${r.srcY - 6}" font-size="16" font-family="monospace" ` +
        `fill="${strokeColor}" font-weight="bold">SRC region ${i}</text>`
      );
    }

    // Draw target placement rectangle (on base image)
    if (isBase) {
      const tx = r.tgtX !== undefined ? r.tgtX : r.srcX;
      const ty = r.tgtY !== undefined ? r.tgtY : r.srcY;
      svgParts.push(
        `<rect x="${tx}" y="${ty}" width="${r.srcWidth}" height="${r.srcHeight}" ` +
        `fill="none" stroke="${strokeColor}" stroke-width="3" stroke-dasharray="8,4"/>`
      );
      svgParts.push(
        `<text x="${tx + 4}" y="${ty - 6}" font-size="16" font-family="monospace" ` +
        `fill="${strokeColor}" font-weight="bold">TGT region ${i}</text>`
      );
    }
  }

  // Role label at top-left
  svgParts.push(
    `<rect x="0" y="0" width="${label.length * 11 + 16}" height="28" fill="rgba(0,0,0,0.7)"/>` +
    `<text x="8" y="20" font-size="16" font-family="monospace" fill="white" font-weight="bold">${label}</text>`
  );

  const svgOverlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('')}</svg>`
  );

  return sharp(imageBuffer)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

module.exports = { renderPreview };
