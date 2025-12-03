import express, { Request, Response } from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS config for Figma plugin (null origin from iframe)
app.use(cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '100mb' }));

// Initialize Gemini
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

interface LayerInput {
  id: string;
  imageBase64: string;
  currentName: string;
  type: string;
}

interface RenameRequest {
  layers: LayerInput[];
}

interface RenameResponse {
  layers: Array<{
    id: string;
    newName: string;
  }>;
}

// ============================================
// Generate Edits Types
// ============================================

interface LayerMetadata {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fills?: Array<{ type: string; color?: string; opacity?: number }>;
  strokes?: Array<{ type: string; color?: string; opacity?: number }>;
  opacity?: number;
  text?: string;
  fontSize?: number;
  cornerRadius?: number | { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number };
}

interface GenerateEditsRequest {
  frameName: string;
  frameWidth: number;
  frameHeight: number;
  layers: LayerMetadata[];
}

interface EditInstruction {
  action: string;
  target: string;
  x?: number;
  y?: number;
  relative?: boolean;
  color?: string;
  opacity?: number;
  weight?: number;
  content?: string;
  width?: number;
  height?: number;
  scale?: number;
  position?: 'front' | 'back' | number;
}

interface EditVariant {
  variantIndex: number;
  humanPrompt: string;
  theme: string;
  instructions: EditInstruction[];
}

// Load system prompt from file
// Use EDIT_PROMPT_FILE env var to specify a custom prompt file, or defaults to 'default.txt'
const promptFileName = process.env.EDIT_PROMPT_FILE || 'default.txt';
const promptFilePath = path.join(__dirname, 'prompts', promptFileName);

let EDIT_GENERATION_PROMPT: string;
try {
  // Try loading from the prompts directory relative to this file
  EDIT_GENERATION_PROMPT = fs.readFileSync(promptFilePath, 'utf-8');
  console.log(`Loaded edit prompt from: ${promptFilePath}`);
} catch {
  // Fallback: try loading from source location (for ts-node dev mode)
  const devPromptPath = path.join(__dirname, '..', 'prompts', promptFileName);
  try {
    EDIT_GENERATION_PROMPT = fs.readFileSync(devPromptPath, 'utf-8');
    console.log(`Loaded edit prompt from: ${devPromptPath}`);
  } catch {
    console.error(`Failed to load prompt file: ${promptFileName}`);
    console.error(`Looked in: ${promptFilePath} and ${devPromptPath}`);
    process.exit(1);
  }
}

// Build the user prompt with layer metadata
function buildEditPrompt(
  frameName: string,
  frameWidth: number,
  frameHeight: number,
  layers: LayerMetadata[]
): string {
  // Create a simplified view of layers for the prompt
  const layerSummary = layers.map(l => ({
    name: l.name,
    type: l.type,
    position: { x: Math.round(l.x), y: Math.round(l.y) },
    size: { width: Math.round(l.width), height: Math.round(l.height) },
    fills: l.fills?.filter(f => f.type === 'SOLID').map(f => f.color),
    opacity: l.opacity,
    text: l.text
  }));

  return `Generate 5 design variations for this Figma frame.

## Frame Information
Name: ${frameName}
Dimensions: ${frameWidth} x ${frameHeight} pixels

## Available Layers (${layers.length} total)
${JSON.stringify(layerSummary, null, 2)}

Remember: Target layers by their EXACT name from the list above. Return ONLY valid JSON.`;
}

// Parse and validate the AI response
function parseAndValidateVariants(responseText: string, layers: LayerMetadata[]): EditVariant[] {
  // Clean up potential markdown formatting
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(cleaned);

  if (!parsed.variants || !Array.isArray(parsed.variants)) {
    throw new Error('Invalid response: missing variants array');
  }

  // Get all valid layer names for validation
  const layerNames = new Set(layers.map(l => l.name));

  // Validate each variant
  for (const variant of parsed.variants) {
    if (!variant.instructions || !Array.isArray(variant.instructions)) {
      variant.instructions = [];
      continue;
    }

    // Filter out instructions targeting non-existent layers
    variant.instructions = variant.instructions.filter((inst: EditInstruction) => {
      if (!inst.target || !layerNames.has(inst.target)) {
        console.warn(`  Skipping instruction for unknown layer: "${inst.target}"`);
        return false;
      }
      if (!inst.action) {
        console.warn(`  Skipping instruction with missing action`);
        return false;
      }
      return true;
    });
  }

  return parsed.variants;
}

