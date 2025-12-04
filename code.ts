// Frame Exporter Plugin
// Exports a selected frame with all its layers as PNGs and metadata as JSON

figma.showUI(__html__, { width: 320, height: 600 });

// Send initial selection state
function updateSelectionState() {
  const selection = figma.currentPage.selection;
  const frames = selection.filter(node => node.type === 'FRAME' || node.type === 'COMPONENT');

  if (frames.length > 0) {
    const frameNames = frames.map(f => f.name).join(', ');
    figma.ui.postMessage({
      type: 'selection-change',
      hasFrame: true,
      frameName: frameNames,
      frameCount: frames.length
    });
  } else {
    figma.ui.postMessage({
      type: 'selection-change',
      hasFrame: false,
      frameName: '',
      frameCount: 0
    });
  }
}

// Listen for selection changes
figma.on('selectionchange', updateSelectionState);

// Send initial state
updateSelectionState();

// ============================================

interface LayerData {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  // Actual exported image bounds (may differ from node bounds due to effects, strokes, etc.)
  exportX?: number;
  exportY?: number;
  exportWidth?: number;
  exportHeight?: number;
  z: number;
  visible: boolean;
  opacity?: number;
  blendMode?: string;
  rotation?: number;
  text?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number | { value: number; unit: string };
  fills?: Array<{ type: string; color?: string; opacity?: number }>;
  strokes?: Array<{ type: string; color?: string; opacity?: number }>;
  effects?: Array<{ type: string; visible: boolean }>;
  cornerRadius?: number | { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number };
  constraints?: { horizontal: string; vertical: string };
}

interface ExportData {
  component: {
    id: string;
    name: string;
    width: number;
    height: number;
  };
  layers: LayerData[];
  scale: number;
}

// ============================================
// Generate Edits Types
// ============================================

interface LayerMetadataForAI {
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
  hasImageFill?: boolean;  // True if layer has an image fill
}

interface EditInstruction {
  action: string;
  target: string;
  // Position/Layout
  x?: number;
  y?: number;
  relative?: boolean;
  width?: number;
  height?: number;
  scale?: number;
  position?: 'front' | 'back' | number;
  // Color/Fill
  color?: string;
  opacity?: number;
  weight?: number;
  // Text
  content?: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  align?: 'left' | 'center' | 'right' | 'justify';  // For changeTextAlign
  lineHeight?: number;      // For changeLineHeight (multiplier like 1.5)
  letterSpacing?: number;   // For changeLetterSpacing (in pixels)
  // Shape
  radius?: number;          // For changeCornerRadius
  angle?: number;           // For rotate (in degrees)
  // Shadow
  blur?: number;            // For addShadow/addBlur
  shadowX?: number;         // For addShadow offset
  shadowY?: number;         // For addShadow offset
  spread?: number;          // For addShadow spread
  // Alignment
  horizontal?: 'left' | 'center' | 'right';   // For alignTo
  vertical?: 'top' | 'center' | 'bottom';     // For alignTo
  // Effects
  blendMode?: string;       // For changeBlendMode
  // Gradient
  colors?: string[];        // For addGradient
  gradientAngle?: number;   // For addGradient
  // Text Transform
  textCase?: 'upper' | 'lower' | 'title' | 'original';  // For changeTextCase
  // Inner Shadow
  inset?: boolean;          // For addInnerShadow (use with shadow params)
  // Background Blur
  backgroundBlur?: number;  // For addBackgroundBlur (glassmorphism)
  // AI Image Generation
  imagePrompt?: string;           // For generateImage - prompt describing the image
  generatedImageBase64?: string;  // For generateImage - base64 of AI-generated image
}

interface EditVariant {
  variantIndex: number;
  humanPrompt: string;
  theme: string;
  instructions: EditInstruction[];
  readableInstructions?: string;  // Human-readable directive version from AI
}

// Helper function to create a safe filename from layer name
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

// Helper function to create a safe folder name
function createFolderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Check if a node has visual effects that require it to be exported as a single layer
function hasVisualEffects(node: SceneNode): boolean {
  // Check for effects (shadows, blurs, etc.)
  if ('effects' in node && node.effects && node.effects.length > 0) {
    const visibleEffects = node.effects.filter(e => e.visible);
    if (visibleEffects.length > 0) return true;
  }

  // Check for non-default blend mode
  if ('blendMode' in node && node.blendMode !== 'NORMAL' && node.blendMode !== 'PASS_THROUGH') {
    return true;
  }

  // Check for opacity less than 1
  if ('opacity' in node && node.opacity < 1) {
    return true;
  }

  // Check for background fills on frames/groups
  if ((node.type === 'FRAME' || node.type === 'GROUP') && 'fills' in node) {
    const fills = node.fills;
    if (fills !== figma.mixed && Array.isArray(fills) && fills.length > 0) {
      const visibleFills = fills.filter(f => f.visible);
      if (visibleFills.length > 0) return true;
    }
  }

  return false;
}

// Check if a node is a leaf (has no children or is a type that shouldn't be descended into)
function isLeafNode(node: SceneNode): boolean {
  // These types can have children but should be treated as leaves
  const leafTypes = ['INSTANCE', 'BOOLEAN_OPERATION', 'VECTOR', 'STAR', 'LINE', 'ELLIPSE', 'POLYGON', 'RECTANGLE', 'TEXT'];

  if (leafTypes.indexOf(node.type) !== -1) {
    return true;
  }

  // If it has no children, it's a leaf
  if (!('children' in node)) {
    return true;
  }

  // If it has children but they're all invisible, treat as leaf
  if ('children' in node && node.children.length === 0) {
    return true;
  }

  // If it's a group or frame with visual effects, treat as leaf (export flattened)
  if ((node.type === 'GROUP' || node.type === 'FRAME') && hasVisualEffects(node)) {
    return true;
  }

  return false;
}

// Recursively collect layers - either leaf nodes or containers with visual effects
function collectLayers(node: SceneNode, layers: SceneNode[], depth = 0): void {
  if (isLeafNode(node)) {
    // This is a leaf node or a group with effects, export it
    layers.push(node);
  } else if ('children' in node) {
    // This is a plain container, recurse into children
    for (const child of node.children) {
      collectLayers(child, layers, depth + 1);
    }
  }
}

// Get absolute position of a node relative to the frame
function getAbsolutePosition(node: SceneNode, frame: FrameNode | ComponentNode): { x: number; y: number } {
  let x = node.x;
  let y = node.y;
  let current = node.parent;

  while (current && current !== frame) {
    if ('x' in current && 'y' in current) {
      x += current.x;
      y += current.y;
    }
    current = current.parent;
  }

  return { x, y };
}

// Extract text content and properties from text nodes
async function extractText(node: SceneNode): Promise<string | undefined> {
  if (node.type === 'TEXT') {
    try {
      await figma.loadFontAsync(node.fontName as FontName);
      return node.characters;
    } catch (error) {
      console.error('Error loading font:', error);
      return node.characters;
    }
  }
  return undefined;
}

// Extract text-specific properties
function extractTextProperties(node: SceneNode): {
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number | { value: number; unit: string };
} | undefined {
  if (node.type !== 'TEXT') return undefined;

  const textNode = node as TextNode;
  const props: {
    textAlignHorizontal?: string;
    textAlignVertical?: string;
    fontSize?: number;
    fontFamily?: string;
    lineHeight?: number | { value: number; unit: string };
  } = {};

  props.textAlignHorizontal = textNode.textAlignHorizontal;
  props.textAlignVertical = textNode.textAlignVertical;

  // Handle fontSize (can be mixed)
  if (textNode.fontSize !== figma.mixed) {
    props.fontSize = textNode.fontSize as number;
  }

  // Handle fontFamily (can be mixed)
  if (textNode.fontName !== figma.mixed) {
    const fontName = textNode.fontName as FontName;
    props.fontFamily = fontName.family;
  }

  // Handle lineHeight (can be mixed)
  if (textNode.lineHeight !== figma.mixed) {
    const lineHeight = textNode.lineHeight;
    if (typeof lineHeight === 'object' && 'unit' in lineHeight) {
      if (lineHeight.unit === 'AUTO') {
        props.lineHeight = { value: 0, unit: 'AUTO' };
      } else {
        props.lineHeight = {
          value: lineHeight.value,
          unit: lineHeight.unit
        };
      }
    }
  }

  return props;
}

// Helper to convert RGB to hex
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

// Extract fill information
function extractFills(node: SceneNode): Array<{ type: string; color?: string; opacity?: number }> | undefined {
  if (!('fills' in node) || node.fills === figma.mixed) return undefined;

  const fills = node.fills as readonly Paint[];
  if (!fills || fills.length === 0) return undefined;

  return fills
    .filter(fill => fill.visible !== false)
    .map(fill => {
      const fillData: { type: string; color?: string; opacity?: number } = {
        type: fill.type
      };

      if (fill.type === 'SOLID') {
        const solidFill = fill as SolidPaint;
        fillData.color = rgbToHex(solidFill.color.r, solidFill.color.g, solidFill.color.b);
        fillData.opacity = solidFill.opacity ?? 1;
      }

      return fillData;
    });
}

// Extract stroke information
function extractStrokes(node: SceneNode): Array<{ type: string; color?: string; opacity?: number }> | undefined {
  if (!('strokes' in node)) return undefined;

  const strokes = node.strokes;
  if (!strokes || !Array.isArray(strokes) || strokes.length === 0) return undefined;

  return strokes
    .filter(stroke => stroke.visible !== false)
    .map(stroke => {
      const strokeData: { type: string; color?: string; opacity?: number } = {
        type: stroke.type
      };

      if (stroke.type === 'SOLID') {
        const solidStroke = stroke as SolidPaint;
        strokeData.color = rgbToHex(solidStroke.color.r, solidStroke.color.g, solidStroke.color.b);
        strokeData.opacity = solidStroke.opacity ?? 1;
      }

      return strokeData;
    });
}

// Extract effects information
function extractEffects(node: SceneNode): Array<{ type: string; visible: boolean }> | undefined {
  if (!('effects' in node)) return undefined;

  const effects = node.effects;
  if (!effects || effects.length === 0) return undefined;

  return effects.map(effect => ({
    type: effect.type,
    visible: effect.visible
  }));
}

// Extract corner radius
function extractCornerRadius(node: SceneNode): number | { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number } | undefined {
  if (!('cornerRadius' in node)) return undefined;

  const radius = node.cornerRadius;
  if (typeof radius === 'number') {
    return radius;
  }

  // Individual corner radii
  if ('topLeftRadius' in node && 'topRightRadius' in node && 'bottomLeftRadius' in node && 'bottomRightRadius' in node) {
    return {
      topLeft: node.topLeftRadius as number,
      topRight: node.topRightRadius as number,
      bottomLeft: node.bottomLeftRadius as number,
      bottomRight: node.bottomRightRadius as number
    };
  }

  return undefined;
}

