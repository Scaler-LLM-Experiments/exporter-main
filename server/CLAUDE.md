# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the backend server for the Figma exporter plugin's AI-powered layer renaming feature. It uses Google's Gemini Vision API to analyze layer images and generate descriptive names.

## Commands

- **Development mode**: `npm run dev` - Starts server with auto-reload on file changes (ts-node-dev)
- **Production start**: `npm start` - Runs the server directly with ts-node
- **Build**: `npm run build` - Compiles TypeScript to `dist/` directory

From the parent directory:
- `npm run server` - Starts this server
- `npm run server:install` - Installs dependencies for this server

## Configuration

Copy `.env.example` to `.env` and configure:
```
GEMINI_API_KEY=your_api_key_here
PORT=3000                        # optional, defaults to 3000
EDIT_PROMPT_FILE=default.txt     # optional, prompt file from prompts/ directory
```

### Custom Prompts

The system prompt for edit generation is externalized to `prompts/default.txt`. To test different prompts:
1. Create a new file in `prompts/` (e.g., `prompts/experimental.txt`)
2. Set `EDIT_PROMPT_FILE=experimental.txt` in your `.env`
3. Restart the server

## Architecture

### Single-File Server (`index.ts`)

Express server with three endpoints:
- `GET /health` - Health check returning `{ status: 'ok', service: 'exporter-server' }`
- `POST /api/rename-layers` - AI layer renaming using Gemini Vision
- `POST /api/generate-edits` - Generate 5 design variations with JSON edit instructions

### API Contract

**Request** (`POST /api/rename-layers`):
```typescript
{
  layers: Array<{
    id: string;           // Figma node ID
    imageBase64: string;  // PNG image data (no data: prefix)
    currentName: string;  // Current layer name
    type: string;         // Figma node type (TEXT, RECTANGLE, etc.)
  }>
}
```

**Response**:
```typescript
{
  layers: Array<{
    id: string;      // Same Figma node ID
    newName: string; // AI-generated snake_case name
  }>
}
```

**Request** (`POST /api/generate-edits`):
```typescript
{
  frameName: string;      // Name of the frame
  frameWidth: number;     // Frame width in pixels
  frameHeight: number;    // Frame height in pixels
  layers: Array<{
    name: string;         // Layer name (used for targeting)
    type: string;         // Layer type (TEXT, RECTANGLE, etc.)
    x: number; y: number; // Position
    width: number; height: number;
    fills?: Array<{ type: string; color?: string; opacity?: number }>;
    text?: string;        // For TEXT layers
  }>
}
```

**Response**:
```typescript
{
  variants: Array<{
    variantIndex: number;
    humanPrompt: string;  // Description of changes
    theme: string;        // Theme name (e.g., "Dark Mode")
    instructions: Array<{
      action: 'move' | 'changeFill' | 'changeStroke' | 'changeText' | 'resize' | 'changeOpacity' | 'reorder';
      target: string;     // Layer name to modify
      // Action-specific properties...
    }>
  }>
}
```

### Gemini Integration

**Layer Renaming** (`/api/rename-layers`):
- Uses `gemini-2.5-flash-lite-preview-09-2025` model for vision analysis
- Prompt instructs model to return 3-5 word snake_case names
- Response is cleaned: quotes removed, spaces converted to underscores, special characters stripped
- Falls back to original name on API errors

**Edit Generation** (`/api/generate-edits`):
- Uses `gemini-2.0-flash` model for generating variations
- System prompt loaded from `prompts/` directory (configurable via `EDIT_PROMPT_FILE`)
- Returns 5 creative design variations with executable JSON instructions
- Instructions are validated against provided layer names

### Request Handling

- Layers are processed sequentially with 100ms delay between requests to avoid rate limiting
- Request body limit is 100mb to accommodate multiple layer images
- CORS is configured to accept requests from any origin (required for Figma plugin iframe)
