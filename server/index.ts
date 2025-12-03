import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import timeout from 'connect-timeout';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { renameLimiter, imageLimiter, processWithConcurrency } from './lib/concurrency';
import { apiLimiter, heavyLimiter, renameRateLimiter } from './lib/rateLimiter';
import { query as dbQuery } from './lib/db';
import { aiCache } from './lib/cache';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS config for Figma plugin (null origin from iframe)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '4gb' }));
app.use(express.urlencoded({ limit: '4gb', extended: true }));

// ============================================
// Timeouts and Monitoring
// ============================================

// Request timeout: 10 minutes for heavy operations
app.use(timeout('600s'));

// Middleware to check if request has timed out
function haltOnTimedout(req: Request, res: Response, next: NextFunction) {
  if (!req.timedout) next();
}

app.use(haltOnTimedout);

// Memory monitoring middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const memUsage = process.memoryUsage();
  const memMB = {
    rss: Math.round(memUsage.rss / 1024 / 1024),
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024)
  };

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | Memory: ${memMB.heapUsed}/${memMB.heapTotal}MB heap, ${memMB.rss}MB RSS`);

  // Warn if memory usage is high
  if (memMB.heapUsed > 400) {
    console.warn(`⚠️  High memory usage: ${memMB.heapUsed}MB`);
  }

  next();
});

// Apply general API rate limiting to all routes
app.use('/api/', apiLimiter);

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
// AWS S3 Client Configuration
// ============================================

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || '';
const S3_FOLDER_PREFIX = process.env.S3_FOLDER_PREFIX || ''; // Optional folder prefix

// Validate S3 configuration
if (!S3_BUCKET_NAME) {
  console.warn('⚠️  S3_BUCKET_NAME not configured. S3 uploads will be disabled.');
}
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.warn('⚠️  AWS credentials not configured. S3 uploads will be disabled.');
}

const isS3Enabled = !!(S3_BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const s3PathInfo = S3_FOLDER_PREFIX ? `${S3_BUCKET_NAME}/${S3_FOLDER_PREFIX}/` : `${S3_BUCKET_NAME}/`;
console.log(`S3 Uploads: ${isS3Enabled ? 'ENABLED' : 'DISABLED'}${isS3Enabled ? ` (path: ${s3PathInfo})` : ''}`);

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
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict?: boolean;
      schema: Record<string, any>;
    };
  };
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
  userEmail?: string; // User email (optional for backward compatibility)
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
  userEmail?: string; // User email (optional for backward compatibility)
  frameName: string;
  frameWidth: number;
  frameHeight: number;
  frameImageBase64?: string;  // Frame image for AI vision analysis
  layers: LayerMetadata[];
  generateImages?: boolean;   // Whether to generate AI images for image layers
  promptFile?: string; // User-selected prompt file (e.g., 'creative-director.txt')
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
  // Typography properties
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  textCase?: string;
  // Image generation properties
  imagePrompt?: string;           // Prompt for AI image generation
  generatedImageBase64?: string;  // Base64 of generated image (populated by server)
}

interface EditVariant {
  variantIndex: number;
  humanPrompt: string;
  theme: string;
  instructions: EditInstruction[];
  readableInstructions?: string;  // Human-readable directive version of instructions
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

  // Remove markdown code blocks if present
  if (cleaned.includes('```json')) {
    const jsonMatch = cleaned.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      cleaned = jsonMatch[1].trim();
    }
  } else if (cleaned.includes('```')) {
    const codeMatch = cleaned.match(/```\s*([\s\S]*?)\s*```/);
    if (codeMatch) {
      cleaned = codeMatch[1].trim();
    }
  }

  // If still not starting with {, try to find JSON object in the response
  if (!cleaned.startsWith('{')) {
    // Look for the start of the JSON object
    const jsonStart = cleaned.indexOf('{"variants"');
    if (jsonStart === -1) {
      // Try finding just the opening brace of an object
      const braceStart = cleaned.indexOf('{');
      if (braceStart !== -1) {
        cleaned = cleaned.substring(braceStart);
      }
    } else {
      cleaned = cleaned.substring(jsonStart);
    }
  }

  // Find the matching closing brace
  if (cleaned.startsWith('{')) {
    let braceCount = 0;
    let endIndex = -1;

    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '{') braceCount++;
      if (cleaned[i] === '}') braceCount--;
      if (braceCount === 0) {
        endIndex = i + 1;
        break;
      }
    }

    if (endIndex !== -1) {
      cleaned = cleaned.substring(0, endIndex);
    }
  }

  console.log('Cleaned JSON (first 500 chars):', cleaned.substring(0, 500));

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseError) {
    console.error('JSON Parse Error:', parseError);
    console.error('Full response text (first 2000 chars):\n', cleaned.substring(0, 2000));
    console.error('Last 500 chars:\n', cleaned.substring(Math.max(0, cleaned.length - 500)));
    const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`Failed to parse AI response as JSON. The response may have been truncated. Try reducing the number of layers or simplifying the frame. Error: ${errorMsg}`);
  }

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