// Extract constraints
function extractConstraints(node: SceneNode): { horizontal: string; vertical: string } | undefined {
  if (!('constraints' in node)) return undefined;

  return {
    horizontal: node.constraints.horizontal,
    vertical: node.constraints.vertical
  };
}

// Check if a layer has an image fill
function hasImageFill(node: SceneNode): boolean {
  if (!('fills' in node) || node.fills === figma.mixed) return false;

  const fills = node.fills as readonly Paint[];
  if (!fills || fills.length === 0) return false;

  return fills.some(fill => fill.type === 'IMAGE' && fill.visible !== false);
}

// Export a single frame
async function exportFrame(frame: FrameNode | ComponentNode, frameIndex: number, totalFrames: number, format: string, scale: number, workflowFrameId?: string): Promise<void> {
  figma.ui.postMessage({
    type: 'progress',
    message: `Exporting frame ${frameIndex + 1} of ${totalFrames}: ${frame.name}`
  });

  // Build metadata and export promises
  const layers: LayerData[] = [];
  const exportPromises: Promise<{ filename: string; data: string }>[] = [];

  // FIRST: Export the frame itself as layer 0 (base layer) - WITHOUT children
  const frameFills = extractFills(frame);
  const frameStrokes = extractStrokes(frame);
  const frameEffects = extractEffects(frame);
  const frameCornerRadius = extractCornerRadius(frame);

  // Build frame metadata (positioned at 0,0 since it's the base)
  const frameLayerData: LayerData = {
    id: frame.id,
    name: frame.name + '_base',
    type: frame.type,
    x: 0,
    y: 0,
    width: Math.round(frame.width * 100) / 100,
    height: Math.round(frame.height * 100) / 100,
    z: 0, // Frame is always layer 0
    visible: true
  };

  // Add optional frame properties
  if ('opacity' in frame && frame.opacity !== 1) {
    frameLayerData.opacity = Math.round(frame.opacity * 100) / 100;
  }

  if ('blendMode' in frame && frame.blendMode !== 'NORMAL' && frame.blendMode !== 'PASS_THROUGH') {
    frameLayerData.blendMode = frame.blendMode;
  }

  if (frameFills && frameFills.length > 0) frameLayerData.fills = frameFills;
  if (frameStrokes && frameStrokes.length > 0) frameLayerData.strokes = frameStrokes;
  if (frameEffects && frameEffects.length > 0) frameLayerData.effects = frameEffects;
  if (frameCornerRadius !== undefined) frameLayerData.cornerRadius = frameCornerRadius;

  layers.push(frameLayerData);

  // Export frame WITHOUT children: Clone frame, remove children, export, then delete clone
  // Create a temporary rectangle with the same visual properties as the frame
  const tempRect = figma.createRectangle();
  tempRect.x = frame.x;
  tempRect.y = frame.y;
  tempRect.resize(frame.width, frame.height);

  // Copy visual properties from frame to rectangle
  if ('fills' in frame) tempRect.fills = frame.fills as readonly Paint[];
  if ('strokes' in frame) tempRect.strokes = frame.strokes;
  if ('strokeWeight' in frame) tempRect.strokeWeight = frame.strokeWeight as number;
  if ('strokeAlign' in frame) tempRect.strokeAlign = frame.strokeAlign as 'INSIDE' | 'OUTSIDE' | 'CENTER';
  if ('effects' in frame) tempRect.effects = frame.effects;
  if ('opacity' in frame) tempRect.opacity = frame.opacity;
  if ('blendMode' in frame) tempRect.blendMode = frame.blendMode as BlendMode;
  if ('cornerRadius' in frame) {
    const radius = frame.cornerRadius;
    if (typeof radius === 'number') {
      tempRect.cornerRadius = radius;
    } else if ('topLeftRadius' in frame) {
      tempRect.topLeftRadius = frame.topLeftRadius as number;
      tempRect.topRightRadius = frame.topRightRadius as number;
      tempRect.bottomLeftRadius = frame.bottomLeftRadius as number;
      tempRect.bottomRightRadius = frame.bottomRightRadius as number;
    }
  }

  // Export the temporary rectangle (frame background only)
  const frameBaseName = frame.name + '_base';
  if (format === 'svg') {
    exportPromises.push(
      tempRect.exportAsync({ format: 'SVG' })
        .then(bytes => {
          tempRect.remove(); // Clean up temp node
          return {
            filename: createFilename(frameBaseName, frame.id).replace('.png', '.svg'),
            data: figma.base64Encode(bytes)
          };
        })
        .catch(error => {
          tempRect.remove(); // Clean up on error too
          throw error;
        })
    );
  } else {
    exportPromises.push(
      tempRect.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } })
        .then(bytes => {
          tempRect.remove(); // Clean up temp node
          return {
            filename: createFilename(frameBaseName, frame.id),
            data: figma.base64Encode(bytes)
          };
        })
        .catch(error => {
          tempRect.remove(); // Clean up on error too
          throw error;
        })
    );
  }

  // SECOND: Collect and export all child layers (starting at z-index 1)
  const allLayers: SceneNode[] = [];
  if ('children' in frame) {
    for (const child of frame.children) {
      collectLayers(child, allLayers);
    }
  }

  for (let i = 0; i < allLayers.length; i++) {
    const layer = allLayers[i];
    const pos = getAbsolutePosition(layer, frame);
    const text = await extractText(layer);
    const textProps = extractTextProperties(layer);
    const fills = extractFills(layer);
    const strokes = extractStrokes(layer);
    const effects = extractEffects(layer);
    const cornerRadius = extractCornerRadius(layer);
    const constraints = extractConstraints(layer);

    // Get the actual render bounds (includes effects, strokes, etc.)
    // This is what will actually be in the exported image
    let exportBounds = null;
    if ('absoluteRenderBounds' in layer && layer.absoluteRenderBounds) {
      const renderBounds = layer.absoluteRenderBounds;
      const frameAbsoluteBounds = frame.absoluteBoundingBox;

      if (frameAbsoluteBounds) {
        // Calculate position relative to frame
        exportBounds = {
          x: renderBounds.x - frameAbsoluteBounds.x,
          y: renderBounds.y - frameAbsoluteBounds.y,
          width: renderBounds.width,
          height: renderBounds.height
        };
      }
    }

    // Build layer metadata with all available properties
    const layerData: LayerData = {
      id: layer.id,
      name: layer.name,
      type: layer.type,
      x: Math.round(pos.x * 100) / 100,
      y: Math.round(pos.y * 100) / 100,
      width: Math.round(layer.width * 100) / 100,
      height: Math.round(layer.height * 100) / 100,
      z: i + 1, // Child layers start at z-index 1
      visible: layer.visible
    };

    // Add export bounds if different from node bounds
    if (exportBounds) {
      layerData.exportX = Math.round(exportBounds.x * 100) / 100;
      layerData.exportY = Math.round(exportBounds.y * 100) / 100;
      layerData.exportWidth = Math.round(exportBounds.width * 100) / 100;
      layerData.exportHeight = Math.round(exportBounds.height * 100) / 100;
    }

    // Add optional properties
    if ('opacity' in layer && layer.opacity !== 1) {
      layerData.opacity = Math.round(layer.opacity * 100) / 100;
    }

    if ('blendMode' in layer && layer.blendMode !== 'NORMAL' && layer.blendMode !== 'PASS_THROUGH') {
      layerData.blendMode = layer.blendMode;
    }

    if ('rotation' in layer && layer.rotation !== 0) {
      layerData.rotation = Math.round(layer.rotation * 100) / 100;
    }

    if (text) layerData.text = text;
    if (textProps) {
      if (textProps.textAlignHorizontal) layerData.textAlignHorizontal = textProps.textAlignHorizontal;
      if (textProps.textAlignVertical) layerData.textAlignVertical = textProps.textAlignVertical;
      if (textProps.fontSize) layerData.fontSize = textProps.fontSize;
      if (textProps.fontFamily) layerData.fontFamily = textProps.fontFamily;
      if (textProps.lineHeight) layerData.lineHeight = textProps.lineHeight;
    }
    if (fills && fills.length > 0) layerData.fills = fills;
    if (strokes && strokes.length > 0) layerData.strokes = strokes;
    if (effects && effects.length > 0) layerData.effects = effects;
    if (cornerRadius !== undefined) layerData.cornerRadius = cornerRadius;
    if (constraints) layerData.constraints = constraints;

    layers.push(layerData);

    // Export layer based on selected format
    // The exported image bounds will match absoluteRenderBounds
    if (format === 'svg') {
      exportPromises.push(
        layer.exportAsync({ format: 'SVG' })
          .then(bytes => ({
            filename: createFilename(layer.name, layer.id).replace('.png', '.svg'),
            data: figma.base64Encode(bytes)
          }))
      );
    } else {
      // Export as PNG at the selected scale
      exportPromises.push(
        layer.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } })
          .then(bytes => ({
            filename: createFilename(layer.name, layer.id),
            data: figma.base64Encode(bytes)
          }))
      );
    }
  }

  // Wait for all exports to complete
  const exportedLayers = await Promise.all(exportPromises);

  // Create metadata object
  const meta: ExportData = {
    component: {
      id: frame.id,
      name: frame.name,
      width: Math.round(frame.width * 100) / 100,
      height: Math.round(frame.height * 100) / 100
    },
    layers,
    scale
  };

  // Retrieve AI prompt if it exists (from generated variants)
  const aiPromptTheme = frame.getPluginData('aiPromptTheme');
  const aiPromptInstructions = frame.getPluginData('aiPromptInstructions');

  // Send data to UI for ZIP creation
  figma.ui.postMessage({
    type: 'export-data',
    folderName: createFolderName(frame.name),
    meta,
    layers: exportedLayers,
    frameIndex,
    totalFrames,
    format,
    aiPromptTheme: aiPromptTheme || undefined,
    aiPromptInstructions: aiPromptInstructions || undefined,
    workflowFrameId: workflowFrameId || undefined  // Mark as workflow export if provided
  });
}

// ============================================
// AI Layer Renaming Functions
// ============================================

