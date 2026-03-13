# Photopea Primitive Editor — Setup

## Install

```bash
cd executor
npm install
npm run install-browsers
```

## Sync skills to local n8n (Windows, one-time)

```bash
node skills/sync-to-local.js
```

Copies `skills/**/*.mb` from this repo to `D:\Reddit PS automation\n8n-assets\skills\`.

## Run

```bash
cd executor
npm start
# http://127.0.0.1:3000
```

First run may be slower due to model/backend initialization.
CPU execution (tfjs-node). No GPU acceleration in this architecture.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/primitives/face-landmarks` | Detect face landmarks, return polygon paths |
| POST | `/api/primitives/build` | Primitive router (face_landmarks, stubs, fallbacks) |
| POST | `/api/feature-transfer` | Path-based Photopea execution (v2) |
| POST | `/api/feature-swap` | Legacy ellipse-based execution (v1) |
| GET | `/api/health` | Health check |

## n8n Workflow

Import `PS Request Fulfiller v12 Photopea MVP (in development).json` into n8n.

Flow: Paste URL → Download & Extract → Create Request Folder → Load Skills → Brain → Plan Sanity Check → Build Primitive Geometry → Geometry Validator → Payload Prep → Execute Feature Transfer → Save Output

## Architecture

- **Brain** (Gemini 3.1 pro): Decides operation, primitive type, features, blend. Never pixel coordinates.
- **Face Landmarks** (tfjs-node + MediaPipe FaceMesh): Computes exact polygon geometry from images.
- **Photopea** (Playwright + iframe postMessage): Executes deterministic pixel transfers with polygon-path selections.
- Each feature (left_eye, right_eye, etc.) is processed separately — not merged.
- Output: PNG (always) + PSD with layers (optional, for debugging).