// Process image generation instructions in variants (with parallel processing)
async function processImageGenerations(
  variants: EditVariant[],
  contextDescription: string
): Promise<EditVariant[]> {
  // Collect all image generation instructions with their references
  interface ImageTask {
    variantIndex: number;
    instructionIndex: number;
    instruction: EditInstruction;
    variant: EditVariant;
  }

  const imageTasks: ImageTask[] = [];
  variants.forEach((variant, variantIndex) => {
    variant.instructions.forEach((instruction, instructionIndex) => {
      if (instruction.action === 'generateImage' && instruction.imagePrompt) {
        imageTasks.push({ variantIndex, instructionIndex, instruction, variant });
      }
    });
  });

  if (imageTasks.length === 0) {
    return variants;
  }

  console.log(`Processing ${imageTasks.length} image generation tasks in parallel (concurrency limit: 5)...`);

  // Process all image generation tasks in parallel
  const settledResults = await processWithConcurrency(
    imageTasks,
    async (task: ImageTask, index: number) => {
      console.log(`  [${index + 1}/${imageTasks.length}] Generating image for "${task.instruction.imagePrompt?.substring(0, 50)}..."`);

      const generatedImage = await generateImageFromPrompt(
        task.instruction.imagePrompt!,
        `${contextDescription} - Variant: ${task.variant.theme}`
      );

      if (generatedImage) {
        console.log(`    ✓ Image generated successfully`);
      } else {
        console.log(`    ✗ Image generation failed`);
      }

      return {
        ...task,
        generatedImage
      };
    },
    imageLimiter
  );

  // Apply results back to instructions
  settledResults.forEach((result: PromiseSettledResult<ImageTask & { generatedImage: string | null }>, index: number) => {
    if (result.status === 'fulfilled' && result.value.generatedImage) {
      const task = result.value;
      variants[task.variantIndex].instructions[task.instructionIndex].generatedImageBase64 = result.value.generatedImage;
    } else if (result.status === 'rejected') {
      const task = imageTasks[index];
      console.error(`  Failed to generate image for variant ${task.variant.theme}: ${result.reason}`);
    }
  });

  return variants;
}