// Export layer images for AI renaming (at 1x scale for efficient processing)
async function exportLayersForRenaming(frame: FrameNode | ComponentNode): Promise<{
  frameId: string;
  frameName: string;
  layers: Array<{ id: string; name: string; type: string; imageData: string }>;
}> {
  const allLayers: SceneNode[] = [];
  if ('children' in frame) {
    for (const child of frame.children) {
      collectLayers(child, allLayers);
    }
  }

  // Warn if frame has more than 100 layers (will be skipped by AI)
  if (allLayers.length > 100) {
    figma.ui.postMessage({
      type: 'progress',
      message: `⚠️  Frame "${frame.name}" has ${allLayers.length} layers (max 100) - will be skipped during AI rename`
    });
    console.log(`[Plugin] Frame "${frame.name}" has ${allLayers.length} layers - exceeds 100 layer limit`);
  }

  // Show initial progress
  figma.ui.postMessage({
    type: 'progress',
    message: `Exporting ${allLayers.length} layers in parallel...`
  });

  // Export all layers in parallel for much faster processing
  const exportPromises = allLayers.map(async (layer, index) => {
    try {
      const bytes = await layer.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 1 }
      });

      // Update progress periodically (every 10 layers)
      if (index % 10 === 0) {
        figma.ui.postMessage({
          type: 'progress',
          message: `Exported ${index + 1}/${allLayers.length} layers...`
        });
      }

      return {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        imageData: figma.base64Encode(bytes)
      };
    } catch (error) {
      console.error(`Failed to export layer ${layer.name}:`, error);
      // Still include the layer but without image data
      return {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        imageData: ''
      };
    }
  });

  // Wait for all exports to complete in parallel
  const layerExports = await Promise.all(exportPromises);

  figma.ui.postMessage({
    type: 'progress',
    message: `✅ Exported ${layerExports.length} layers`
  });

  return {
    frameId: frame.id,
    frameName: frame.name,
    layers: layerExports
  };
}

// Apply AI-generated names to layers in Figma
async function applyLayerRenames(renames: Array<{ id: string; newName: string }>): Promise<void> {
  console.log('[Plugin] applyLayerRenames called with', renames.length, 'renames');
  let successCount = 0;
  let failCount = 0;

  for (const rename of renames) {
    try {
      console.log('[Plugin] Looking for node:', rename.id, '-> new name:', rename.newName);

      // Use getNodeByIdAsync (required for dynamic-page document access)
      const node = await figma.getNodeByIdAsync(rename.id);

      if (!node) {
        console.warn(`[Plugin] Node ${rename.id} not found via getNodeByIdAsync`);
        failCount++;
        continue;
      }

      console.log('[Plugin] Node found:', node.type, 'current name:', 'name' in node ? node.name : 'N/A');

      if ('name' in node) {
        const oldName = node.name;
        node.name = rename.newName;

        // Verify the rename worked
        const verifyName = node.name;
        console.log('[Plugin] Renamed:', oldName, '->', rename.newName, '| Verified:', verifyName);

        if (verifyName === rename.newName) {
          successCount++;
          figma.notify(`Renamed: ${oldName} → ${rename.newName}`, { timeout: 1000 });
        } else {
          console.error('[Plugin] Rename verification failed! Expected:', rename.newName, 'Got:', verifyName);
          failCount++;
        }
      } else {
        console.warn(`[Plugin] Node ${rename.id} does not have a name property`);
        failCount++;
      }
    } catch (error) {
      console.error(`[Plugin] Error processing node ${rename.id}:`, error);
      failCount++;
    }
  }

  console.log('[Plugin] Rename complete. Success:', successCount, 'Fail:', failCount);
  figma.notify(`Renamed ${successCount} of ${renames.length} layers`, { timeout: 3000 });

  figma.ui.postMessage({
    type: 'renames-applied',
    successCount,
    failCount,
    totalCount: renames.length
  });
}

// Duplicate the selected frame 5 times and export all 6 versions
async function duplicateFrameAndExport(
  originalFrame: FrameNode | ComponentNode,
  format: string,
  scale: number
): Promise<void> {
  const framesToExport: (FrameNode | ComponentNode)[] = [originalFrame];
  const originalName = originalFrame.name;

  figma.ui.postMessage({
    type: 'progress',
    message: 'Creating frame duplicates...'
  });

  // Create 5 duplicates with numbered suffixes
  for (let i = 1; i <= 5; i++) {
    const clone = originalFrame.clone();
    clone.name = `${originalName}_${i}`;
    // Position clones to the right of the original with 50px gap
    clone.x = originalFrame.x + (originalFrame.width + 50) * i;
    framesToExport.push(clone as FrameNode | ComponentNode);
  }

  figma.ui.postMessage({
    type: 'progress',
    message: `Created 5 duplicates. Exporting ${framesToExport.length} frames...`
  });

  // Export all 6 frames
  const totalFrames = framesToExport.length;
  for (let i = 0; i < totalFrames; i++) {
    await exportFrame(framesToExport[i], i, totalFrames, format, scale);
  }

  figma.ui.postMessage({
    type: 'all-exports-complete'
  });
}

// ============================================
// Generate Edits Functions
// ============================================

// Extract simplified metadata for AI processing (without images)
async function extractLayerMetadataForEdits(
  frame: FrameNode | ComponentNode
): Promise<LayerMetadataForAI[]> {
  const metadata: LayerMetadataForAI[] = [];

  // FIRST: Include the frame itself as "frame_background" so AI can change its color
  const frameFills = extractFills(frame);
  const frameStrokes = extractStrokes(frame);
  metadata.push({
    name: 'frame_background',
    type: 'FRAME_BACKGROUND',
    x: 0,
    y: 0,
    width: Math.round(frame.width * 100) / 100,
    height: Math.round(frame.height * 100) / 100,
    fills: frameFills,
    strokes: frameStrokes,
    opacity: frame.opacity,
    cornerRadius: extractCornerRadius(frame)
  });

  // SECOND: Collect all child layers
  const allLayers: SceneNode[] = [];
  if ('children' in frame) {
    for (const child of frame.children) {
      collectLayers(child, allLayers);
    }
  }

  for (const layer of allLayers) {
    const pos = getAbsolutePosition(layer, frame);
    const fills = extractFills(layer);
    const strokes = extractStrokes(layer);
    const text = await extractText(layer);
    const textProps = extractTextProperties(layer);

    const layerHasImage = hasImageFill(layer);
    metadata.push({
      name: layer.name,
      type: layer.type,
      x: Math.round(pos.x * 100) / 100,
      y: Math.round(pos.y * 100) / 100,
      width: Math.round(layer.width * 100) / 100,
      height: Math.round(layer.height * 100) / 100,
      fills: fills,
      strokes: strokes,
      opacity: 'opacity' in layer ? layer.opacity : 1,
      text: text || undefined,
      fontSize: textProps?.fontSize,
      cornerRadius: extractCornerRadius(layer),
      hasImageFill: layerHasImage || undefined
    });
  }

  return metadata;
}

// Find a layer node by name within a frame
// Special case: "frame_background" returns the frame itself
function findLayerByName(
  frame: FrameNode | ComponentNode,
  targetName: string
): SceneNode | FrameNode | ComponentNode | null {
  // Special case: return the frame itself for background changes
  if (targetName === 'frame_background') {
    return frame;
  }

  const allLayers: SceneNode[] = [];
  if ('children' in frame) {
    for (const child of frame.children) {
      collectLayers(child, allLayers);
    }
  }

  return allLayers.find(layer => layer.name === targetName) || null;
}

// Helper to convert hex to RGB for Figma
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : null;
}

// Helper to get parent's absolute position relative to frame
function getParentOffset(node: SceneNode, frame: FrameNode | ComponentNode): { x: number; y: number } {
  let x = 0, y = 0;
  let current = node.parent;

  while (current && current !== frame) {
    if ('x' in current && 'y' in current) {
      x += current.x;
      y += current.y;
    }
    current = current.parent;
  }

  return { x, y };
}

// ============================================
// Edit Instruction Executors
// ============================================

