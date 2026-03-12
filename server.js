const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '5mb' }));

const ROOT = __dirname;
const SAMPLE_BASE = path.join(ROOT, 'Base image.jpg');
const SAMPLE_REFERENCE = path.join(ROOT, 'reference image.jpg');
const SAMPLE_POST = path.join(ROOT, 'sample reddit post.txt');
const OUTPUT_DIR = 'D:\\Reddit PS automation\\Final images';

app.use(express.static(path.join(ROOT, 'public')));

let browser;
let uiPage;
let photopeaPage;

async function clickStartUsingPhotopeaIfVisible(page, logs) {
  const iframeHandle = await page.$('#pp');
  if (!iframeHandle) return false;

  const frame = await iframeHandle.contentFrame();
  if (!frame) return false;

  const startButton = frame.getByRole('button', { name: /start using photopea/i }).first();
  try {
    await startButton.waitFor({ state: 'visible', timeout: 2500 });
    await startButton.click({ timeout: 5000 });
    logs.push('Clicked "Start using Photopea" button.');
    await page.waitForTimeout(1200);
    return true;
  } catch {
    return false;
  }
}

function parseSamplePost() {
  const raw = fs.readFileSync(SAMPLE_POST, 'utf8');
  const title = (raw.match(/title:(.*)/i) || ['', ''])[1].trim();
  const body = (raw.match(/body text:(.*)/i) || ['', ''])[1].trim();
  return { title, body };
}

function extToFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  return 'jpg';
}

function validateLocalPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Image path must be a non-empty string.');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Image path must be absolute: ${filePath}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Image path does not exist: ${filePath}`);
  }
}

app.get('/api/file', (req, res) => {
  try {
    const filePath = String(req.query.path || '');
    validateLocalPath(filePath);
    res.sendFile(filePath);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

async function ensureBrowser(port) {
  if (browser) return;
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  uiPage = await context.newPage();
  await uiPage.goto(`http://127.0.0.1:${port}`);
}

app.get('/api/defaults', (req, res) => {
  const { title, body } = parseSamplePost();
  res.json({
    baseImage: SAMPLE_BASE,
    referenceImage: SAMPLE_REFERENCE,
    redditTitle: title,
    redditBody: body
  });
});

app.post('/api/run', async (req, res) => {
  const logs = [];
  try {
    const {
      baseImage,
      referenceImage,
      redditTitle,
      redditBody,
      offsetX = 0,
      offsetY = 0,
      scalePct = 100
    } = req.body;

    logs.push(`Request: ${redditTitle || '(untitled)'}`);
    logs.push(`Body: ${redditBody || '(empty)'}`);

    validateLocalPath(baseImage);
    validateLocalPath(referenceImage);

    const exportFormat = extToFormat(baseImage);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    if (!photopeaPage || photopeaPage.isClosed()) {
      photopeaPage = await uiPage.context().newPage();
      await photopeaPage.goto(`http://127.0.0.1:${PORT}/photopea-runner.html`, { waitUntil: 'domcontentloaded' });
      logs.push('Opened Photopea runner window.');
    }

    const baseImageUrl = `http://127.0.0.1:${PORT}/api/file?path=${encodeURIComponent(baseImage)}`;
    const referenceImageUrl = `http://127.0.0.1:${PORT}/api/file?path=${encodeURIComponent(referenceImage)}`;

    logs.push('Preparing Photopea workspace and uploading files.');
    logs.push('Running Photopea script actions.');

    const payload = {
      baseImageUrl,
      referenceImageUrl,
      offsetX,
      offsetY,
      scalePct,
      exportFormat
    };

    const preClicked = await clickStartUsingPhotopeaIfVisible(photopeaPage, logs);
    if (preClicked) {
      logs.push('Entered Photopea editor before upload.');
    }

    let result;
    try {
      result = await photopeaPage.evaluate(async (runPayload) => {
        return window.runAutomation(runPayload);
      }, payload);
    } catch (firstError) {
      logs.push(`Initial automation attempt failed: ${firstError.message}`);
      const clicked = await clickStartUsingPhotopeaIfVisible(photopeaPage, logs);
      if (!clicked) throw firstError;

      logs.push('Retrying automation after clicking start button.');
      result = await photopeaPage.evaluate(async (runPayload) => {
        return window.runAutomation(runPayload);
      }, payload);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = path.parse(baseImage).name;
    const outImage = path.join(OUTPUT_DIR, `${baseName}-${stamp}.${exportFormat}`);
    const outPsd = path.join(OUTPUT_DIR, `${baseName}-${stamp}.psd`);

    fs.writeFileSync(outImage, Buffer.from(result.imageBase64, 'base64'));
    fs.writeFileSync(outPsd, Buffer.from(result.psdBase64, 'base64'));

    logs.push('Saved output image and PSD.');

    res.json({ logs, outputImagePath: outImage, outputPsdPath: outPsd });
  } catch (error) {
    logs.push(`Error: ${error.message}`);
    res.status(500).json({ logs, error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, async () => {
  console.log(`UI running at http://127.0.0.1:${PORT}`);
  await ensureBrowser(PORT);
});
