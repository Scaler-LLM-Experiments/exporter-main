# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Figma plugin called "exporter" that exports frames and their layers as individual images (PNG or SVG) with comprehensive metadata. The plugin decomposes frames into layers, exports each layer separately, and provides both the individual layer files and a reconstructed composite image. It includes an optional AI-powered backend for layer renaming, design variation generation, and S3 upload capabilities.

## Build and Development Commands

- **Build plugin**: `npm run build` - Compiles `code.ts` to `code.js` for the Figma plugin
- **Build reconstruction tool**: `npm run build:reconstruct` - Compiles `reconstruct.ts` to `reconstruct.js`
- **Watch mode**: `npm run watch` - Automatically recompiles plugin on file changes
- **Reconstruct image**: `npm run reconstruct <folder-path>` - Rebuilds composite image from exported layers
- **Lint**: `npm run lint` - Check code with ESLint
- **Fix lint issues**: `npm run lint:fix` - Auto-fix ESLint issues
- **Start AI server**: `npm run server` - Starts the backend server for AI features (requires `npm run server:install` first)
- **Install server deps**: `npm run server:install` - Installs dependencies for the AI server
- **Production server**: `npm run server:start` - Starts server without auto-reload (uses ts-node)

Note: The compiled `code.js` is what Figma executes, not `code.ts` directly.

## Architecture

### Two-Context Model
Figma plugins run in two separate contexts that communicate via message passing:

1. **Main Plugin Context** (`code.ts`):
   - Has access to the Figma document API via the global `figma` object
   - Handles layer collection, metadata extraction, and image export
   - Cannot access browser APIs or make network requests
   - Compiled to `code.js` (specified in `manifest.json`)

2. **UI Context** (`ui.html`):
   - Full browser environment with standard web APIs
   - Displays plugin interface with frame selection indicator, export settings, and action buttons
   - Uses JSZip library (loaded from CDN) to create downloadable ZIP files
   - Reconstructs composite images client-side using Canvas API (PNG) or SVG composition (SVG)
   - Communicates with main context via `parent.postMessage()`
   - Handles all HTTP requests to the AI backend server (main context cannot make network calls)

### Message Passing Pattern

**UI → Main** (via `parent.postMessage`):
- `export-frame` - Export selected frames with layers
- `break-groups` - Flatten groups in selection
- `rasterize-selection` - Convert selection to raster images
- `export-for-renaming` - Export layers for AI renaming
- `apply-renames` - Apply AI-generated names to layers
- `duplicate-and-export` - Create duplicates and export
- `prepare-for-edits` - Prepare frame metadata for AI variations
- `apply-edit-variants` - Apply AI-generated design variations
- `cancel` - Close plugin

**Main → UI** (via `figma.ui.postMessage`):
- `selection-change` - Update UI when selection changes
- `progress` - Show progress messages during operations
- `export-data` - Send exported layer data and metadata
- `layers-for-renaming` - Send layer images for AI analysis
- `groups-broken` - Report results of group flattening
- `rasterized` - Report results of rasterization
- Various error and success messages for each operation

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

### AI Backend Server

The plugin includes an optional AI-powered backend (`server/index.ts`) that provides AI features, S3 uploads, and job tracking:

#### Backend Server Configuration

- Express server running on `localhost:3000` (configurable via `PORT` env var)
- Supports two AI providers: Google Gemini (direct) or OpenRouter (with multiple model options)
- Provider selected via `AI_PROVIDER` env var (defaults to `gemini`)
- Requires API keys in `server/.env` (copy from `server/.env.example`)
- System prompts externalized to `server/prompts/` directory for easy experimentation
- Request body limit: 4GB to support large frame exports
- Request timeout: 10 minutes for heavy operations
- Includes memory monitoring middleware to track heap usage

#### AI Features

**1. AI Layer Renaming** (`POST /api/rename-layers`):
- **Flow**: UI exports layers as 1x PNG → sends to backend → backend calls AI vision model → returns snake_case names
- Uses fast vision model (`gemini-2.5-flash-lite-preview` or configurable via `OPENROUTER_MODEL_FAST`)
- Generates concise 3-5 word names from layer images
- **Batch processing**: Processes up to 10 layers per API call for efficiency (previously 1 layer per call)
- Plugin receives names and renames layers in Figma document
- 100ms delays between batches to avoid rate limiting
- Used in "AI Rename Layers" button workflow

**2. AI Design Variations** (`POST /api/generate-edits`):
- **Flow**: UI sends frame metadata → backend calls reasoning model → returns 5 variant instructions → plugin applies edits
- Uses pro reasoning model (`gemini-2.0-flash` or configurable via `OPENROUTER_MODEL_PRO`)
- Generates 5 creative design variations with JSON edit instructions (move, changeFill, changeText, resize, etc.)
- Each variant includes human-readable prompt and executable instructions
- Optionally generates AI images for layers with `hasImageFill: true` (requires `OPENROUTER_MODEL_IMAGE`)
- System prompt customizable via `EDIT_PROMPT_FILE` env var (see `server/prompts/` for options)
- Used in "Generate Edits (5 variants)" button workflow

#### S3 Upload and Database Tracking

