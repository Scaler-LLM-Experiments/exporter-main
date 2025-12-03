#!/usr/bin/env node

/**
 * Image Reconstruction Script
 * Takes exported meta.json and layer PNGs, reconstructs the complete image
 *
 * Usage: npm run reconstruct <path-to-exported-folder>
 * Example: npm run reconstruct ./login_card
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

interface LayerData {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  exportX?: number;
  exportY?: number;
  exportWidth?: number;
  exportHeight?: number;
  z: number;
  visible: boolean;
  text?: string;
}

interface MetaData {
  component: {
    id: string;
    name: string;
    width: number;
    height: number;
  };
  layers: LayerData[];
  scale?: number;
  format?: string;
}

// Helper to create filename from layer name (matching code.ts logic)
function createFilename(name: string, id: string): string {
  // Sanitize the layer name: remove/replace invalid filename characters
  const safeName = name
    .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid filename chars
    .replace(/\s+/g, '_')            // Replace spaces with underscores
    .replace(/_+/g, '_')             // Collapse multiple underscores
    .replace(/^_|_$/g, '')           // Trim leading/trailing underscores
    .substring(0, 100);              // Limit length

  // Use sanitized name, fallback to ID if name is empty
  const baseName = safeName || id.replace(/:/g, '_');
  return `${baseName}.png`;
}

async function reconstructImage(folderPath: string, outputPath?: string): Promise<void> {
  console.log(`🔍 Reading metadata from: ${folderPath}`);

  // Read meta.json
  const metaPath = path.join(folderPath, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(`meta.json not found at ${metaPath}`);
  }

  const meta: MetaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const scale = meta.scale || 2; // Default to 2x if not specified
  const format = meta.format || 'png';

  console.log(`📦 Component: ${meta.component.name} (${meta.component.width}x${meta.component.height})`);
  console.log(`📏 Export scale: ${scale}x`);
  console.log(`🎨 Export format: ${format}`);
  console.log(`📚 Total layers: ${meta.layers.length}`);

  // Sort layers by z-index (ascending order, so lower z-index is drawn first)
  const sortedLayers = [...meta.layers]
    .filter(layer => layer.visible)
    .sort((a, b) => a.z - b.z);

  console.log(`✨ Visible layers: ${sortedLayers.length}`);

  // Create base canvas at SCALED resolution (transparent background)
  const canvasWidth = Math.ceil(meta.component.width * scale);
  const canvasHeight = Math.ceil(meta.component.height * scale);

  console.log(`🎨 Creating canvas: ${canvasWidth}x${canvasHeight} (at ${scale}x scale)`);

  // Create transparent base image
  let canvas = sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png();

  // Composite all layers
  const compositeOps: sharp.OverlayOptions[] = [];

  for (const layer of sortedLayers) {
    const layerImagePath = path.join(folderPath, 'layers', createFilename(layer.name, layer.id));

    if (!fs.existsSync(layerImagePath)) {
      console.warn(`⚠️  Layer image not found: ${layerImagePath} (${layer.name})`);
      continue;
    }

    try {
      // Read layer image (already at the exported scale)
      const layerImage = sharp(layerImagePath);
      const layerMetadata = await layerImage.metadata();

      // Use export bounds if available (for accurate positioning)
      const useX = layer.exportX !== undefined ? layer.exportX : layer.x;
      const useY = layer.exportY !== undefined ? layer.exportY : layer.y;

      // Calculate positioning and clipping in scaled space
      const layerX = Math.round(useX * scale);
      const layerY = Math.round(useY * scale);

      // Layer images are already at the correct scale from export
      const actualWidth = layerMetadata.width || 0;
      const actualHeight = layerMetadata.height || 0;

      // Check if layer extends outside canvas bounds
      const needsClipping =
        layerX < 0 ||
        layerY < 0 ||
        (layerX + actualWidth) > canvasWidth ||
        (layerY + actualHeight) > canvasHeight;

      let processedLayer = layerImage;
      let finalX = layerX;
      let finalY = layerY;

      // If layer extends outside canvas, we need to crop it
      if (needsClipping) {
        const extractX = Math.max(0, -layerX);
        const extractY = Math.max(0, -layerY);
        const extractWidth = Math.min(actualWidth - extractX, canvasWidth - Math.max(0, layerX));
        const extractHeight = Math.min(actualHeight - extractY, canvasHeight - Math.max(0, layerY));

        if (extractWidth > 0 && extractHeight > 0) {
          processedLayer = processedLayer.extract({
            left: extractX,
            top: extractY,
            width: Math.floor(extractWidth),
            height: Math.floor(extractHeight)
          });

          // Adjust position to account for clipping
          finalX = Math.max(0, layerX);
          finalY = Math.max(0, layerY);
        } else {
          // Layer is completely outside canvas, skip it
          console.log(`  ⊘ Layer ${layer.z}: ${layer.name} (completely outside canvas)`);
          continue;
        }
      }

      const layerBuffer = await processedLayer.toBuffer();

      compositeOps.push({
        input: layerBuffer,
        top: finalY,
        left: finalX
      });

      console.log(`  ✓ Layer ${layer.z}: ${layer.name} at (${layer.x}, ${layer.y}) [scaled to ${layerX}, ${layerY}]${needsClipping ? ' [clipped]' : ''}`);
    } catch (error) {
      console.warn(`⚠️  Error processing layer ${layer.name}:`, (error as Error).message);
    }
  }

  // Apply all composite operations at once
  if (compositeOps.length > 0) {
    canvas = canvas.composite(compositeOps);
  }

  // Determine output path
  const output = outputPath || path.join(folderPath, `${meta.component.name}_reconstructed.png`);

  // Save the final image
  await canvas.toFile(output);

  console.log(`\n✅ Image reconstructed successfully!`);
  console.log(`📁 Output: ${output}`);
}

// CLI handling
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: npm run reconstruct <path-to-exported-folder> [output-path]');
  console.error('Example: npm run reconstruct ./login_card');
  console.error('Example: npm run reconstruct ./login_card ./output.png');
  process.exit(1);
}

const folderPath = args[0];
const outputPath = args[1];

reconstructImage(folderPath, outputPath)
  .then(() => {
    console.log('🎉 Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