// Execute a single edit instruction on a frame
async function executeEditInstruction(
  frame: FrameNode | ComponentNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  const layer = findLayerByName(frame, instruction.target);

  if (!layer) {
    return { success: false, error: `Layer not found: ${instruction.target}` };
  }

  try {
    switch (instruction.action) {
      case 'move':
        return executeMove(layer, instruction, frame);
      case 'changeFill':
        return executeChangeFill(layer, instruction);
      case 'changeStroke':
        return executeChangeStroke(layer, instruction);
      case 'changeText':
        return await executeChangeText(layer, instruction);
      case 'resize':
        return executeResize(layer, instruction);
      case 'changeOpacity':
        return executeChangeOpacity(layer, instruction);
      case 'reorder':
        return executeReorder(layer, instruction);
      case 'changeFont':
        return await executeChangeFont(layer, instruction);
      case 'changeFontSize':
        return await executeChangeFontSize(layer, instruction);
      case 'hide':
        return executeHide(layer, instruction);
      // New actions
      case 'changeCornerRadius':
        return executeChangeCornerRadius(layer, instruction);
      case 'changeTextAlign':
        return await executeChangeTextAlign(layer, instruction);
      case 'rotate':
        return executeRotate(layer, instruction);
      case 'addShadow':
        return executeAddShadow(layer, instruction);
      case 'removeShadow':
        return executeRemoveShadow(layer, instruction);
      case 'addBlur':
        return executeAddBlur(layer, instruction);
      case 'duplicate':
        return executeDuplicate(layer, instruction, frame);
      case 'delete':
        return executeDelete(layer, instruction);
      case 'alignTo':
        return executeAlignTo(layer, instruction, frame);
      case 'changeLineHeight':
        return await executeChangeLineHeight(layer, instruction);
      case 'changeLetterSpacing':
        return await executeChangeLetterSpacing(layer, instruction);
      case 'flipHorizontal':
        return executeFlipHorizontal(layer, instruction);
      case 'flipVertical':
        return executeFlipVertical(layer, instruction);
      case 'changeBlendMode':
        return executeChangeBlendMode(layer, instruction);
      case 'addGradient':
        return executeAddGradient(layer, instruction);
      case 'changeTextCase':
        return await executeChangeTextCase(layer, instruction);
      case 'addInnerShadow':
        return executeAddInnerShadow(layer, instruction);
      case 'addBackgroundBlur':
        return executeAddBackgroundBlur(layer, instruction);
      case 'show':
        return executeShow(layer, instruction);
      case 'removeFill':
        return executeRemoveFill(layer, instruction);
      case 'addStroke':
        return executeAddStroke(layer, instruction);
      case 'removeStroke':
        return executeRemoveStroke(layer, instruction);
      case 'generateImage':
        return executeGenerateImage(layer, instruction);
      default:
        return { success: false, error: `Unknown action: ${instruction.action}` };
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// Move layer to new position
function executeMove(
  layer: SceneNode,
  instruction: EditInstruction,
  frame: FrameNode | ComponentNode
): { success: boolean; error?: string } {
  if (!('x' in layer) || !('y' in layer)) {
    return { success: false, error: 'Layer cannot be moved' };
  }

  if (instruction.x === undefined || instruction.y === undefined) {
    return { success: false, error: 'Move requires x and y coordinates' };
  }

  if (instruction.relative) {
    layer.x += instruction.x;
    layer.y += instruction.y;
  } else {
    // Convert absolute frame coordinates to local coordinates
    const parentOffset = getParentOffset(layer, frame);
    layer.x = instruction.x - parentOffset.x;
    layer.y = instruction.y - parentOffset.y;
  }

  return { success: true };
}

// Change fill color
function executeChangeFill(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('fills' in layer)) {
    return { success: false, error: 'Layer does not support fills' };
  }

  if (!instruction.color) {
    return { success: false, error: 'changeFill requires color' };
  }

  const rgb = hexToRgb(instruction.color);
  if (!rgb) {
    return { success: false, error: `Invalid color: ${instruction.color}` };
  }

  const newFill: SolidPaint = {
    type: 'SOLID',
    color: { r: rgb.r, g: rgb.g, b: rgb.b },
    opacity: instruction.opacity ?? 1
  };

  (layer as GeometryMixin).fills = [newFill];
  return { success: true };
}

// Change stroke
function executeChangeStroke(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('strokes' in layer)) {
    return { success: false, error: 'Layer does not support strokes' };
  }

  if (!instruction.color) {
    return { success: false, error: 'changeStroke requires color' };
  }

  const rgb = hexToRgb(instruction.color);
  if (!rgb) {
    return { success: false, error: `Invalid color: ${instruction.color}` };
  }

  const newStroke: SolidPaint = {
    type: 'SOLID',
    color: { r: rgb.r, g: rgb.g, b: rgb.b },
    opacity: instruction.opacity ?? 1
  };

  (layer as GeometryMixin).strokes = [newStroke];

  if (instruction.weight !== undefined && 'strokeWeight' in layer) {
    (layer as GeometryMixin).strokeWeight = instruction.weight;
  }

  return { success: true };
}

// Change text content
async function executeChangeText(
  layer: SceneNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  if (layer.type !== 'TEXT') {
    return { success: false, error: 'Layer is not a text node' };
  }

  if (!instruction.content) {
    return { success: false, error: 'changeText requires content' };
  }

  const textNode = layer as TextNode;

  try {
    // Load the font before modifying text
    const fontName = textNode.fontName;
    if (fontName !== figma.mixed) {
      await figma.loadFontAsync(fontName);
    } else {
      // For mixed fonts, try to load the first character's font
      const firstFont = textNode.getRangeFontName(0, 1);
      if (firstFont !== figma.mixed) {
        await figma.loadFontAsync(firstFont);
      }
    }
    textNode.characters = instruction.content;
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to change text: ${(error as Error).message}` };
  }
}

// Resize layer
function executeResize(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('resize' in layer)) {
    return { success: false, error: 'Layer cannot be resized' };
  }

  const resizable = layer as SceneNode & { resize: (width: number, height: number) => void };

  let newWidth = layer.width;
  let newHeight = layer.height;

  if (instruction.scale !== undefined) {
    newWidth = layer.width * instruction.scale;
    newHeight = layer.height * instruction.scale;
  } else {
    if (instruction.width !== undefined) newWidth = instruction.width;
    if (instruction.height !== undefined) newHeight = instruction.height;
  }

  resizable.resize(newWidth, newHeight);
  return { success: true };
}

// Change opacity
function executeChangeOpacity(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('opacity' in layer)) {
    return { success: false, error: 'Layer does not support opacity' };
  }

  if (instruction.opacity === undefined) {
    return { success: false, error: 'changeOpacity requires opacity value' };
  }

  const clampedOpacity = Math.max(0, Math.min(1, instruction.opacity));
  (layer as BlendMixin).opacity = clampedOpacity;
  return { success: true };
}

// Reorder layer (z-index)
function executeReorder(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  const parent = layer.parent;
  if (!parent || !('children' in parent)) {
    return { success: false, error: 'Cannot reorder: invalid parent' };
  }

  const children = [...parent.children];
  const currentIndex = children.indexOf(layer);
  if (currentIndex === -1) {
    return { success: false, error: 'Layer not found in parent' };
  }

  if (instruction.position === 'front') {
    // Move to front (last child = topmost in z-order)
    parent.appendChild(layer);
  } else if (instruction.position === 'back') {
    // Move to back (first child = bottommost in z-order)
    parent.insertChild(0, layer);
  } else if (typeof instruction.position === 'number') {
    const targetIndex = Math.max(0, Math.min(children.length - 1, instruction.position));
    parent.insertChild(targetIndex, layer);
  }

  return { success: true };
}

// Change font family (Google Fonts only)
async function executeChangeFont(
  layer: SceneNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  if (layer.type !== 'TEXT') {
    return { success: false, error: 'Layer is not a text node' };
  }

  const textNode = layer as TextNode;
  const fontFamily = instruction.fontFamily || 'Inter';
  const fontStyle = instruction.fontStyle || 'Regular';

  try {
    await figma.loadFontAsync({ family: fontFamily, style: fontStyle });
    textNode.fontName = { family: fontFamily, style: fontStyle };
    console.log(`  Changed font to ${fontFamily} ${fontStyle}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: `Font not available: ${fontFamily} ${fontStyle}` };
  }
}

// Change font size
async function executeChangeFontSize(
  layer: SceneNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  if (layer.type !== 'TEXT') {
    return { success: false, error: 'Layer is not a text node' };
  }
  if (!instruction.fontSize) {
    return { success: false, error: 'changeFontSize requires fontSize' };
  }

  const textNode = layer as TextNode;

  try {
    // Load current font before modifying
    const fontName = textNode.fontName;
    if (fontName !== figma.mixed) {
      await figma.loadFontAsync(fontName);
    } else {
      // For mixed fonts, load the first character's font
      const firstFont = textNode.getRangeFontName(0, 1);
      if (firstFont !== figma.mixed) {
        await figma.loadFontAsync(firstFont);
      }
    }
    textNode.fontSize = instruction.fontSize;
    console.log(`  Changed font size to ${instruction.fontSize}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to change font size: ${(error as Error).message}` };
  }
}

// Hide layer (non-destructive)
function executeHide(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if ('visible' in layer) {
    layer.visible = false;
    console.log(`  Hidden layer`);
    return { success: true };
  }
  return { success: false, error: 'Layer does not support visibility' };
}

// Change corner radius
function executeChangeCornerRadius(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('cornerRadius' in layer)) {
    return { success: false, error: 'Layer does not support corner radius' };
  }
  if (instruction.radius === undefined) {
    return { success: false, error: 'changeCornerRadius requires radius' };
  }

  const node = layer as RectangleNode | FrameNode;
  node.cornerRadius = instruction.radius;
  console.log(`  Changed corner radius to ${instruction.radius}`);
  return { success: true };
}

// Change text alignment
async function executeChangeTextAlign(
  layer: SceneNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  if (layer.type !== 'TEXT') {
    return { success: false, error: 'Layer is not a text node' };
  }
  if (!instruction.align) {
    return { success: false, error: 'changeTextAlign requires align' };
  }

  const textNode = layer as TextNode;

  // Load font before modifying
  const fontName = textNode.fontName;
  if (fontName !== figma.mixed) {
    await figma.loadFontAsync(fontName);
  }

  const alignMap: Record<string, 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = {
    'left': 'LEFT',
    'center': 'CENTER',
    'right': 'RIGHT',
    'justify': 'JUSTIFIED'
  };

  textNode.textAlignHorizontal = alignMap[instruction.align] || 'LEFT';
  console.log(`  Changed text align to ${instruction.align}`);
  return { success: true };
}

// Rotate layer
function executeRotate(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('rotation' in layer)) {
    return { success: false, error: 'Layer does not support rotation' };
  }
  if (instruction.angle === undefined) {
    return { success: false, error: 'rotate requires angle' };
  }

  layer.rotation = instruction.angle;
  console.log(`  Rotated to ${instruction.angle} degrees`);
  return { success: true };
}

// Add drop shadow
function executeAddShadow(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('effects' in layer)) {
    return { success: false, error: 'Layer does not support effects' };
  }

  const node = layer as RectangleNode | FrameNode | TextNode;
  const color = instruction.color ? hexToRgb(instruction.color) : null;
  const rgb = color ?? { r: 0, g: 0, b: 0 };

  const shadow: DropShadowEffect = {
    type: 'DROP_SHADOW',
    color: { r: rgb.r, g: rgb.g, b: rgb.b, a: instruction.opacity ?? 0.25 },
    offset: { x: instruction.shadowX ?? 0, y: instruction.shadowY ?? 4 },
    radius: instruction.blur ?? 8,
    spread: instruction.spread ?? 0,
    visible: true,
    blendMode: 'NORMAL'
  };

  // Add to existing effects
  node.effects = [...node.effects, shadow];
  console.log(`  Added drop shadow`);
  return { success: true };
}

// Remove all shadows
function executeRemoveShadow(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('effects' in layer)) {
    return { success: false, error: 'Layer does not support effects' };
  }

  const node = layer as RectangleNode | FrameNode | TextNode;
  node.effects = node.effects.filter(e => e.type !== 'DROP_SHADOW');
  console.log(`  Removed shadows`);
  return { success: true };
}

// Add blur effect
function executeAddBlur(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('effects' in layer)) {
    return { success: false, error: 'Layer does not support effects' };
  }
  if (instruction.blur === undefined) {
    return { success: false, error: 'addBlur requires blur amount' };
  }

  const node = layer as RectangleNode | FrameNode;

  // Use Effect type with LAYER_BLUR - Figma API handles the blur internally
  const blurEffect: Effect = {
    type: 'LAYER_BLUR',
    radius: instruction.blur,
    visible: true
  } as Effect;

  node.effects = [...node.effects, blurEffect];
  console.log(`  Added blur effect (${instruction.blur}px)`);
  return { success: true };
}

// Duplicate layer
function executeDuplicate(
  layer: SceneNode,
  instruction: EditInstruction,
  frame: FrameNode | ComponentNode
): { success: boolean; error?: string } {
  const clone = layer.clone();

  // Position the clone
  if ('x' in clone && 'y' in clone) {
    clone.x = (layer as SceneNode & { x: number }).x + (instruction.x ?? 20);
    clone.y = (layer as SceneNode & { y: number }).y + (instruction.y ?? 20);
  }

  // Add to frame
  frame.appendChild(clone);
  console.log(`  Duplicated layer`);
  return { success: true };
}

// Delete layer
function executeDelete(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if (layer.parent) {
    layer.remove();
    console.log(`  Deleted layer`);
    return { success: true };
  }
  return { success: false, error: 'Cannot delete layer without parent' };
}