**3. S3 Automatic Uploads** (`POST /api/upload-to-s3`):
- Uploads exported frame ZIPs directly to AWS S3
- Requires AWS credentials in `server/.env` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`)
- Optional `S3_FOLDER_PREFIX` for organizing uploads into folders
- Supports up to 4GB file uploads (matching the request body limit)
- Returns S3 URL upon successful upload
- Tracks all upload jobs in PostgreSQL database

**4. Database Job Tracking** (`server/lib/db.ts`):
- Optional PostgreSQL integration for tracking all backend operations
- Requires `DATABASE_URL` in `server/.env` (standard PostgreSQL connection string)
- Tracks: job ID, frame name, user email, IP address, variant count, file size, duration, status
- Gracefully degrades if database is not configured
- Connection pool with 20 max connections, 30s idle timeout

**5. Rate Limiting** (`server/lib/rateLimiter.ts`):
- General API rate limiting: Applied to all `/api/` routes
- Heavy operation limiting: Applied to `generate-edits` and `upload-to-s3`
- Rename-specific limiting: Applied to `rename-layers` endpoint

**6. Concurrency Control** (`server/lib/concurrency.ts`):
- `renameLimiter`: Limits parallel rename operations
- `imageLimiter`: Limits parallel image generation
- `processWithConcurrency`: Helper for processing items with controlled parallelism

#### Network Access

- Production: `allowedDomains` in `manifest.json` includes `https://asli-designer-production.up.railway.app`
- Development: `devAllowedDomains` allows `localhost:3000`
- Plugin UI makes all HTTP requests (main context cannot access network)

#### Deployment

The server is configured for Railway deployment (`server/railway.json`):
- Supports PostgreSQL database provisioning
- Environment variables managed via Railway dashboard
- Uses Railway's DATABASE_URL for automatic database connection

### Key Configuration Files

- **manifest.json**: Figma plugin configuration
  - `main`: Entry point (`code.js`)
  - `ui`: HTML file for the interface (`ui.html`)
  - `documentAccess`: Set to "dynamic-page" (can access current page on demand)
  - `networkAccess.allowedDomains`: Allows CDN access for JSZip, Google Fonts (Manrope), and production Railway server
  - `networkAccess.devAllowedDomains`: Allows `localhost:3000` for AI backend during development
  - `editorType`: Only runs in Figma (not FigJam)

- **tsconfig.json**: Plugin TypeScript config
  - Targets ES6 with strict mode
  - Only includes `code.ts`
  - Type roots set to `./node_modules/@figma` for Figma API types

- **tsconfig.reconstruct.json**: Reconstruction script TypeScript config
  - Targets ES2020 with CommonJS modules
  - Only includes `reconstruct.ts`
  - Uses Node.js module resolution

- **server/tsconfig.json**: Backend server TypeScript config
  - Separate configuration for server code
  - Supports ES modules and Node.js types

- **package.json**: Contains ESLint configuration with Figma-specific rules from `@figma/eslint-plugin-figma-plugins`

## Plugin Features

The plugin provides six main operations accessible via UI buttons:

1. **Export Frame** (`export-frame`):
   - Exports selected frame(s) with configurable format (PNG/SVG) and scale factor (1x-4x)
   - Decomposes frame into layers, exports each separately with metadata
   - Creates ZIP file with layers, metadata JSON, and reconstructed composite image

2. **Break Groups Apart** (`break-groups`):
   - Recursively flattens all groups in selection
   - Preserves layer positioning and properties
   - Updates selection to show ungrouped layers

3. **Rasterize Selection** (`rasterize-selection`):
   - Converts selected objects to 4x resolution raster images
   - Replaces original vector/text layers with PNG images
   - Useful for optimizing complex effects or preparing for export

4. **AI Rename Layers** (`export-for-renaming` → `apply-renames` → `duplicate-and-export`):
   - Exports layers as 1x PNG images
   - Sends to backend for AI vision analysis
   - Renames layers in Figma with AI-generated snake_case names
   - Duplicates frame 5 times (creates `_1` through `_5` variants)
   - Exports all 6 frames with updated metadata

5. **Generate Edits (5 variants)** (`prepare-for-edits` → `apply-edit-variants`):
   - Sends frame metadata to backend for AI reasoning
   - Backend returns 5 creative design variations with JSON instructions
   - Plugin applies instructions to create 5 duplicate frames with variations
   - Each frame shows AI prompt card and detailed change summary
   - Frames are vertically stacked with spacing for easy review
   - Optional: Generate AI images for layers marked with `hasImageFill: true`

6. **Health Check**: Backend provides `GET /health` endpoint for status monitoring

## Development Notes

- TypeScript must be compiled (`npm run build`) before testing the plugin in Figma
- Watch mode (`npm run watch`) auto-recompiles on file changes during development
- ESLint is configured to ignore unused variables that start with underscore
- The reconstruction script (`reconstruct.ts`) requires the `sharp` npm package for image processing
- For AI features: start backend server (`npm run server`) and configure `server/.env` with API keys
- AI provider selection: set `AI_PROVIDER=gemini` or `AI_PROVIDER=openrouter` in `server/.env`
- Custom prompts: create new files in `server/prompts/` and set `EDIT_PROMPT_FILE` to test different system prompts
- S3 uploads: configure AWS credentials and bucket name in `server/.env`
- Database tracking: set `DATABASE_URL` in `server/.env` for PostgreSQL connection
- Production deployment: uses Railway with automatic PostgreSQL provisioning
