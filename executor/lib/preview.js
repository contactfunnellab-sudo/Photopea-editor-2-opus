/**
 * Preview renderer — landmark-aware previews with face detection,
 * eye landmarks, patch boxes, and role labels.
 * Uses sharp SVG overlay. Lightweight, no canvas dependency.
 */
const sharp = require('sharp');

/**
 * Render a landmark-aware preview image.
 *
 * @param {Buffer} imageBuffer - source image buffer
 * @param {string} role - "base" or "reference"
 * @param {object} geometryData - geometry data from MediaPipe
 *   - allFaces: [{x,y,width,height},...] - all detected face bboxes
 *   - selectedFaceIdx: number - index of selected face
 *   - eyeLandmarks: [[x,y],...] - eye landmark points
 *   - patchBox: {x,y,width,height} - eye band bounding box
 *   - transform: {translateX, translateY, rotation, scale} - optional
 * @returns {Promise<Buffer>} annotated PNG buffer
 */
async function renderPreview(imageBuffer, role, geometryData) {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width;
  const h = meta.height;

  const isBase = role === 'base';
  const patchColor = isBase ? '#3399ff' : '#ff3333';
  const label = isBase ? 'BASE (target)' : 'REFERENCE (source)';

  const svgParts = [];
  const gd = geometryData || {};

  // 1. Draw all detected face bounding boxes (light gray for non-selected, green for selected)
  if (Array.isArray(gd.allFaces)) {
    for (let i = 0; i < gd.allFaces.length; i++) {
      const f = gd.allFaces[i];
      const isSelected = i === gd.selectedFaceIdx;
      const color = isSelected ? '#00ff00' : '#555555';
      const sw = isSelected ? 2 : 1;
      svgParts.push(
        `<rect x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" ` +
        `fill="none" stroke="${color}" stroke-width="${sw}"/>`
      );
      svgParts.push(
        `<text x="${f.x + 3}" y="${f.y - 4}" font-size="12" font-family="monospace" ` +
        `fill="${color}">Face ${i}${isSelected ? ' (selected)' : ''}</text>`
      );
    }
  }

  // 2. Draw eye landmarks as small dots
  if (Array.isArray(gd.eyeLandmarks)) {
    for (const [x, y] of gd.eyeLandmarks) {
      svgParts.push(
        `<circle cx="${x}" cy="${y}" r="2" fill="#ff4444" stroke="none"/>`
      );
    }
    // Draw eye contour as polyline
    if (gd.eyeLandmarks.length > 2) {
      const polyPoints = gd.eyeLandmarks.map(([x, y]) => `${x},${y}`).join(' ');
      svgParts.push(
        `<polyline points="${polyPoints}" fill="none" stroke="#ff4444" stroke-width="1" opacity="0.6"/>`
      );
    }
  }

  // 3. Draw patch bounding box
  if (gd.patchBox) {
    const pb = gd.patchBox;
    svgParts.push(
      `<rect x="${pb.x}" y="${pb.y}" width="${pb.width}" height="${pb.height}" ` +
      `fill="none" stroke="${patchColor}" stroke-width="3" stroke-dasharray="8,4"/>`
    );
    const patchLabel = isBase ? 'TARGET patch' : 'SOURCE patch';
    svgParts.push(
      `<text x="${pb.x + 4}" y="${pb.y - 6}" font-size="14" font-family="monospace" ` +
      `fill="${patchColor}" font-weight="bold">${patchLabel}</text>`
    );
  }

  // 4. Role label at top-left
  svgParts.push(
    `<rect x="0" y="0" width="${label.length * 10 + 16}" height="28" fill="rgba(0,0,0,0.7)"/>` +
    `<text x="8" y="20" font-size="16" font-family="monospace" fill="white" font-weight="bold">${label}</text>`
  );

  // 5. Transform info (on base image only)
  if (isBase && gd.transform) {
    const t = gd.transform;
    const info = `scale=${t.scale} rot=${Math.round(t.rotation * 180 / Math.PI * 10) / 10}° tx=${t.translateX} ty=${t.translateY}`;
    svgParts.push(
      `<rect x="0" y="${h - 28}" width="${info.length * 8 + 16}" height="28" fill="rgba(0,0,0,0.7)"/>` +
      `<text x="8" y="${h - 8}" font-size="13" font-family="monospace" fill="#aaaaaa">${info}</text>`
    );
  }

  const svgOverlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('')}</svg>`
  );

  return sharp(imageBuffer)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

module.exports = { renderPreview };
