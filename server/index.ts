import express, { Request, Response } from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

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

app.listen(PORT, () => {
  console.log(`
========================================
  Layer Renaming Server
  Running on http://localhost:${PORT}
========================================

Endpoints:
  GET  /health              - Health check
  POST /api/rename-layers   - Rename layers using AI

Ready to receive requests from Figma plugin.
`);
});