// Align layer to frame
function executeAlignTo(
  layer: SceneNode,
  instruction: EditInstruction,
  frame: FrameNode | ComponentNode
): { success: boolean; error?: string } {
  if (!('x' in layer) || !('y' in layer) || !('width' in layer) || !('height' in layer)) {
    return { success: false, error: 'Layer does not support positioning' };
  }

  const layerNode = layer as SceneNode & { x: number; y: number; width: number; height: number };

  // Horizontal alignment
  if (instruction.horizontal === 'left') {
    layerNode.x = 0;
  } else if (instruction.horizontal === 'center') {
    layerNode.x = (frame.width - layerNode.width) / 2;
  } else if (instruction.horizontal === 'right') {
    layerNode.x = frame.width - layerNode.width;
  }

  // Vertical alignment
  if (instruction.vertical === 'top') {
    layerNode.y = 0;
  } else if (instruction.vertical === 'center') {
    layerNode.y = (frame.height - layerNode.height) / 2;
  } else if (instruction.vertical === 'bottom') {
    layerNode.y = frame.height - layerNode.height;
  }

  console.log(`  Aligned to ${instruction.horizontal || ''} ${instruction.vertical || ''}`);
  return { success: true };
}

// Change line height
async function executeChangeLineHeight(
  layer: SceneNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  if (layer.type !== 'TEXT') {
    return { success: false, error: 'Layer is not a text node' };
  }
  if (instruction.lineHeight === undefined) {
    return { success: false, error: 'changeLineHeight requires lineHeight' };
  }

  const textNode = layer as TextNode;

  // Load font before modifying
  const fontName = textNode.fontName;
  if (fontName !== figma.mixed) {
    await figma.loadFontAsync(fontName);
  }

  // Line height as percentage (1.5 = 150%)
  textNode.lineHeight = { value: instruction.lineHeight * 100, unit: 'PERCENT' };
  console.log(`  Changed line height to ${instruction.lineHeight}`);
  return { success: true };
}

// Change letter spacing
async function executeChangeLetterSpacing(
  layer: SceneNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  if (layer.type !== 'TEXT') {
    return { success: false, error: 'Layer is not a text node' };
  }
  if (instruction.letterSpacing === undefined) {
    return { success: false, error: 'changeLetterSpacing requires letterSpacing' };
  }

  const textNode = layer as TextNode;

  // Load font before modifying
  const fontName = textNode.fontName;
  if (fontName !== figma.mixed) {
    await figma.loadFontAsync(fontName);
  }

  textNode.letterSpacing = { value: instruction.letterSpacing, unit: 'PIXELS' };
  console.log(`  Changed letter spacing to ${instruction.letterSpacing}px`);
  return { success: true };
}

// Flip horizontally
function executeFlipHorizontal(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('rotation' in layer)) {
    return { success: false, error: 'Layer does not support transformation' };
  }

  // Figma doesn't have direct flip, but we can use rescale
  const node = layer as SceneNode & { rescale: (x: number, y: number) => void };
  if ('rescale' in layer) {
    node.rescale(-1, 1);
    console.log(`  Flipped horizontally`);
    return { success: true };
  }
  return { success: false, error: 'Layer does not support flip' };
}

// Flip vertically
function executeFlipVertical(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('rotation' in layer)) {
    return { success: false, error: 'Layer does not support transformation' };
  }

  const node = layer as SceneNode & { rescale: (x: number, y: number) => void };
  if ('rescale' in layer) {
    node.rescale(1, -1);
    console.log(`  Flipped vertically`);
    return { success: true };
  }
  return { success: false, error: 'Layer does not support flip' };
}

// Change blend mode
function executeChangeBlendMode(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('blendMode' in layer)) {
    return { success: false, error: 'Layer does not support blend mode' };
  }
  if (!instruction.blendMode) {
    return { success: false, error: 'changeBlendMode requires blendMode' };
  }

  const validModes: BlendMode[] = [
    'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN',
    'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT',
    'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'
  ];

  const mode = instruction.blendMode.toUpperCase().replace(' ', '_') as BlendMode;
  if (validModes.indexOf(mode) === -1) {
    return { success: false, error: `Invalid blend mode: ${instruction.blendMode}` };
  }

  (layer as SceneNode & { blendMode: BlendMode }).blendMode = mode;
  console.log(`  Changed blend mode to ${mode}`);
  return { success: true };
}

// Add gradient fill
function executeAddGradient(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('fills' in layer)) {
    return { success: false, error: 'Layer does not support fills' };
  }
  if (!instruction.colors || instruction.colors.length < 2) {
    return { success: false, error: 'addGradient requires at least 2 colors' };
  }

  const node = layer as RectangleNode | FrameNode;
  const angle = (instruction.gradientAngle ?? 0) * (Math.PI / 180);

  // Create gradient stops
  const stops: ColorStop[] = instruction.colors.map((color, index) => {
    const rgb = hexToRgb(color) ?? { r: 0, g: 0, b: 0 };
    return {
      position: index / (instruction.colors!.length - 1),
      color: { r: rgb.r, g: rgb.g, b: rgb.b, a: 1 }
    };
  });

  // Calculate transform based on angle
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const gradientFill: GradientPaint = {
    type: 'GRADIENT_LINEAR',
    gradientStops: stops,
    gradientTransform: [
      [cos, sin, 0.5 - cos * 0.5 - sin * 0.5],
      [-sin, cos, 0.5 + sin * 0.5 - cos * 0.5]
    ]
  };

  node.fills = [gradientFill];
  console.log(`  Added gradient with ${instruction.colors.length} colors`);
  return { success: true };
}

