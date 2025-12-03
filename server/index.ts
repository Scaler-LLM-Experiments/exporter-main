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

// ============================================
// Provider Configuration
// ============================================

type AIProvider = 'gemini' | 'openrouter';
const AI_PROVIDER: AIProvider = (process.env.AI_PROVIDER as AIProvider) || 'gemini';

// Validate required API key based on provider
if (AI_PROVIDER === 'gemini' && !process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is required when AI_PROVIDER=gemini');
  process.exit(1);
}
if (AI_PROVIDER === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter');
  process.exit(1);
}

console.log(`AI Provider: ${AI_PROVIDER.toUpperCase()}`);

// Initialize Gemini (only used when AI_PROVIDER=gemini)
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// ============================================
// OpenRouter Client (only used when AI_PROVIDER=openrouter)
// ============================================

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Model mappings for OpenRouter (configurable via env vars)
const OPENROUTER_MODELS = {
  FAST: process.env.OPENROUTER_MODEL_FAST || 'google/gemini-2.5-flash',           // For rename-layers
  PRO: process.env.OPENROUTER_MODEL_PRO || 'google/gemini-3-pro-preview',         // For generate-edits
  IMAGE: process.env.OPENROUTER_MODEL_IMAGE || 'google/gemini-2.5-flash-image-preview' // For image generation
};

interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  include_reasoning?: boolean;
}

interface OpenRouterImageData {
  type: string;
  image_url: {
    url: string;
  };
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
      images?: OpenRouterImageData[];  // For image generation responses
    };
    delta?: {
      content?: string;
      reasoning?: string;
    };
  }>;
}

async function callOpenRouter(request: OpenRouterRequest): Promise<globalThis.Response> {
  return fetch(OPENROUTER_BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://figma-exporter-plugin.local',
      'X-Title': 'Figma Exporter AI'
    },
    body: JSON.stringify(request)
  });
}

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
  hasImageFill?: boolean;  // True if layer contains an image fill
}

interface GenerateEditsRequest {
  frameName: string;
  frameWidth: number;
  frameHeight: number;
  frameImageBase64?: string;  // Frame image for AI vision analysis
  layers: LayerMetadata[];
  generateImages?: boolean;   // Whether to generate AI images for image layers
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
  // Image generation properties
  imagePrompt?: string;           // Prompt for AI image generation
  generatedImageBase64?: string;  // Base64 of generated image (populated by server)
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
  // Create a detailed view of layers for the prompt
  const layerSummary = layers.map(l => {
    const summary: Record<string, unknown> = {
      name: l.name,
      type: l.type,
      position: { x: Math.round(l.x), y: Math.round(l.y) },
      size: { width: Math.round(l.width), height: Math.round(l.height) }
    };

    // Include fill colors explicitly
    const solidFills = l.fills?.filter(f => f.type === 'SOLID').map(f => f.color);
    if (solidFills && solidFills.length > 0) {
      summary.currentColor = solidFills[0]; // Primary fill color
      if (solidFills.length > 1) {
        summary.additionalColors = solidFills.slice(1);
      }
    }

    // Include text content
    if (l.text) {
      summary.text = l.text;
    }

    // Include opacity if not 1
    if (l.opacity !== undefined && l.opacity !== 1) {
      summary.opacity = l.opacity;
    }

    return summary;
  });

  // Separate colored layers for emphasis
  const coloredLayers = layerSummary.filter(l => l.currentColor);
  const textLayers = layerSummary.filter(l => l.text);