// Convert hex color to human-readable name
function hexToColorName(hex: string): string {
  const colorMap: Record<string, string> = {
    '#FFFFFF': 'white', '#FFF': 'white',
    '#000000': 'black', '#000': 'black',
    '#FF0000': 'red', '#F00': 'red',
    '#00FF00': 'green', '#0F0': 'green',
    '#0000FF': 'blue', '#00F': 'blue',
    '#FFFF00': 'yellow', '#FF0': 'yellow',
    '#FF00FF': 'magenta', '#F0F': 'magenta',
    '#00FFFF': 'cyan', '#0FF': 'cyan',
    '#FFA500': 'orange',
    '#800080': 'purple',
    '#FFC0CB': 'pink',
    '#A52A2A': 'brown',
    '#808080': 'gray', '#GREY': 'gray',
    '#C0C0C0': 'silver',
    '#FFD700': 'gold',
    '#CCFF00': 'neon yellow',
    '#FF6B6B': 'coral red',
    '#4ECDC4': 'teal',
  };

  const upper = hex.toUpperCase();
  if (colorMap[upper]) return colorMap[upper];

  // Analyze the hex to give a descriptive name
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const brightness = (r + g + b) / 3;

  if (brightness < 40) return 'very dark (near black)';
  if (brightness < 80) return 'dark';
  if (brightness > 220) return 'very light (near white)';
  if (brightness > 180) return 'light';

  // Determine dominant color
  if (r > g && r > b) {
    if (r > 200) return g > 150 ? 'orange/yellow' : 'bright red';
    return 'reddish';
  }
  if (g > r && g > b) {
    return g > 200 ? 'bright green' : 'greenish';
  }
  if (b > r && b > g) {
    return b > 200 ? 'bright blue' : 'bluish';
  }

  return 'neutral tone';
}

// Humanize instructions using Gemini 2.5 Flash
async function humanizeInstructions(variant: EditVariant): Promise<string> {
  // First, create a simplified version of the instructions
  const simplifiedInstructions = variant.instructions.map(inst => {
    const layerName = inst.target.replace(/_/g, ' ');

    switch (inst.action) {
      case 'changeFill':
        return `Change "${layerName}" color to ${hexToColorName(inst.color || '')}`;
      case 'addGradient':
        return `Apply a gradient to "${layerName}"`;
      case 'changeStroke':
      case 'addStroke':
        return `Add a ${hexToColorName(inst.color || '')} border to "${layerName}"`;
      case 'removeStroke':
        return `Remove border from "${layerName}"`;
      case 'changeText':
        return `Change "${layerName}" text to "${inst.content}"`;
      case 'changeFont':
        return `Change "${layerName}" font to ${inst.fontFamily}`;
      case 'changeFontSize':
        return `Resize "${layerName}" text to ${inst.fontSize}px`;
      case 'changeTextCase':
        return `Transform "${layerName}" to ${inst.textCase}`;
      case 'move':
        return `Reposition "${layerName}"`;
      case 'resize':
        return `Resize "${layerName}"`;
      case 'addShadow':
        return `Add shadow to "${layerName}"`;
      case 'addBackgroundBlur':
        return `Add glassmorphism effect to "${layerName}"`;
      case 'changeCornerRadius':
        return `Round the corners of "${layerName}"`;
      case 'changeOpacity':
        return `Adjust "${layerName}" transparency`;
      case 'hide':
        return `Hide "${layerName}"`;
      case 'generateImage':
        return `Generate new AI image for "${layerName}"`;
      default:
        return `Modify "${layerName}"`;
    }
  });

  const instructionsList = simplifiedInstructions.join('. ') + '.';

  // Now call Gemini to make it more natural and directive
  const prompt = `Convert these design instructions into a clear, concise paragraph of directives. Write as if you're giving instructions to a designer. Use plain language, no technical jargon. Don't mention hex codes. Keep it brief but complete.

Theme: ${variant.theme}
Summary: ${variant.humanPrompt}

Raw instructions:
${instructionsList}

Write 2-3 sentences maximum. Start directly with the instructions, no preamble.`;

  try {
    if (AI_PROVIDER === 'openrouter') {
      const response = await callOpenRouter({
        model: OPENROUTER_MODELS.FAST,
        messages: [{
          role: 'user',
          content: prompt
        }],
        temperature: 0.3,
        max_tokens: 300
      });

      if (response.ok) {
        const data = await response.json() as OpenRouterResponse;
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) {
          return text;
        }
      }
    } else if (genAI) {
      // Direct Gemini API
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite-preview-09-2025' });
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      if (text) {
        return text;
      }
    }
  } catch (error) {
    console.warn('  Failed to humanize instructions:', error);
  }

  // Fallback: return the simplified version
  return instructionsList;
}

