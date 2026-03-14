/**
 * Preview renderer — per-eye landmark-aware previews with face detection,
 * separate left/right eye landmarks, patch boxes, and role labels.
 * Uses sharp SVG overlay. Lightweight, no canvas dependency.
 */
const sharp = require('sharp');

/**
 * Render a per-eye landmark-aware preview image.
 *
 * @param {Buffer} imageBuffer - source image buffer
 * @param {string} role - "base" or "reference"
 * @param {object} geometryData - per-eye geometry data from MediaPipe
 *   - allFaces: [{x,y,width,height},...] - all detected face bboxes
 *   - selectedFaceIdx: number - index of selected face
 *   - leftEyeLandmarks: [[x,y],...] - left eye landmark points
 *   - rightEyeLandmarks: [[x,y],...] - right eye landmark points
 *   - leftEyeBox: {x,y,width,height} - left eye patch bounding box
 *   - rightEyeBox: {x,y,width,height} - right eye patch bounding box
 *   - leftTransform: {translateX, translateY, rotation, scale} - optional
 *   - rightTransform: {translateX, translateY, rotation, scale} - optional
 * @returns {Promise<Buffer>} annotated PNG buffer
 */
async function renderPreview(imageBuffer, role, geometryData) {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width;
  const h = meta.height;

  const isBase = role === 'base';
  const label = isBase ? 'BASE (target)' : 'REFERENCE (source)';

  const svgParts = [];
  const gd = geometryData || {};

  // 1. Draw all detected face bounding boxes
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

  // 2. Draw left eye landmarks (cyan) + contour
  if (Array.isArray(gd.leftEyeLandmarks) && gd.leftEyeLandmarks.length > 0) {
    for (const [x, y] of gd.leftEyeLandmarks) {
      svgParts.push(`<circle cx="${x}" cy="${y}" r="2" fill="#00ccff" stroke="none"/>`);
    }
    if (gd.leftEyeLandmarks.length > 2) {
      const pts = gd.leftEyeLandmarks.map(([x, y]) => `${x},${y}`).join(' ');
      svgParts.push(`<polyline points="${pts}" fill="none" stroke="#00ccff" stroke-width="1" opacity="0.6"/>`);
    }
  }

  // 3. Draw right eye landmarks (magenta) + contour
  if (Array.isArray(gd.rightEyeLandmarks) && gd.rightEyeLandmarks.length > 0) {
    for (const [x, y] of gd.rightEyeLandmarks) {
      svgParts.push(`<circle cx="${x}" cy="${y}" r="2" fill="#ff00cc" stroke="none"/>`);
    }
    if (gd.rightEyeLandmarks.length > 2) {
      const pts = gd.rightEyeLandmarks.map(([x, y]) => `${x},${y}`).join(' ');
      svgParts.push(`<polyline points="${pts}" fill="none" stroke="#ff00cc" stroke-width="1" opacity="0.6"/>`);
    }
  }

  // 4. Draw left eye patch box (cyan dashed)
  if (gd.leftEyeBox) {
    const pb = gd.leftEyeBox;
    svgParts.push(
      `<rect x="${pb.x}" y="${pb.y}" width="${pb.width}" height="${pb.height}" ` +
      `fill="none" stroke="#00ccff" stroke-width="2" stroke-dasharray="6,3"/>`
    );
    const boxLabel = isBase ? 'L_EYE target' : 'L_EYE source';
    svgParts.push(
      `<text x="${pb.x + 3}" y="${pb.y - 4}" font-size="11" font-family="monospace" ` +
      `fill="#00ccff" font-weight="bold">${boxLabel}</text>`
    );
  }

  // 5. Draw right eye patch box (magenta dashed)
  if (gd.rightEyeBox) {
    const pb = gd.rightEyeBox;
    svgParts.push(
      `<rect x="${pb.x}" y="${pb.y}" width="${pb.width}" height="${pb.height}" ` +
      `fill="none" stroke="#ff00cc" stroke-width="2" stroke-dasharray="6,3"/>`
    );
    const boxLabel = isBase ? 'R_EYE target' : 'R_EYE source';
    svgParts.push(
      `<text x="${pb.x + 3}" y="${pb.y - 4}" font-size="11" font-family="monospace" ` +
      `fill="#ff00cc" font-weight="bold">${boxLabel}</text>`
    );
  }

  // 6. Role label at top-left
  svgParts.push(
    `<rect x="0" y="0" width="${label.length * 10 + 16}" height="28" fill="rgba(0,0,0,0.7)"/>` +
    `<text x="8" y="20" font-size="16" font-family="monospace" fill="white" font-weight="bold">${label}</text>`
  );

  // 7. Transform info (on base image only) — show per-eye transforms
  if (isBase) {
    const lines = [];
    if (gd.leftTransform) {
      const t = gd.leftTransform;
      lines.push(`L: s=${t.scale} r=${Math.round(t.rotation*180/Math.PI*10)/10}° tx=${t.translateX} ty=${t.translateY}`);
    }
    if (gd.rightTransform) {
      const t = gd.rightTransform;
      lines.push(`R: s=${t.scale} r=${Math.round(t.rotation*180/Math.PI*10)/10}° tx=${t.translateX} ty=${t.translateY}`);
    }
    for (let li = 0; li < lines.length; li++) {
      const y = h - 28 * (lines.length - li);
      svgParts.push(
        `<rect x="0" y="${y}" width="${lines[li].length * 7.5 + 16}" height="26" fill="rgba(0,0,0,0.7)"/>` +
        `<text x="8" y="${y + 18}" font-size="12" font-family="monospace" fill="#aaaaaa">${lines[li]}</text>`
      );
    }
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
