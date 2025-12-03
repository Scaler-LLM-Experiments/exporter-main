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

Create a `.env` file with:
```
GEMINI_API_KEY=your_api_key_here
PORT=3000  # optional, defaults to 3000
```

## Architecture

### Single-File Server (`index.ts`)

Express server with two endpoints:
- `GET /health` - Health check returning `{ status: 'ok', service: 'exporter-server' }`
- `POST /api/rename-layers` - Main endpoint for AI layer renaming

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

### Gemini Integration

- Uses `gemini-2.5-flash-lite-preview-09-2025` model for vision analysis
- Prompt instructs model to return 3-5 word snake_case names
- Response is cleaned: quotes removed, spaces converted to underscores, special characters stripped
- Falls back to original name on API errors

### Request Handling

- Layers are processed sequentially with 100ms delay between requests to avoid rate limiting
- Request body limit is 100mb to accommodate multiple layer images
- CORS is configured to accept requests from any origin (required for Figma plugin iframe)