// Process all variants to add readable instructions
async function addReadableInstructions(variants: EditVariant[]): Promise<EditVariant[]> {
  console.log('\n📝 Generating human-readable instructions...\n');

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    console.log(`  Humanizing variant ${i + 1}: ${variant.theme}...`);
    variant.readableInstructions = await humanizeInstructions(variant);
    console.log(`  ✓ Done`);
  }

  return variants;
}

// Generate layer name using AI (supports both Gemini and OpenRouter)
// Batch process multiple layers at once (up to 10)
async function generateLayerNamesBatch(
  layers: Array<{ imageBase64: string; currentName: string; layerType: string }>
): Promise<string[]> {
  const batchSize = layers.length;

  // Build layer list for prompt
  const layerList = layers
    .map((layer, idx) => `${idx + 1}. Current name: "${layer.currentName}", Type: ${layer.layerType}`)
    .join('\n');

  const prompt = `You are a UI layer naming assistant. I'm sending you ${batchSize} UI element images.
For each image, provide a concise, descriptive name following these rules:

Rules:
- Use 3-5 words maximum
- Use snake_case format (e.g., blue_submit_button, main_header_text)
- Be specific about the element type and purpose
- Include color only if visually distinctive
- Include state if apparent (hover, active, disabled)

Layers to rename:
${layerList}

Respond with a JSON object containing a "names" array with exactly ${batchSize} names in the same order as the images.
Example format: {"names": ["blue_submit_button", "main_header_text", "profile_icon"]}

IMPORTANT: Return ONLY the JSON object, no additional text or explanation.`;

  try {
    let text: string;

    if (AI_PROVIDER === 'openrouter') {
      // OpenRouter path - build content with all images
      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: prompt }
      ];

      // Add all images to the same request
      layers.forEach(layer => {
        content.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${layer.imageBase64}` }
        });
      });

      const response = await callOpenRouter({
        model: OPENROUTER_MODELS.FAST,
        messages: [{
          role: 'user',
          content
        }],
        temperature: 0.3,
        max_tokens: 500,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'layer_names',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                names: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: batchSize,
                  maxItems: batchSize
                }
              },
              required: ['names'],
              additionalProperties: false
            }
          }
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as OpenRouterResponse;
      text = data.choices?.[0]?.message?.content?.trim() || '{"names":[]}';
    } else {
      // Direct Gemini path - build content with all images
      if (!genAI) {
        throw new Error('Gemini client not initialized');
      }
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite-preview-09-2025',
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              names: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING }
              }
            },
            required: ['names']
          }
        }
      });

      const content: Array<string | { inlineData: { mimeType: string; data: string } }> = [prompt];

      // Add all images to the same request
      layers.forEach(layer => {
        content.push({
          inlineData: {
            mimeType: 'image/png',
            data: layer.imageBase64
          }
        });
      });

      const result = await model.generateContent(content);
      text = result.response.text().trim();
    }

    // Parse JSON response
    // Remove markdown code blocks if present
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

    let names: string[];
    try {
      const parsed = JSON.parse(text);
      // Handle structured output format {names: [...]}
      if (parsed && typeof parsed === 'object' && 'names' in parsed) {
        names = parsed.names;
      } else if (Array.isArray(parsed)) {
        // Handle legacy array format for backward compatibility
        names = parsed;
      } else {
        throw new Error('Response is not in expected format');
      }
    } catch (parseError) {
      console.error('Failed to parse JSON response:', text);
      // Fallback: try to extract array from text
      const arrayMatch = text.match(/\[.*\]/s);
      if (arrayMatch) {
        names = JSON.parse(arrayMatch[0]);
      } else {
        throw new Error('Could not parse response as JSON array');
      }
    }

    // Validate we got the right number of names
    if (!Array.isArray(names) || names.length !== batchSize) {
      console.error(`Expected ${batchSize} names, got ${names?.length || 0}`);
      throw new Error(`Invalid response: expected ${batchSize} names`);
    }

    // Clean up all names
    const cleanedNames = names.map((name, idx) => {
      const cleaned = String(name)
        .replace(/^["']|["']$/g, '') // Remove surrounding quotes
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .replace(/[^a-zA-Z0-9_]/g, '') // Remove special characters
        .toLowerCase();

      return cleaned || layers[idx].currentName; // Fallback to original name
    });

    return cleanedNames;
  } catch (error) {
    console.error(`Error generating batch names:`, error);
    // Fall back to original names on error
    return layers.map(layer => layer.currentName);
  }
}

// Legacy single-layer function (kept for compatibility, but now calls batch)
async function generateLayerName(
  imageBase64: string,
  currentName: string,
  layerType: string
): Promise<string> {
  const result = await generateLayerNamesBatch([{ imageBase64, currentName, layerType }]);
  return result[0];
}

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'exporter-server' });
});

// Cache stats endpoint
app.get('/api/cache/stats', (_req: Request, res: Response) => {
  res.json(aiCache.getStats());
});

// Clear cache endpoint (for debugging)
app.post('/api/cache/clear', (_req: Request, res: Response) => {
  aiCache.clear();
  res.json({ message: 'Cache cleared successfully' });
});

// Get available prompts endpoint
app.get('/api/prompts', (_req: Request, res: Response) => {
  try {
    // Try compiled location first, then dev location
    let promptsDir = path.join(__dirname, 'prompts');
    if (!fs.existsSync(promptsDir)) {
      promptsDir = path.join(__dirname, '..', 'prompts');
    }

    if (!fs.existsSync(promptsDir)) {
      res.status(500).json({
        error: 'Prompts directory not found',
        message: 'Could not locate prompts directory'
      });
      return;
    }

    // Read all .txt files from prompts directory
    const files = fs.readdirSync(promptsDir)
      .filter(file => file.endsWith('.txt'))
      .sort();

    // Format prompt list
    const prompts = files.map(filename => {
      const id = filename.replace('.txt', '');
      // Convert kebab-case or snake_case to Title Case
      const name = id
        .split(/[-_]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      return {
        id,
        name,
        filename,
        isDefault: filename === 'default.txt'
      };
    });

    console.log(`Found ${prompts.length} prompt files in ${promptsDir}`);
    res.json({ prompts });
  } catch (error) {
    console.error('Error reading prompts:', error);
    res.status(500).json({
      error: 'Failed to read prompts',
      message: (error as Error).message
    });
  }
});

// Main endpoint for renaming layers
app.post('/api/rename-layers', renameRateLimiter, haltOnTimedout, async (req: Request, res: Response) => {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
    const { layers, userEmail }: RenameRequest = req.body;

    if (!layers || !Array.isArray(layers)) {
      res.status(400).json({ error: 'Invalid request: layers array required' });
      return;
    }

    // Skip frames with more than 100 layers
    if (layers.length > 100) {
      console.log(`⚠️  Skipping rename: Frame has ${layers.length} layers (max 100 allowed)`);
      res.status(400).json({
        error: 'Too many layers',
        message: `Frame has ${layers.length} layers. Maximum 100 layers allowed for AI renaming.`,
        layerCount: layers.length,
        maxLayers: 100
      });
      return;
    }

    // Get IP address
    const ipAddress = req.ip || req.socket.remoteAddress || null;

    // Create job in database
    const jobResult = await dbQuery(
      `INSERT INTO jobs (type, status, layer_count, user_email, ip_address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ['rename-layers', 'processing', layers.length, userEmail || null, ipAddress]
    );
    jobId = jobResult.rows[0]?.id || null;

    console.log(`[Job ${jobId}] Processing ${layers.length} layers for AI renaming (batch size: 10)...`);
    console.log(`[Job ${jobId}] User: ${userEmail || 'unknown'}`);

    // Process layers in batches of 10
    const BATCH_SIZE = 10;
    const results: Array<{ id: string; newName: string }> = [];
    const failures: string[] = [];

    for (let i = 0; i < layers.length; i += BATCH_SIZE) {
      const batch = layers.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(layers.length / BATCH_SIZE);

      console.log(`  [Batch ${batchNumber}/${totalBatches}] Processing ${batch.length} layers (${i + 1}-${i + batch.length})...`);

      try {
        // Call batch processing function
        const batchLayers = batch.map(layer => ({
          imageBase64: layer.imageBase64,
          currentName: layer.currentName,
          layerType: layer.type
        }));

        const newNames = await generateLayerNamesBatch(batchLayers);

        // Map results back to layer IDs
        batch.forEach((layer, idx) => {
          console.log(`    [${i + idx + 1}] ${layer.currentName} -> ${newNames[idx]}`);
          results.push({
            id: layer.id,
            newName: newNames[idx]
          });
        });
      } catch (error) {
        console.error(`  [Batch ${batchNumber}/${totalBatches}] Failed:`, error);
        // On batch failure, fall back to original names
        batch.forEach((layer, idx) => {
          failures.push(layer.id);
          results.push({
            id: layer.id,
            newName: layer.currentName
          });
          console.log(`    [${i + idx + 1}] ${layer.currentName} -> ${layer.currentName} (fallback)`);
        });
      }

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < layers.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Results and failures are already collected in the loop above

    const duration = Date.now() - startTime;
    const status = failures.length === layers.length ? 'failed' : 'completed';

    // Update job as completed
    if (jobId) {
      await dbQuery(
        `UPDATE jobs
         SET status = $1, completed_at = NOW(), duration_ms = $2
         WHERE id = $3`,
        [status, duration, jobId]
      );
    }

    console.log(`[Job ${jobId}] Completed renaming: ${results.length} total, ${failures.length} failed, ${duration}ms`);
    if (failures.length > 0) {
      console.log(`Failed layer IDs: ${failures.join(', ')}`);
    }
    console.log('Sending response:', JSON.stringify({ layers: results }, null, 2));

    res.json({ layers: results });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Job ${jobId}] Error in /api/rename-layers:`, error);

    // Update job as failed
    if (jobId) {
      await dbQuery(
        `UPDATE jobs
         SET status = $1, completed_at = NOW(), duration_ms = $2, error_message = $3, error_stack = $4
         WHERE id = $5`,
        ['failed', duration, (error as Error).message, (error as Error).stack || null, jobId]
      );
    }

    res.status(500).json({
      error: 'Internal server error',
      message: (error as Error).message
    });
  }
});

// ============================================
// Generate Edits Endpoint
// ============================================
app.post('/api/generate-edits', heavyLimiter, haltOnTimedout, async (req: Request, res: Response) => {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
    const { frameName, frameWidth, frameHeight, frameImageBase64, layers, generateImages, promptFile, userEmail }: GenerateEditsRequest = req.body;

    if (!layers || !Array.isArray(layers) || layers.length === 0) {
      res.status(400).json({ error: 'Invalid request: layers array required' });
      return;
    }

    // Get IP address
    const ipAddress = req.ip || req.socket.remoteAddress || null;

    // Create job in database (10 variants expected)
    const jobResult = await dbQuery(
      `INSERT INTO jobs (type, status, frame_name, variant_count, user_email, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      ['generate-edits', 'processing', frameName, 10, userEmail || null, ipAddress]
    );
    jobId = jobResult.rows[0]?.id || null;

    // Count image layers
    const imageLayers = layers.filter(l => l.hasImageFill);

    // Generate cache key based on frame structure (not images, for faster hashing)
    const cacheKey = aiCache.generateKey({
      frameName,
      frameWidth,
      frameHeight,
      layerCount: layers.length,
      layerNames: layers.map(l => l.name).sort(), // Sorted for consistency
      promptFile: promptFile || 'default.txt',
      generateImages: generateImages || false
    });

    console.log(`\n========================================`);
    console.log(`[Job ${jobId}] Generating edits for frame "${frameName}"`);
    console.log(`Frame size: ${frameWidth} x ${frameHeight}`);
    console.log(`Layers: ${layers.length} (${imageLayers.length} with images)`);
    console.log(`Image included: ${frameImageBase64 ? `Yes (${Math.round(frameImageBase64.length / 1024)}KB)` : 'No'}`);
    console.log(`Generate AI Images: ${generateImages ? 'YES' : 'No'}`);
    console.log(`Prompt file: ${promptFile || 'default.txt'}`);
    console.log(`User: ${userEmail || 'unknown'}`);
    console.log(`Cache key: ${cacheKey.substring(0, 16)}...`);
    console.log(`========================================\n`);

    // Check cache first
    const cachedVariants = aiCache.get<EditVariant[]>(cacheKey);
    if (cachedVariants) {
      console.log(`[Job ${jobId}] ✨ CACHE HIT! Returning cached variants instantly`);

      const duration = Date.now() - startTime;

      // Update job as completed
      if (jobId) {
        await dbQuery(
          `UPDATE jobs
           SET status = $1, completed_at = NOW(), duration_ms = $2
           WHERE id = $3`,
          ['completed', duration, jobId]
        );
      }

      res.json({ variants: cachedVariants });
      return;
    }

    console.log(`[Job ${jobId}] Cache miss - generating new variants...`);

    // Load the user-selected prompt file
    let activePrompt = EDIT_GENERATION_PROMPT;
    const selectedPromptFile = promptFile || 'default.txt';

    // Try loading the selected prompt file
    const promptPath = path.join(__dirname, 'prompts', selectedPromptFile);
    const devPromptPath = path.join(__dirname, '..', 'prompts', selectedPromptFile);

    try {
      activePrompt = fs.readFileSync(promptPath, 'utf-8');
      console.log(`Using prompt: ${selectedPromptFile}`);
    } catch {
      try {
        activePrompt = fs.readFileSync(devPromptPath, 'utf-8');
        console.log(`Using prompt (dev): ${selectedPromptFile}`);
      } catch {
        console.log(`Prompt file not found: ${selectedPromptFile}, using default`);
        // activePrompt already set to EDIT_GENERATION_PROMPT
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
        max_tokens: 32000, // Very high limit to handle extremely complex frames with many layers
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

    // Generate human-readable instructions for each variant
    variants = await addReadableInstructions(variants);

    const duration = Date.now() - startTime;

    console.log(`[Job ${jobId}] Generated ${variants.length} variants in ${duration}ms:`);
    variants.forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.theme}: ${v.instructions.length} instructions`);
      console.log(`     "${v.humanPrompt}"`);
    });

    // Store in cache for future use (24 hour TTL)
    aiCache.set(cacheKey, variants, 24 * 60 * 60 * 1000);

    // Update job as completed
    if (jobId) {
      await dbQuery(
        `UPDATE jobs
         SET status = $1, completed_at = NOW(), duration_ms = $2
         WHERE id = $3`,
        ['completed', duration, jobId]
      );
    }

    res.json({ variants });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Job ${jobId}] Error in /api/generate-edits:`, error);

    // Update job as failed
    if (jobId) {
      await dbQuery(
        `UPDATE jobs
         SET status = $1, completed_at = NOW(), duration_ms = $2, error_message = $3, error_stack = $4
         WHERE id = $5`,
        ['failed', duration, (error as Error).message, (error as Error).stack || null, jobId]
      );
    }

    res.status(500).json({
      error: 'Failed to generate edits',
      message: (error as Error).message
    });
  }
});