// Change text case (uppercase, lowercase, title case)
async function executeChangeTextCase(
  layer: SceneNode,
  instruction: EditInstruction
): Promise<{ success: boolean; error?: string }> {
  if (layer.type !== 'TEXT') {
    return { success: false, error: 'Layer is not a text node' };
  }
  if (!instruction.textCase) {
    return { success: false, error: 'changeTextCase requires textCase parameter' };
  }

  const textNode = layer as TextNode;

  try {
    // Load font before modifying
    const fontName = textNode.fontName;
    if (fontName !== figma.mixed) {
      await figma.loadFontAsync(fontName);
    }

    const currentText = textNode.characters;
    let newText: string;

    switch (instruction.textCase) {
      case 'upper':
        newText = currentText.toUpperCase();
        break;
      case 'lower':
        newText = currentText.toLowerCase();
        break;
      case 'title':
        newText = currentText.replace(/\w\S*/g, txt =>
          txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
        );
        break;
      default:
        newText = currentText;
    }

    textNode.characters = newText;
    console.log(`  Changed text case to ${instruction.textCase}: "${newText}"`);
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to change text case: ${(error as Error).message}` };
  }
}

// Add inner shadow (inset shadow for depth)
function executeAddInnerShadow(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('effects' in layer)) {
    return { success: false, error: 'Layer does not support effects' };
  }

  const node = layer as RectangleNode | FrameNode | TextNode;
  const color = instruction.color ? hexToRgb(instruction.color) : null;
  const rgb = color ?? { r: 0, g: 0, b: 0 };

  const innerShadow: InnerShadowEffect = {
    type: 'INNER_SHADOW',
    color: { r: rgb.r, g: rgb.g, b: rgb.b, a: instruction.opacity ?? 0.25 },
    offset: { x: instruction.shadowX ?? 0, y: instruction.shadowY ?? 2 },
    radius: instruction.blur ?? 4,
    spread: instruction.spread ?? 0,
    visible: true,
    blendMode: 'NORMAL'
  };

  node.effects = [...node.effects, innerShadow];
  console.log(`  Added inner shadow`);
  return { success: true };
}

// Add background blur (for glassmorphism effects)
function executeAddBackgroundBlur(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('effects' in layer)) {
    return { success: false, error: 'Layer does not support effects' };
  }
  if (instruction.backgroundBlur === undefined) {
    return { success: false, error: 'addBackgroundBlur requires backgroundBlur amount' };
  }

  const node = layer as FrameNode | RectangleNode;

  const bgBlur: Effect = {
    type: 'BACKGROUND_BLUR',
    radius: instruction.backgroundBlur,
    visible: true
  } as Effect;

  node.effects = [...node.effects, bgBlur];
  console.log(`  Added background blur (${instruction.backgroundBlur}px)`);
  return { success: true };
}

// Show a hidden layer (opposite of hide)
function executeShow(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if ('visible' in layer) {
    layer.visible = true;
    console.log(`  Made layer visible`);
    return { success: true };
  }
  return { success: false, error: 'Layer does not support visibility' };
}

// Remove all fills from a layer
function executeRemoveFill(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('fills' in layer)) {
    return { success: false, error: 'Layer does not support fills' };
  }

  const node = layer as RectangleNode | FrameNode | TextNode;
  node.fills = [];
  console.log(`  Removed all fills`);
  return { success: true };
}

// Add stroke to a layer
function executeAddStroke(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('strokes' in layer)) {
    return { success: false, error: 'Layer does not support strokes' };
  }
  if (!instruction.color) {
    return { success: false, error: 'addStroke requires color' };
  }

  const node = layer as RectangleNode | FrameNode | TextNode;
  const color = hexToRgb(instruction.color);
  if (!color) {
    return { success: false, error: 'Invalid color format' };
  }

  const stroke: SolidPaint = {
    type: 'SOLID',
    color: { r: color.r, g: color.g, b: color.b },
    opacity: instruction.opacity ?? 1
  };

  node.strokes = [...node.strokes, stroke];
  node.strokeWeight = instruction.weight ?? 1;
  console.log(`  Added stroke ${instruction.color}`);
  return { success: true };
}

// Remove all strokes from a layer
function executeRemoveStroke(
  layer: SceneNode,
  _instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('strokes' in layer)) {
    return { success: false, error: 'Layer does not support strokes' };
  }

  const node = layer as RectangleNode | FrameNode | TextNode;
  node.strokes = [];
  console.log(`  Removed all strokes`);
  return { success: true };
}

// Apply AI-generated image to a layer
function executeGenerateImage(
  layer: SceneNode,
  instruction: EditInstruction
): { success: boolean; error?: string } {
  if (!('fills' in layer)) {
    return { success: false, error: 'Layer does not support fills/images' };
  }

  // Check if we have the generated image data
  if (!instruction.generatedImageBase64) {
    // No image was generated - this could happen if image generation failed or was skipped
    console.log(`  generateImage: No image data available for "${instruction.target}"`);
    return { success: false, error: 'No generated image data available' };
  }

  try {
    // Convert base64 to Uint8Array using Figma's base64Decode
    // Note: figma.base64Decode is available in the plugin context
    const bytes = figma.base64Decode(instruction.generatedImageBase64);

    // Create image from bytes
    const image = figma.createImage(bytes);

    // Apply image fill to layer
    const node = layer as RectangleNode | FrameNode;
    node.fills = [{
      type: 'IMAGE',
      imageHash: image.hash,
      scaleMode: 'FILL'
    }];

    console.log(`  Applied AI-generated image to "${instruction.target}"`);
    return { success: true };
  } catch (error) {
    console.error(`  Failed to apply generated image:`, error);
    return { success: false, error: `Failed to apply generated image: ${(error as Error).message}` };
  }
}

// ============================================
// Generate Edits Orchestrator
// ============================================

// Format a single instruction into a readable prose fragment
function formatInstructionProse(instruction: EditInstruction): string {
  const { action, target, ...params } = instruction;
  const layerName = target.replace(/_/g, ' ');

  switch (action) {
    case 'changeFill':
      const opacity = params.opacity !== undefined && params.opacity !== 1
        ? ` at ${Math.round(params.opacity * 100)}% opacity` : '';
      return `changed "${layerName}" fill to ${params.color}${opacity}`;

    case 'changeStroke':
      return `updated "${layerName}" stroke to ${params.color}${params.weight ? ` (${params.weight}px)` : ''}`;

    case 'addStroke':
      return `added a ${params.color} stroke${params.weight ? ` at ${params.weight}px` : ''} to "${layerName}"`;

    case 'removeStroke':
      return `removed stroke from "${layerName}"`;

    case 'removeFill':
      return `removed fill from "${layerName}"`;

    case 'addGradient':
      return `applied a gradient (${params.colors?.join(' to ')}) to "${layerName}"`;

    case 'changeOpacity':
      return `set "${layerName}" opacity to ${Math.round((params.opacity || 0) * 100)}%`;

    case 'changeText':
      const textPreview = params.content && params.content.length > 30
        ? `"${params.content.substring(0, 30)}..."`
        : `"${params.content}"`;
      return `changed "${layerName}" text to ${textPreview}`;

    case 'changeFont':
      return `changed "${layerName}" font to ${params.fontFamily}${params.fontStyle ? ` ${params.fontStyle}` : ''}`;

    case 'changeFontSize':
      return `resized "${layerName}" text to ${params.fontSize}px`;

    case 'changeTextAlign':
      return `aligned "${layerName}" text to ${params.align}`;

    case 'changeTextCase':
      return `transformed "${layerName}" to ${params.textCase}case`;

    case 'changeLineHeight':
      return `adjusted "${layerName}" line height to ${params.lineHeight}`;

    case 'changeLetterSpacing':
      return `set "${layerName}" letter spacing to ${params.letterSpacing}px`;

    case 'move':
      return `repositioned "${layerName}" to (${params.x}, ${params.y})`;

    case 'resize':
      if (params.scale) {
        return `scaled "${layerName}" by ${params.scale}x`;
      }
      return `resized "${layerName}" to ${params.width}×${params.height}`;

    case 'alignTo':
      const alignParts = [];
      if (params.horizontal) alignParts.push(params.horizontal);
      if (params.vertical) alignParts.push(params.vertical);
      return `aligned "${layerName}" to ${alignParts.join(' ')}`;

    case 'rotate':
      return `rotated "${layerName}" by ${params.angle}°`;

    case 'changeCornerRadius':
      return `set "${layerName}" corner radius to ${params.radius}px`;

    case 'addShadow':
      return `added shadow to "${layerName}" (blur: ${params.blur}px)`;

    case 'addInnerShadow':
      return `added inner shadow to "${layerName}"`;

    case 'removeShadow':
      return `removed shadow from "${layerName}"`;

    case 'addBlur':
      return `applied ${params.blur}px blur to "${layerName}"`;

    case 'addBackgroundBlur':
      return `added glassmorphism effect to "${layerName}" (${params.backgroundBlur}px blur)`;

    case 'changeBlendMode':
      return `changed "${layerName}" blend mode to ${params.blendMode}`;

    case 'hide':
      return `hidden "${layerName}"`;

    case 'show':
      return `revealed "${layerName}"`;

    case 'delete':
      return `removed "${layerName}"`;

    case 'duplicate':
      return `duplicated "${layerName}"`;

    case 'reorder':
      return `moved "${layerName}" to ${params.position}`;

    case 'flipHorizontal':
      return `flipped "${layerName}" horizontally`;

    case 'flipVertical':
      return `flipped "${layerName}" vertically`;

    case 'generateImage':
      const promptPreview = params.imagePrompt && params.imagePrompt.length > 40
        ? params.imagePrompt.substring(0, 40) + '...'
        : params.imagePrompt;
      return `generated new image for "${layerName}": ${promptPreview}`;

    default:
      return `applied ${action} to "${layerName}"`;
  }
}

// Format all instructions into a readable paragraph
function formatInstructionsAsParagraph(instructions: EditInstruction[]): string {
  if (instructions.length === 0) return 'No changes applied.';

  const phrases = instructions.map(inst => formatInstructionProse(inst));

  // Join with commas and 'and' for the last item
  if (phrases.length === 1) {
    return phrases[0].charAt(0).toUpperCase() + phrases[0].slice(1) + '.';
  }

  const allButLast = phrases.slice(0, -1).join(', ');
  const last = phrases[phrases.length - 1];

  return allButLast.charAt(0).toUpperCase() + allButLast.slice(1) + ', and ' + last + '.';
}

// Helper to create a styled label card to the left of a frame with 100px gap
async function createPromptLabel(
  frame: FrameNode | ComponentNode,
  theme: string,
  humanPrompt: string,
  readableInstructions: string,
  instructionCount: number
): Promise<number> {
  try {
    // Load fonts - use Inter which is reliably available
    await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

    // Create a container frame for the label
    const labelFrame = figma.createFrame();
    labelFrame.name = `${frame.name}_prompt_card`;

    // Set up auto-layout for padding
    labelFrame.layoutMode = 'VERTICAL';
    labelFrame.primaryAxisSizingMode = 'AUTO';
    labelFrame.counterAxisSizingMode = 'FIXED';
    labelFrame.resize(Math.min(frame.width, 1080), 100); // Max width 1080 for readability
    labelFrame.paddingTop = 24;
    labelFrame.paddingBottom = 24;
    labelFrame.paddingLeft = 28;
    labelFrame.paddingRight = 28;
    labelFrame.itemSpacing = 16;

    // White background
    labelFrame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];

    // Border (stroke)
    labelFrame.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
    labelFrame.strokeWeight = 1;

    // Rounded corners
    labelFrame.cornerRadius = 12;

    // Add subtle shadow for depth
    labelFrame.effects = [{
      type: 'DROP_SHADOW',
      color: { r: 0, g: 0, b: 0, a: 0.08 },
      offset: { x: 0, y: 4 },
      radius: 12,
      spread: 0,
      visible: true,
      blendMode: 'NORMAL'
    }];

    // Create theme title
    const themeText = figma.createText();
    themeText.fontName = { family: 'Inter', style: 'Bold' };
    themeText.characters = theme;
    themeText.fontSize = 22;
    themeText.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
    themeText.layoutAlign = 'STRETCH';
    themeText.textAutoResize = 'HEIGHT';

    // Create AI summary (humanPrompt)
    const summaryText = figma.createText();
    summaryText.fontName = { family: 'Inter', style: 'Medium' };
    summaryText.characters = humanPrompt;
    summaryText.fontSize = 15;
    summaryText.fills = [{ type: 'SOLID', color: { r: 0.25, g: 0.25, b: 0.25 } }];
    summaryText.layoutAlign = 'STRETCH';
    summaryText.textAutoResize = 'HEIGHT';
    summaryText.lineHeight = { value: 150, unit: 'PERCENT' };

    // Create a divider line
    const divider = figma.createFrame();
    divider.name = 'divider';
    divider.resize(labelFrame.width - 56, 1);
    divider.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
    divider.layoutAlign = 'STRETCH';

    // Create changes label
    const changesLabel = figma.createText();
    changesLabel.fontName = { family: 'Inter', style: 'Bold' };
    changesLabel.characters = `${instructionCount} Changes Applied`;
    changesLabel.fontSize = 12;
    changesLabel.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }];
    changesLabel.layoutAlign = 'STRETCH';
    changesLabel.textAutoResize = 'HEIGHT';
    changesLabel.letterSpacing = { value: 0.5, unit: 'PIXELS' };

    // Create instructions paragraph (human-readable from AI)
    const instructionsText = figma.createText();
    instructionsText.fontName = { family: 'Inter', style: 'Regular' };
    instructionsText.characters = readableInstructions;
    instructionsText.fontSize = 14;
    instructionsText.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
    instructionsText.layoutAlign = 'STRETCH';
    instructionsText.textAutoResize = 'HEIGHT';
    instructionsText.lineHeight = { value: 160, unit: 'PERCENT' };

    // Add text nodes to frame
    labelFrame.appendChild(themeText);
    labelFrame.appendChild(summaryText);
    labelFrame.appendChild(divider);
    labelFrame.appendChild(changesLabel);
    labelFrame.appendChild(instructionsText);

    // Position to the left of the frame with 100px gap
    labelFrame.x = frame.x - labelFrame.width - 100; // 100px gap to the left
    labelFrame.y = frame.y; // Aligned with top of frame

    // Return the height of the label card (not used for horizontal layout)
    return labelFrame.height;
  } catch (error) {
    console.warn('Could not create prompt label:', error);
    return 0;
  }
}

// Main function to apply edit variants and create modified frames (no export)
async function applyEditVariants(
  originalFrame: FrameNode | ComponentNode,
  variants: EditVariant[]
): Promise<void> {
  const originalName = originalFrame.name;

  figma.ui.postMessage({
    type: 'progress',
    message: 'Creating frame variants with AI-generated edits...'
  });

  // Spacing configuration
  const VERTICAL_SPACING = 500; // 500px between variant frames

  // Track cumulative Y position for vertical stacking
  // Labels are now positioned to the left, so no extra vertical space needed
  let currentY = originalFrame.y + originalFrame.height + VERTICAL_SPACING;

  // Create duplicates and apply different edits to each
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];

    figma.ui.postMessage({
      type: 'progress',
      message: `Creating variant ${i + 1}/${variants.length}: ${variant.theme}...`
    });

    // Clone the frame
    const clone = originalFrame.clone();
    const themeSlug = variant.theme.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    clone.name = `${originalName}_v${i + 1}_${themeSlug}`;

    // Position vertically (same X as original, stacked below)
    clone.x = originalFrame.x;
    clone.y = currentY;

    // Apply all instructions for this variant
    let successCount = 0;
    let failCount = 0;

    for (const instruction of variant.instructions) {
      const result = await executeEditInstruction(clone as FrameNode, instruction);
      if (result.success) {
        successCount++;
      } else {
        console.warn(`[Variant ${i + 1}] Failed: ${instruction.action} on "${instruction.target}" - ${result.error}`);
        failCount++;
      }
    }

    console.log(`[Plugin] Variant ${i + 1} (${variant.theme}): Applied ${successCount}/${variant.instructions.length} edits`);

    // Create styled prompt label card to the left of the variant frame
    // Use readableInstructions from AI, fallback to formatted paragraph if not available
    const readableText = variant.readableInstructions || formatInstructionsAsParagraph(variant.instructions);

    // Store BOTH parts of the AI prompt in pluginData for later export
    clone.setPluginData('aiPromptTheme', variant.humanPrompt);
    clone.setPluginData('aiPromptInstructions', readableText);

    // Create prompt label to the left of the variant frame
    await createPromptLabel(
      clone,
      variant.theme,
      variant.humanPrompt,
      readableText,
      variant.instructions.length
    );

    // Calculate next Y position: frame height + spacing
    currentY = clone.y + clone.height + VERTICAL_SPACING;

    figma.notify(`Variant ${i + 1}: ${variant.theme} (${successCount} edits)`, { timeout: 1500 });
  }

  console.log(`[Plugin] Successfully created ${variants.length} variants for ${originalFrame.name}`);
}

// ============================================
// Message Handler
// ============================================

// ============================================
// Break Groups Apart
// ============================================

// Recursively flatten all groups in the selection
async function breakGroupsApart(): Promise<{ groupCount: number; layerCount: number }> {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return { groupCount: 0, layerCount: 0 };
  }

  let groupCount = 0;
  let layerCount = 0;
  const newSelection: SceneNode[] = [];

  // Process each selected node
  for (const node of selection) {
    if (node.type === 'GROUP') {
      const result = await flattenGroup(node);
      groupCount += result.groupCount;
      layerCount += result.layerCount;
      newSelection.push(...result.layers);
    } else {
      // Keep non-group nodes in selection
      newSelection.push(node);
    }
  }

  // Update selection to show ungrouped layers
  figma.currentPage.selection = newSelection;

  return { groupCount, layerCount };
}

// Recursively flatten a single group
async function flattenGroup(group: GroupNode): Promise<{ groupCount: number; layerCount: number; layers: SceneNode[] }> {
  let groupCount = 1; // Count this group
  let layerCount = 0;
  const flattenedLayers: SceneNode[] = [];

  // Get the parent to move children to
  const parent = group.parent;
  if (!parent || !('insertChild' in parent)) {
    return { groupCount: 0, layerCount: 0, layers: [] };
  }

  // Get the index where the group is in the parent
  const groupIndex = parent.children.indexOf(group);

  // Process children in reverse order to maintain visual stacking order
  const children = [...group.children].reverse();

  for (const child of children) {
    if (child.type === 'GROUP') {
      // Recursively flatten nested groups
      const result = await flattenGroup(child);
      groupCount += result.groupCount;
      layerCount += result.layerCount;
      flattenedLayers.push(...result.layers);
    } else {
      // Move non-group child to parent at the group's position
      parent.insertChild(groupIndex, child);
      layerCount++;
      flattenedLayers.push(child);
    }
  }

  // Remove the now-empty group
  group.remove();

  return { groupCount, layerCount, layers: flattenedLayers };
}

// ============================================
// Rasterize Selection
// ============================================

// Convert selected objects to 4x resolution raster images
async function rasterizeSelection(): Promise<number> {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return 0;
  }

  let rasterizedCount = 0;
  const newSelection: SceneNode[] = [];

  for (const node of selection) {
    // Skip nodes that can't be exported
    if (!('exportAsync' in node)) {
      continue;
    }

    try {
      // Store original properties
      const originalName = node.name;
      const originalX = node.x;
      const originalY = node.y;
      const originalWidth = node.width;
      const originalHeight = node.height;
      const parent = node.parent;

      if (!parent || !('insertChild' in parent)) {
        continue;
      }

      // Get the index of the original node
      const originalIndex = parent.children.indexOf(node);

      // Export at 4x resolution
      const imageBytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 4 }
      });

      // Create a rectangle to hold the image
      const rect = figma.createRectangle();
      rect.name = originalName;
      rect.x = originalX;
      rect.y = originalY;
      rect.resize(originalWidth, originalHeight);

      // Create image fill from exported bytes
      const image = figma.createImage(imageBytes);
      rect.fills = [{
        type: 'IMAGE',
        imageHash: image.hash,
        scaleMode: 'FILL'
      }];

      // Insert at the same position in the layer stack
      parent.insertChild(originalIndex, rect);

      // Remove the original node
      node.remove();

      newSelection.push(rect);
      rasterizedCount++;
    } catch (error) {
      console.error(`Failed to rasterize "${node.name}":`, error);
    }
  }

  // Update selection to show new rasterized layers
  figma.currentPage.selection = newSelection;

  return rasterizedCount;
}

interface PluginMessage {
  type: string;
  format?: string;
  scale?: number;
  renames?: Array<{ id: string; newName: string }>;
  variants?: EditVariant[];
  processAllFrames?: boolean;
  frameVariants?: Array<{ frameId: string; frameName: string; variants: EditVariant[] }>;
  concurrency?: number;
  userEmail?: string;
  generateImages?: boolean;
  promptFile?: string;
}

figma.ui.onmessage = async (msg: PluginMessage) => {
  console.log('[Plugin] Received message:', msg.type, JSON.stringify(msg));

  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }

  // ============================================
  // Break Groups Apart
  // ============================================
  if (msg.type === 'break-groups') {
    try {
      const result = await breakGroupsApart();
      figma.ui.postMessage({
        type: 'groups-broken',
        groupCount: result.groupCount,
        layerCount: result.layerCount
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Failed to break groups: ' + (error as Error).message
      });
    }
    return;
  }

  // ============================================
  // Rasterize Selection
  // ============================================
  if (msg.type === 'rasterize-selection') {
    try {
      const count = await rasterizeSelection();
      figma.ui.postMessage({
        type: 'rasterize-complete',
        count: count
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Failed to rasterize: ' + (error as Error).message
      });
    }
    return;
  }

  // ============================================
  // AI Rename + Export Flow (new)
  // ============================================

  // Step 1: Export layers for AI renaming
  if (msg.type === 'export-for-renaming') {
    try {
      const selection = figma.currentPage.selection;
      const frames = selection.filter(
        node => node.type === 'FRAME' || node.type === 'COMPONENT'
      ) as (FrameNode | ComponentNode)[];

      if (frames.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Please select a frame to export'
        });
        return;
      }

      // Process all selected frames for renaming in parallel
      figma.ui.postMessage({
        type: 'progress',
        message: `Extracting layers from ${frames.length} frame(s) in parallel...`
      });

      const framePromises = frames.map(async (frame, i) => {
        // Update progress periodically
        if (i % 5 === 0) {
          figma.ui.postMessage({
            type: 'progress',
            message: `Processing frame ${i + 1}/${frames.length}: ${frame.name}...`
          });
        }
        return exportLayersForRenaming(frame);
      });

      const allFrameData = await Promise.all(framePromises);

      figma.ui.postMessage({
        type: 'progress',
        message: `✅ Extracted layers from ${frames.length} frame(s)`
      });

      // Send all frames to UI for parallel processing
      figma.ui.postMessage({
        type: 'all-frames-for-renaming',
        frames: allFrameData,
        totalFrames: allFrameData.length
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Failed to export layers for renaming: ' + (error as Error).message
      });
    }
    return;
  }

  // Step 2: Apply AI-generated names to layers
  if (msg.type === 'apply-renames') {
    figma.notify('Received rename request!', { timeout: 2000 });
    console.log('[Plugin] Received apply-renames message');
    console.log('[Plugin] Renames:', JSON.stringify(msg.renames));
    if (msg.renames && msg.renames.length > 0) {
      figma.notify(`Applying ${msg.renames.length} renames...`, { timeout: 2000 });
      console.log('[Plugin] Applying', msg.renames.length, 'renames');
      await applyLayerRenames(msg.renames);
    } else {
      console.log('[Plugin] No renames to apply');
      figma.ui.postMessage({
        type: 'renames-applied',
        successCount: 0,
        failCount: 0,
        totalCount: 0
      });
    }
    return;
  }

  // Step 3: Duplicate frame and export all copies
  if (msg.type === 'duplicate-and-export') {
    try {
      const selection = figma.currentPage.selection;
      const frames = selection.filter(
        node => node.type === 'FRAME' || node.type === 'COMPONENT'
      ) as (FrameNode | ComponentNode)[];

      if (frames.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Please select a frame to export'
        });
        return;
      }

      await duplicateFrameAndExport(
        frames[0],
        msg.format || 'png',
        msg.scale || 4
      );
    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Failed to duplicate and export: ' + (error as Error).message
      });
    }
    return;
  }

  // ============================================
  // Generate Edits Flow
  // ============================================

  // Check frame count for multi-frame confirmation
  if (msg.type === 'check-frames-for-edits') {
    const selection = figma.currentPage.selection;
    const frames = selection.filter(
      node => node.type === 'FRAME' || node.type === 'COMPONENT'
    ) as (FrameNode | ComponentNode)[];

    figma.ui.postMessage({
      type: 'frames-count-for-edits',
      frameCount: frames.length
    });
    return;
  }

  // Step 1: Extract metadata for AI edit generation
  if (msg.type === 'prepare-for-edits') {
    try {
      const selection = figma.currentPage.selection;
      const frames = selection.filter(
        node => node.type === 'FRAME' || node.type === 'COMPONENT'
      ) as (FrameNode | ComponentNode)[];

      if (frames.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Please select a frame to generate edits'
        });
        return;
      }

      const processAllFrames = msg.processAllFrames === true;
      const framesToProcess = processAllFrames ? frames : [frames[0]];

      console.log(`[Plugin] Processing ${framesToProcess.length} frame(s) for edit generation`);

      // Extract metadata for each frame in parallel for faster processing
      const framePromises = framesToProcess.map(async (frame, i) => {
        // Send progress update every 5 frames
        if (i % 5 === 0) {
          figma.ui.postMessage({
            type: 'progress',
            message: `Processing frame ${i + 1}/${framesToProcess.length}: ${frame.name}...`
          });
        }

        const metadata = await extractLayerMetadataForEdits(frame);
        console.log(`[Plugin] Extracted metadata for ${metadata.length} layers from ${frame.name}`);

        // Export frame as 1x PNG for AI vision analysis
        const frameImageBytes = await frame.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: 1 }
        });
        const frameImageBase64 = figma.base64Encode(frameImageBytes);

        return {
          frameId: frame.id,
          frameName: frame.name,
          frameWidth: frame.width,
          frameHeight: frame.height,
          layers: metadata,
          frameImageBase64: frameImageBase64
        };
      });

      const allFrameData = await Promise.all(framePromises);

      // Send all frame data to UI for AI processing
      figma.ui.postMessage({
        type: 'metadata-for-edits',
        frames: allFrameData,
        totalFrames: allFrameData.length
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Failed to extract metadata: ' + (error as Error).message
      });
    }
    return;
  }

  // Step 2: Apply AI-generated edit variants to duplicated frames
  if (msg.type === 'apply-edit-variants') {
    try {
      const selection = figma.currentPage.selection;
      const frames = selection.filter(
        node => node.type === 'FRAME' || node.type === 'COMPONENT'
      ) as (FrameNode | ComponentNode)[];

      if (frames.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Please select a frame to apply edits'
        });
        return;
      }

      // Handle both single frame (old format) and multi-frame (new format)
      const frameVariants = msg.frameVariants || [{ frameId: frames[0].id, variants: msg.variants || [] }];

      if (frameVariants.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'No variants to apply'
        });
        return;
      }

      console.log(`[Plugin] Applying variants for ${frameVariants.length} frame(s)`);

      // Process each frame's variants
      for (let i = 0; i < frameVariants.length; i++) {
        const fv = frameVariants[i];

        // Find the frame by ID
        const frame = frames.find(f => f.id === fv.frameId);
        if (!frame) {
          console.warn(`[Plugin] Frame with ID ${fv.frameId} not found in selection`);
          continue;
        }

        figma.ui.postMessage({
          type: 'progress',
          message: `Applying variants ${i + 1}/${frameVariants.length}: ${frame.name}...`
        });

        await applyEditVariants(frame, fv.variants);
      }

      // Send success message
      const totalVariants = frameVariants.reduce((sum: number, fv: any) => sum + (fv.variants?.length || 0), 0);
      figma.ui.postMessage({
        type: 'variants-created',
        variantCount: totalVariants,
        frameCount: frameVariants.length
      });

      figma.notify(`Created ${totalVariants} variants for ${frameVariants.length} frame(s)! Use "Export Only" to download.`, { timeout: 4000 });

    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Failed to apply edits: ' + (error as Error).message
      });
    }
    return;
  }

  // ============================================
  // Complete Workflow: Rename → Variants → Export
  // ============================================
  if (msg.type === 'start-complete-workflow') {
    try {
      const selection = figma.currentPage.selection;
      let frames = selection.filter(
        node => node.type === 'FRAME' || node.type === 'COMPONENT'
      ) as (FrameNode | ComponentNode)[];

      if (frames.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Please select frames to process'
        });
        return;
      }

      // Sort frames numerically by extracting leading numbers from frame names
      frames = frames.sort((a, b) => {
        // Extract leading numbers from frame names
        const matchA = a.name.match(/^(\d+)/);
        const matchB = b.name.match(/^(\d+)/);

        // If both have leading numbers, compare numerically
        if (matchA && matchB) {
          return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
        }

        // If only one has leading numbers, prioritize it
        if (matchA) return -1;
        if (matchB) return 1;

        // If neither has leading numbers, sort alphabetically
        return a.name.localeCompare(b.name);
      });

      console.log(`[Workflow] Sorted ${frames.length} frames: ${frames.slice(0, 5).map(f => f.name).join(', ')}${frames.length > 5 ? '...' : ''}`);

      const concurrency = msg.concurrency || 3;  // Default to 3 parallel frames
      const userEmail = msg.userEmail || '';
      const generateImages = msg.generateImages || false;

      console.log(`[Workflow] Starting: ${frames.length} frames, concurrency ${concurrency}`);

      // Track workflow stats
      let framesCompleted = 0;
      let framesFailed = 0;
      let variantsCreated = 0;
      let zipsUploaded = 0;

      // Process a single frame through the complete pipeline
      async function processFrameComplete(frame: FrameNode | ComponentNode, frameIndex: number): Promise<void> {
        try {
          const frameName = frame.name;
          console.log(`[Workflow] Frame ${frameIndex + 1}/${frames.length}: Starting ${frameName}`);

          figma.ui.postMessage({
            type: 'workflow-progress',
            message: `[${frameIndex + 1}/${frames.length}] ${frameName}: Renaming layers...`
          });

          // STEP 1: Rename layers
          const layerData = await exportLayersForRenaming(frame);

          // Send to UI for AI rename
          figma.ui.postMessage({
            type: 'workflow-api-request',
            api: 'rename',
            frameId: frame.id,
            frameName: frameName,
            data: layerData
          });

          // Wait for rename response
          const renames = await new Promise<Array<{ id: string; newName: string }>>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Rename timeout')), 120000);

            const handler = (msg: any) => {
              if (msg.type === 'workflow-api-response' && msg.frameId === frame.id && msg.api === 'rename') {
                clearTimeout(timeout);
                figma.ui.off('message', handler);
                if (msg.error) {
                  reject(new Error(msg.error));
                } else {
                  resolve(msg.data);
                }
              }
            };

            figma.ui.on('message', handler);
          });

          // Apply renames
          await applyLayerRenames(renames);
          console.log(`[Workflow] Frame ${frameName}: Renamed ${renames.length} layers`);

          figma.ui.postMessage({
            type: 'workflow-progress',
            message: `[${frameIndex + 1}/${frames.length}] ${frameName}: Generating 10 variants...`
          });

          // STEP 2: Generate variants
          const metadata = await extractLayerMetadataForEdits(frame);

          // Export frame as 1x PNG for AI vision analysis
          const frameImageBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 1 }
          });
          const frameImageBase64 = figma.base64Encode(frameImageBytes);

          // Send to UI for AI variant generation (same format as prepare-for-edits)
          figma.ui.postMessage({
            type: 'workflow-api-request',
            api: 'variants',
            frameId: frame.id,
            frameName: frameName,
            data: {
              frameId: frame.id,
              frameName: frameName,
              frameWidth: frame.width,
              frameHeight: frame.height,
              layers: metadata,
              frameImageBase64: frameImageBase64
            },
            generateImages: generateImages
          });

          // Wait for variants response
          const variants = await new Promise<EditVariant[]>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Variants timeout')), 180000);

            const handler = (msg: any) => {
              if (msg.type === 'workflow-api-response' && msg.frameId === frame.id && msg.api === 'variants') {
                clearTimeout(timeout);
                figma.ui.off('message', handler);
                if (msg.error) {
                  reject(new Error(msg.error));
                } else {
                  resolve(msg.data);
                }
              }
            };

            figma.ui.on('message', handler);
          });

          // Apply variants
          await applyEditVariants(frame, variants);
          variantsCreated += variants.length;
          console.log(`[Workflow] Frame ${frameName}: Created ${variants.length} variants`);

          figma.ui.postMessage({
            type: 'workflow-progress',
            message: `[${frameIndex + 1}/${frames.length}] ${frameName}: Exporting ${variants.length + 1} frames...`
          });

          // STEP 3: Export original + all variants
          // Find all variant frames (they're siblings with naming pattern: frameName_v#_theme)
          const parent = frame.parent;
          const allFramesToExport: (FrameNode | ComponentNode)[] = [frame]; // Start with original

          if (parent && 'children' in parent) {
            for (const child of parent.children) {
              if ((child.type === 'FRAME' || child.type === 'COMPONENT') && child.id !== frame.id) {
                // Skip prompt cards (they're visual guides, not meant for export)
                if (child.name.includes('_prompt_card')) {
                  continue;
                }

                // Check if this is a variant of our frame
                if (child.name.startsWith(`${frameName}_v`)) {
                  allFramesToExport.push(child as FrameNode | ComponentNode);
                }
              }
            }
          }

          // Export each frame (original + variants)
          // Remove workflowFrameId to use batch mode (UI will group by serial number)
          for (let i = 0; i < allFramesToExport.length; i++) {
            const frameToExport = allFramesToExport[i];
            await exportFrame(frameToExport, i, allFramesToExport.length, 'png', 2);
            console.log(`[Workflow] Frame ${frameName}: Exported ${i + 1}/${allFramesToExport.length}`);
          }

          // Send completion message to trigger ZIP creation and S3 upload
          figma.ui.postMessage({
            type: 'all-exports-complete',
            totalFrames: allFramesToExport.length
          });

          console.log(`[Workflow] Frame ${frameName}: Sent all-exports-complete for ${allFramesToExport.length} frames`);

          // Wait for ZIP upload confirmation
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              console.warn(`[Workflow] Upload timeout for ${frameName}`);
              resolve(); // Don't fail the workflow if upload times out
            }, 60000);

            const handler = (msg: any) => {
              if (msg.type === 'workflow-zip-uploaded' && msg.frameName === frameName) {
                clearTimeout(timeout);
                figma.ui.off('message', handler);
                zipsUploaded++;
                console.log(`[Workflow] ✓ ZIP uploaded for ${frameName} (${zipsUploaded} total)`);
                resolve();
              }
            };

            figma.ui.on('message', handler);
          });

          framesCompleted++;

          console.log(`[Workflow] ✓ Frame ${frameName} complete (${framesCompleted}/${frames.length})`);

        } catch (error) {
          console.error(`[Workflow] Frame ${frame.name} failed:`, error);
          framesFailed++;

          figma.ui.postMessage({
            type: 'workflow-progress',
            message: `[${frameIndex + 1}/${frames.length}] ${frame.name}: Failed - ${(error as Error).message}`
          });
        }
      }

      // Worker function to process frames from queue
      async function worker(frameQueue: (FrameNode | ComponentNode)[], workerId: number): Promise<void> {
        console.log(`[Worker ${workerId}] Started`);

        while (frameQueue.length > 0) {
          const frame = frameQueue.shift();
          if (!frame) break;

          const frameIndex = frames.indexOf(frame);
          console.log(`[Worker ${workerId}] Processing frame ${frameIndex + 1}/${frames.length}: ${frame.name}`);

          await processFrameComplete(frame, frameIndex);
        }

        console.log(`[Worker ${workerId}] Finished`);
      }

      // Create worker pool with shared queue
      const frameQueue = [...frames];
      const workers: Promise<void>[] = [];

      for (let i = 0; i < concurrency; i++) {
        workers.push(worker(frameQueue, i));
      }

      // Wait for all workers to complete
      await Promise.all(workers);

      console.log(`[Workflow] Complete: ${framesCompleted} succeeded, ${framesFailed} failed`);

      // Send completion message
      figma.ui.postMessage({
        type: 'workflow-complete',
        framesCompleted,
        framesFailed,
        variantsCreated,
        zipsUploaded
      });

    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Workflow failed: ' + (error as Error).message
      });
    }
    return;
  }

  // ============================================
  // Original Export Flow (unchanged)
  // ============================================

  if (msg.type === 'export-frame') {
    try {
      const selection = figma.currentPage.selection;

      // Validate selection
      if (selection.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Please select one or more frames to export'
        });
        return;
      }

      // Filter only frames and components
      const frames: (FrameNode | ComponentNode)[] = [];
      for (const node of selection) {
        if (node.type === 'FRAME' || node.type === 'COMPONENT') {
          frames.push(node as FrameNode | ComponentNode);
        }
      }

      if (frames.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Please select at least one frame or component'
        });
        return;
      }

      const exportFormat = msg.format || 'png';
      const exportScale = msg.scale || 2;

      // Export each frame sequentially
      for (let i = 0; i < frames.length; i++) {
        await exportFrame(frames[i], i, frames.length, exportFormat, exportScale);
      }

      // Notify UI that all exports are complete
      figma.ui.postMessage({
        type: 'all-exports-complete',
        totalFrames: frames.length
      });

    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Export failed: ' + (error as Error).message
      });
    }
  }
};