  return `Generate 5 design variations for this Figma frame.

## Frame Information
Name: ${frameName}
Dimensions: ${frameWidth} x ${frameHeight} pixels

## COLORED LAYERS (${coloredLayers.length} layers with fills - CHANGE THESE for color variations!)
${JSON.stringify(coloredLayers, null, 2)}

## TEXT LAYERS (${textLayers.length} layers with text content)
${JSON.stringify(textLayers, null, 2)}

## ALL LAYERS (${layers.length} total)
${JSON.stringify(layerSummary, null, 2)}

IMPORTANT: For color scheme changes, you MUST modify ALL layers listed in "COLORED LAYERS" above.
Target layers by their EXACT name. Return ONLY valid JSON.`;
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

// Generate an image using AI (OpenRouter only for now)
async function generateImageFromPrompt(
  imagePrompt: string,
  contextDescription: string
): Promise<string | null> {
  if (AI_PROVIDER !== 'openrouter') {
    console.log('  Image generation only supported with OpenRouter provider');
    return null;
  }

  try {
    console.log(`  Generating image: "${imagePrompt.substring(0, 50)}..."`);

    // Build the request with modalities for image generation
    const requestBody = {
      model: OPENROUTER_MODELS.IMAGE,
      messages: [{
        role: 'user',
        content: `${imagePrompt}

Context: ${contextDescription}

Generate a high-quality, professional image that fits the described context and aesthetic.`
      }],
      modalities: ['image', 'text'],
      temperature: 0.8,
      max_tokens: 4096
    };

    const response = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://figma-exporter-plugin.local',
        'X-Title': 'Figma Exporter AI'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`  Image generation failed: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json() as OpenRouterResponse;

    // Check for images array in the response (OpenRouter image generation format)
    const images = data.choices?.[0]?.message?.images;
    if (images && images.length > 0) {
      const imageUrl = images[0].image_url?.url;
      if (imageUrl && imageUrl.startsWith('data:image')) {
        // Extract base64 from data URL
        const base64Match = imageUrl.match(/base64,(.+)/);
        if (base64Match) {
          console.log('  Image generated successfully');
          return base64Match[1];
        }
      }
    }

    // Fallback: Check content for image data (alternative format)
    const content = data.choices?.[0]?.message?.content;
    if (content && typeof content === 'string' && content.startsWith('data:image')) {
      const base64Match = content.match(/base64,(.+)/);
      if (base64Match) {
        console.log('  Image generated successfully (from content)');
        return base64Match[1];
      }
    }

    // Log the response structure for debugging
    console.log('  Response structure:', JSON.stringify({
      hasChoices: !!data.choices,
      hasMessage: !!data.choices?.[0]?.message,
      hasImages: !!data.choices?.[0]?.message?.images,
      imagesLength: data.choices?.[0]?.message?.images?.length,
      contentType: typeof content,
      contentPreview: typeof content === 'string' ? content.substring(0, 100) : 'non-string'
    }));

    console.log('  No image data found in response');
    return null;
  } catch (error) {
    console.error('  Error generating image:', error);
    return null;
  }
}

// Process image generation instructions in variants
async function processImageGenerations(
  variants: EditVariant[],
  contextDescription: string
): Promise<EditVariant[]> {
  for (const variant of variants) {
    for (const instruction of variant.instructions) {
      if (instruction.action === 'generateImage' && instruction.imagePrompt) {
        const generatedImage = await generateImageFromPrompt(
          instruction.imagePrompt,
          `${contextDescription} - Variant: ${variant.theme}`
        );
        if (generatedImage) {
          instruction.generatedImageBase64 = generatedImage;
        }
      }
    }
  }
  return variants;
}

// Generate layer name using AI (supports both Gemini and OpenRouter)
async function generateLayerName(
  imageBase64: string,
  currentName: string,
  layerType: string
): Promise<string> {
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
    let text: string;

    if (AI_PROVIDER === 'openrouter') {
      // OpenRouter path
      const response = await callOpenRouter({
        model: OPENROUTER_MODELS.FAST,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageBase64}` }
            }
          ]
        }],
        temperature: 0.3,
        max_tokens: 100
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as OpenRouterResponse;
      text = data.choices?.[0]?.message?.content?.trim() || currentName;
    } else {
      // Direct Gemini path
      if (!genAI) {
        throw new Error('Gemini client not initialized');
      }
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite-preview-09-2025' });
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: 'image/png',
            data: imageBase64
          }
        }
      ]);
      text = result.response.text().trim();
    }

    // Clean up the response - same for both providers
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
    const { frameName, frameWidth, frameHeight, frameImageBase64, layers, generateImages }: GenerateEditsRequest = req.body;

    if (!layers || !Array.isArray(layers) || layers.length === 0) {
      res.status(400).json({ error: 'Invalid request: layers array required' });
      return;
    }

    // Count image layers
    const imageLayers = layers.filter(l => l.hasImageFill);

    console.log(`\n========================================`);
    console.log(`Generating edits for frame "${frameName}"`);
    console.log(`Frame size: ${frameWidth} x ${frameHeight}`);
    console.log(`Layers: ${layers.length} (${imageLayers.length} with images)`);
    console.log(`Image included: ${frameImageBase64 ? `Yes (${Math.round(frameImageBase64.length / 1024)}KB)` : 'No'}`);
    console.log(`Generate AI Images: ${generateImages ? 'YES' : 'No'}`);
    console.log(`========================================\n`);

    // Load the appropriate prompt based on whether image generation is enabled
    let activePrompt = EDIT_GENERATION_PROMPT;
    if (generateImages && AI_PROVIDER === 'openrouter') {
      const imagePromptPath = path.join(__dirname, 'prompts', 'creative-director-with-images.txt');
      const devImagePromptPath = path.join(__dirname, '..', 'prompts', 'creative-director-with-images.txt');
      try {
        activePrompt = fs.readFileSync(imagePromptPath, 'utf-8');
        console.log('Using image-enabled prompt: creative-director-with-images.txt');
      } catch {
        try {
          activePrompt = fs.readFileSync(devImagePromptPath, 'utf-8');
          console.log('Using image-enabled prompt (dev): creative-director-with-images.txt');
        } catch {
          console.log('Image prompt not found, using default prompt');
        }
      }
    }

    // Build the prompt
    const userPrompt = buildEditPrompt(frameName, frameWidth, frameHeight, layers);

    let responseText = '';
    let thinkingText = '';

    if (AI_PROVIDER === 'openrouter') {
      // ============================================
      // OpenRouter Path (streaming with SSE)
      // ============================================
      console.log('Using OpenRouter with Gemini 3 Pro (streaming mode)...');
      console.log('\n💭 Model thinking...\n');
      console.log('─'.repeat(60));

      // Build messages array
      const messages: OpenRouterMessage[] = [];

      // System prompt
      messages.push({
        role: 'system',
        content: activePrompt
      });

      // User message with optional image
      const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

      if (frameImageBase64) {
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${frameImageBase64}` }
        });
      }

      userContent.push({ type: 'text', text: userPrompt });

      messages.push({
        role: 'user',
        content: userContent
      });

      // Make streaming request
      const response = await callOpenRouter({
        model: OPENROUTER_MODELS.PRO,
        messages,
        stream: true,
        temperature: 1.0,
        max_tokens: 8192,
        include_reasoning: true
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
      }

      // Process streaming response
      let isFirstThinking = true;
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.reasoning) {
                if (isFirstThinking) {
                  process.stdout.write('\x1b[36m');
                  isFirstThinking = false;
                }
                process.stdout.write(delta.reasoning);
                thinkingText += delta.reasoning;
              }

              if (delta?.content) {
                responseText += delta.content;
              }
            } catch {
              // Skip invalid JSON chunks
            }
          }
        }
      }

      process.stdout.write('\x1b[0m\n');

    } else {
      // ============================================
      // Direct Gemini Path (existing streaming code)
      // ============================================
      if (!genAI) {
        throw new Error('Gemini client not initialized');
      }

      console.log('Using Gemini 3 Pro with thinking (streaming mode)...');
      console.log('Thinking level: HIGH (maximum reasoning depth)');
      console.log('\n💭 Model thinking...\n');
      console.log('─'.repeat(60));

      const model = genAI.getGenerativeModel({
        model: 'gemini-3-pro-preview',
        generationConfig: {
          // @ts-expect-error - thinkingConfig is a new feature
          thinkingConfig: {
            thinkingLevel: 'high',
            includeThoughts: true
          }
        }
      });

      const contentParts = frameImageBase64
        ? [
            activePrompt,
            { inlineData: { mimeType: 'image/png', data: frameImageBase64 } },
            userPrompt
          ]
        : [activePrompt, userPrompt];

      const streamResult = await model.generateContentStream(contentParts);
      let isFirstThinking = true;

      for await (const chunk of streamResult.stream) {
        const candidates = chunk.candidates;
        if (!candidates || candidates.length === 0) continue;

        for (const part of candidates[0].content.parts) {
          // @ts-expect-error - thought property exists on thinking-enabled responses
          if (part.thought) {
            const thought = part.text || '';
            if (thought) {
              if (isFirstThinking) {
                process.stdout.write('\x1b[36m');
                isFirstThinking = false;
              }
              process.stdout.write(thought);
              thinkingText += thought;
            }
          } else if (part.text) {
            responseText += part.text;
          }
        }
      }

      process.stdout.write('\x1b[0m\n');
    }

    console.log('─'.repeat(60));
    console.log(`\n✅ Thinking complete (${thinkingText.length} chars)\n`);

    console.log('Raw response (first 1000 chars):');
    console.log(responseText.substring(0, 1000));
    console.log('...\n');

    // Parse and validate (same for both providers)
    let variants = parseAndValidateVariants(responseText, layers);

    // Process image generation if enabled
    if (generateImages && AI_PROVIDER === 'openrouter') {
      const imageInstructions = variants.flatMap(v =>
        v.instructions.filter(i => i.action === 'generateImage' && i.imagePrompt)
      );

      if (imageInstructions.length > 0) {
        console.log(`\n🖼️  Processing ${imageInstructions.length} image generation requests...\n`);
        variants = await processImageGenerations(variants, `${frameName} - ${frameWidth}x${frameHeight}`);

        // Count successful generations
        const successfulImages = variants.flatMap(v =>
          v.instructions.filter(i => i.action === 'generateImage' && i.generatedImageBase64)
        ).length;
        console.log(`✅ Generated ${successfulImages}/${imageInstructions.length} images\n`);
      }
    }

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
  const thinkingInfo = AI_PROVIDER === 'gemini'
    ? 'Thinking level: HIGH (maximum reasoning depth)'
    : 'Reasoning: enabled via include_reasoning';

  let modelsInfo: string;
  if (AI_PROVIDER === 'openrouter') {
    modelsInfo = `
  Fast (rename):    ${OPENROUTER_MODELS.FAST}
  Pro (generate):   ${OPENROUTER_MODELS.PRO}
  Image (generate): ${OPENROUTER_MODELS.IMAGE}`;
  } else {
    modelsInfo = `
  Fast (rename):    gemini-2.5-flash-lite
  Pro (generate):   gemini-3-pro-preview
  Image (generate): Not available (use OpenRouter)`;
  }

  console.log(`
========================================
  Figma Exporter AI Server
  Running on http://localhost:${PORT}
========================================

Provider: ${AI_PROVIDER.toUpperCase()}
Models:${modelsInfo}

Endpoints:
  GET  /health              - Health check
  POST /api/rename-layers   - Rename layers using AI
  POST /api/generate-edits  - Generate 5 design variations

Config:
  Edit prompt file: ${promptFileName}
  ${thinkingInfo}
  (Set AI_PROVIDER env var to switch: gemini | openrouter)

Ready to receive requests from Figma plugin.
`);
});
