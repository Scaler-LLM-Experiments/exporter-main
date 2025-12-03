# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Figma plugin called "exporter" that exports frames and their layers as individual images (PNG or SVG) with comprehensive metadata. The plugin decomposes frames into layers, exports each layer separately, and provides both the individual layer files and a reconstructed composite image.

## Build and Development Commands

- **Build plugin**: `npm run build` - Compiles `code.ts` to `code.js` for the Figma plugin
- **Build reconstruction tool**: `npm run build:reconstruct` - Compiles `reconstruct.ts` to `reconstruct.js`
- **Watch mode**: `npm run watch` - Automatically recompiles plugin on file changes
- **Reconstruct image**: `npm run reconstruct <folder-path>` - Rebuilds composite image from exported layers
- **Lint**: `npm run lint` - Check code with ESLint
- **Fix lint issues**: `npm run lint:fix` - Auto-fix ESLint issues
- **Start AI server**: `npm run server` - Starts the backend server for AI layer renaming (requires `npm run server:install` first)
- **Install server deps**: `npm run server:install` - Installs dependencies for the AI server

Note: The compiled `code.js` is what Figma executes, not `code.ts` directly.

## Architecture

### Two-Context Model
Figma plugins run in two separate contexts that communicate via message passing:

1. **Main Plugin Context** (`code.ts`):
   - Has access to the Figma document API via the global `figma` object
   - Handles layer collection, metadata extraction, and image export
   - Cannot access browser APIs
   - Compiled to `code.js` (specified in `manifest.json`)

2. **UI Context** (`ui.html`):
   - Full browser environment with standard web APIs
   - Displays plugin interface with frame selection indicator and export button
   - Currently hardcoded to export PNG at 4x resolution
   - Uses JSZip library (loaded from CDN) to create downloadable ZIP files
   - Reconstructs composite images client-side using Canvas API (PNG) or SVG composition (SVG)
   - Communicates with main context via `parent.postMessage()`

### Message Passing Pattern
- UI sends messages: `parent.postMessage({ pluginMessage: { type: 'action-name', ...data } }, '*')`
- Main receives messages: `figma.ui.onmessage = (msg) => { ... }`
- Main shows UI: `figma.showUI(__html__)`
- Main sends progress updates: `figma.ui.postMessage({ type: 'progress', message: '...' })`
- Main sends export data: `figma.ui.postMessage({ type: 'export-data', ... })`

### Layer Collection Strategy

The plugin uses a smart layer collection algorithm in `code.ts`:

- **Leaf nodes** are exported as single flattened images (TEXT, RECTANGLE, INSTANCE, VECTOR, etc.)
- **Containers with visual effects** (frames/groups with fills, strokes, effects, blend modes, or opacity < 1) are exported as single flattened images
- **Plain containers** (frames/groups without visual effects) are recursively descended into to collect child layers
- The frame itself is exported as layer 0 (base layer) by creating a temporary rectangle with the frame's visual properties

This approach ensures visual effects like shadows and blurs are properly captured while still decomposing the design into meaningful layers.

### Metadata Extraction

The plugin extracts comprehensive metadata for each layer (`code.ts:455-500`):
- Position (x, y), dimensions (width, height), and z-index
- **Export bounds** (`exportX`, `exportY`, `exportWidth`, `exportHeight`) - the actual rendered bounds including effects and strokes, used for accurate reconstruction
- **Node bounds** (`x`, `y`, `width`, `height`) - the logical bounds of the node
- Text content and properties (alignment, font family, font size, line height)
- Visual properties (fills, strokes, effects, corner radius, opacity, blend mode, rotation)
- Layout constraints (horizontal/vertical)

### Image Reconstruction

The plugin provides two reconstruction methods:

1. **Client-side (in `ui.html:238-415`)**:
   - Used for immediate download after export
   - Creates composite image in browser using Canvas API (PNG) or SVG composition (SVG)
   - Uses `exportX/exportY` coordinates when available for accurate positioning
   - Handles layer clipping when layers extend outside frame bounds
   - All coordinates are scaled by the selected resolution factor

2. **Server-side (in `reconstruct.ts`)**:
   - Standalone Node.js script using Sharp library
   - Reads exported `meta.json` and layer images from disk
   - Rebuilds composite image with proper layer ordering and positioning
   - Useful for batch processing or automation

Both reconstruction methods use the same algorithm: sort layers by z-index, apply scale factor to all coordinates, and composite layers in order using export bounds for positioning.

### AI Layer Renaming (Backend Server)

The plugin includes an optional AI-powered layer renaming feature that uses Google's Gemini Vision API:

1. **Backend Server** (`server/index.ts`):
   - Express server running on `localhost:3000`
   - Receives layer images from the plugin UI
   - Sends images to Gemini Vision API for analysis
   - Returns AI-generated concise names (3-5 words, snake_case format)
   - Requires `GEMINI_API_KEY` environment variable (copy `server/.env.example` to `server/.env`)

2. **Flow**:
   - User clicks "AI Rename + Export (6 frames)" button
   - Plugin exports each layer as 1x PNG
   - UI sends images to backend server
   - Backend calls Gemini Vision for each layer
   - Plugin receives AI names and renames layers in Figma document
   - Plugin creates 5 duplicate frames (with `_1` to `_5` suffixes)
   - All 6 frames are exported with AI-generated layer names in metadata

3. **Network Access**:
   - `devAllowedDomains` in `manifest.json` allows `localhost:3000` during development
   - Plugin UI makes HTTP requests to the backend (plugin main context cannot make network calls)

### Key Configuration Files

- **manifest.json**: Figma plugin configuration
  - `main`: Entry point (`code.js`)
  - `ui`: HTML file for the interface (`ui.html`)
  - `documentAccess`: Set to "dynamic-page" (can access current page on demand)
  - `networkAccess.allowedDomains`: Allows CDN access for JSZip library (`https://cdnjs.cloudflare.com`)
  - `editorType`: Only runs in Figma (not FigJam)

- **tsconfig.json**: Plugin TypeScript config
  - Targets ES6 with strict mode
  - Only includes `code.ts`
  - Type roots set to `./node_modules/@figma` for Figma API types

- **tsconfig.reconstruct.json**: Reconstruction script TypeScript config
  - Targets ES2020 with CommonJS modules
  - Only includes `reconstruct.ts`
  - Uses Node.js module resolution

- **package.json**: Contains ESLint configuration with Figma-specific rules from `@figma/eslint-plugin-figma-plugins`

## Development Notes

- TypeScript must be compiled (`npm run build`) before testing the plugin in Figma
- The plugin has two export modes:
  - **Export Only**: Exports selected frame as PNG at 4x resolution
  - **AI Rename + Export**: Renames layers using AI, duplicates frame 5 times, exports all 6 frames
- ESLint is configured to ignore unused variables that start with underscore
- The reconstruction script (`reconstruct.ts`) requires the `sharp` npm package for image processing
- For AI renaming: start the backend server (`npm run server`) and ensure `GEMINI_API_KEY` is set in `server/.env`