// Generate layer name using Gemini Vision
async function generateLayerName(
  imageBase64: string,
  currentName: string,
  layerType: string
): Promise<string> {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite-preview-09-2025' });

  const prompt = `You are a UI layer naming assistant. Look at this UI element image and provide a concise, descriptive name.

Rules:
- Use 3-5 words maximum
- Use snake_case format (e.g., blue_submit_button, main_header_text)
- Be specific about the element type and purpose
- Include color only if visually distinctive
- Include state if apparent (hover, active, disabled)

Current name: "${currentName}"
Element type: ${layerType}

Respond with ONLY the new name, nothing else. No quotes, no explanation.`;

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/png',
          data: imageBase64
        }
      }
    ]);

    const response = result.response;
    const text = response.text().trim();

    // Clean up the response - remove quotes, extra whitespace, etc.
    const cleanedName = text
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .replace(/[^a-zA-Z0-9_]/g, '') // Remove special characters
      .toLowerCase();

    return cleanedName || currentName;
  } catch (error) {
    console.error(`Error generating name for layer "${currentName}":`, error);
    return currentName; // Fall back to original name on error
  }
}

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'exporter-server' });
});

// Main endpoint for renaming layers
app.post('/api/rename-layers', async (req: Request, res: Response) => {
  try {
    const { layers }: RenameRequest = req.body;

    if (!layers || !Array.isArray(layers)) {
      res.status(400).json({ error: 'Invalid request: layers array required' });
      return;
    }

    console.log(`Processing ${layers.length} layers for AI renaming...`);

    const results: RenameResponse['layers'] = [];

    // Process layers sequentially to avoid rate limiting
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      console.log(`  [${i + 1}/${layers.length}] Processing: ${layer.currentName} (${layer.type})`);

      const newName = await generateLayerName(
        layer.imageBase64,
        layer.currentName,
        layer.type
      );

      results.push({
        id: layer.id,
        newName
      });

      console.log(`    -> ${newName}`);

      // Small delay between requests to avoid rate limiting
      if (i < layers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`Completed renaming ${results.length} layers`);
    console.log('Sending response:', JSON.stringify({ layers: results }, null, 2));

    res.json({ layers: results });
  } catch (error) {
    console.error('Error in /api/rename-layers:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: (error as Error).message
    });
  }
});

// ============================================
// Generate Edits Endpoint
// ============================================
app.post('/api/generate-edits', async (req: Request, res: Response) => {
  try {
    const { frameName, frameWidth, frameHeight, layers }: GenerateEditsRequest = req.body;

    if (!layers || !Array.isArray(layers) || layers.length === 0) {
      res.status(400).json({ error: 'Invalid request: layers array required' });
      return;
    }

    console.log(`\n========================================`);
    console.log(`Generating edits for frame "${frameName}"`);
    console.log(`Frame size: ${frameWidth} x ${frameHeight}`);
    console.log(`Layers: ${layers.length}`);
    console.log(`========================================\n`);

    // Build the prompt
    const userPrompt = buildEditPrompt(frameName, frameWidth, frameHeight, layers);

    // Call Gemini
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent([EDIT_GENERATION_PROMPT, userPrompt]);
    const responseText = result.response.text();

    console.log('Raw Gemini response (first 1000 chars):');
    console.log(responseText.substring(0, 1000));
    console.log('...\n');

    // Parse and validate
    const variants = parseAndValidateVariants(responseText, layers);

    console.log(`Generated ${variants.length} variants:`);
    variants.forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.theme}: ${v.instructions.length} instructions`);
      console.log(`     "${v.humanPrompt}"`);
    });

    res.json({ variants });
  } catch (error) {
    console.error('Error in /api/generate-edits:', error);
    res.status(500).json({
      error: 'Failed to generate edits',
      message: (error as Error).message
    });
  }
});

app.listen(PORT, () => {
  console.log(`
========================================
  Figma Exporter AI Server
  Running on http://localhost:${PORT}
========================================

Endpoints:
  GET  /health              - Health check
  POST /api/rename-layers   - Rename layers using AI
  POST /api/generate-edits  - Generate 5 design variations

Config:
  Edit prompt file: ${promptFileName}
  (Set EDIT_PROMPT_FILE env var to use a different prompt)

Ready to receive requests from Figma plugin.
`);
});