// ============================================
// S3 Upload Endpoint
// ============================================

app.post('/api/upload-to-s3', heavyLimiter, async (req: Request, res: Response) => {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
    const { frameName, zipData, userEmail, variantCount, fileSizeBytes } = req.body;

    if (!isS3Enabled) {
      res.status(503).json({ error: 'S3 uploads are not configured on this server' });
      return;
    }

    if (!frameName || !zipData) {
      res.status(400).json({ error: 'Invalid request: frameName and zipData required' });
      return;
    }

    console.log(`[S3 Upload] Starting upload for ${frameName}.zip (${Math.round((fileSizeBytes || 0) / 1024)}KB)`);

    // Get IP address
    const ipAddress = req.ip || req.socket.remoteAddress || null;

    // Create job in database
    const jobResult = await dbQuery(
      `INSERT INTO jobs (type, status, frame_name, variant_count, user_email, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      ['s3-upload', 'processing', frameName, variantCount || null, userEmail || null, ipAddress]
    );
    jobId = jobResult.rows[0]?.id || null;

    // Convert base64 to buffer
    const buffer = Buffer.from(zipData, 'base64');
    const fileName = `${frameName}.zip`;

    // Construct S3 key with optional folder prefix
    const s3Key = S3_FOLDER_PREFIX ? `${S3_FOLDER_PREFIX}/${fileName}` : fileName;

    // Upload to S3
    const uploadCommand = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Key,
      Body: buffer,
      ContentType: 'application/zip',
      Metadata: {
        'user-email': userEmail || 'unknown',
        'variant-count': String(variantCount || 0),
        'uploaded-at': new Date().toISOString()
      }
    });

    await s3Client.send(uploadCommand);

    const s3Url = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Key}`;

    console.log(`[S3 Upload] ✓ Uploaded ${fileName} to S3: ${s3Url}`);

    // Store S3 export record in database
    await dbQuery(
      `INSERT INTO s3_exports (job_id, frame_name, file_name, s3_url, s3_key, file_size_bytes, variant_count, user_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [jobId, frameName, fileName, s3Url, s3Key, fileSizeBytes || buffer.length, variantCount || null, userEmail || null]
    );

    const duration = Date.now() - startTime;

    // Update job as completed
    if (jobId) {
      await dbQuery(
        `UPDATE jobs
         SET status = $1, completed_at = NOW(), duration_ms = $2
         WHERE id = $3`,
        ['completed', duration, jobId]
      );
    }

    console.log(`[S3 Upload] Completed in ${duration}ms`);

    res.json({
      success: true,
      s3Url,
      fileName,
      fileSizeBytes: buffer.length,
      duration
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Job ${jobId}] Error in /api/upload-to-s3:`, error);

    // Update job as failed
    if (jobId) {
      await dbQuery(
        `UPDATE jobs
         SET status = $1, completed_at = NOW(), duration_ms = $2, error_message = $3, error_stack = $4
         WHERE id = $5`,
        ['failed', duration, (error as Error).message, (error as Error).stack || null, jobId]
      );
    }

    res.status(500).json({
      error: 'Failed to upload to S3',
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
  POST /api/upload-to-s3    - Upload frame ZIPs to S3

Config:
  S3 Uploads: ${isS3Enabled ? 'ENABLED' : 'DISABLED'}${isS3Enabled ? ` (bucket: ${S3_BUCKET_NAME})` : ''}
  Edit prompt file: ${promptFileName}
  ${thinkingInfo}
  (Set AI_PROVIDER env var to switch: gemini | openrouter)

Ready to receive requests from Figma plugin.
`);
});
