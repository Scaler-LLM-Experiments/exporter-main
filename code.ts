// Frame Exporter Plugin
// Exports a selected frame with all its layers as PNGs and metadata as JSON

figma.showUI(__html__, { width: 320, height: 360 });

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

// Export a single frame
async function exportFrame(frame: FrameNode | ComponentNode, frameIndex: number, totalFrames: number, format: string, scale: number): Promise<void> {
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
    name: frame.name + ' (Frame Base)',
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

  // Send data to UI for ZIP creation
  figma.ui.postMessage({
    type: 'export-data',
    folderName: createFolderName(frame.name),
    meta,
    layers: exportedLayers,
    frameIndex,
    totalFrames,
    format
  });
}

// ============================================
// AI Layer Renaming Functions
// ============================================

// Export layer images for AI renaming (at 1x scale for efficient processing)
async function exportLayersForRenaming(frame: FrameNode | ComponentNode): Promise<void> {
  figma.ui.postMessage({
    type: 'progress',
    message: 'Preparing layers for AI analysis...'
  });

  const allLayers: SceneNode[] = [];
  if ('children' in frame) {
    for (const child of frame.children) {
      collectLayers(child, allLayers);
    }
  }

  const layerExports: Array<{
    id: string;
    name: string;
    type: string;
    imageData: string;
  }> = [];

  // Export each layer as PNG at 1x scale for AI analysis
  for (let i = 0; i < allLayers.length; i++) {
    const layer = allLayers[i];

    figma.ui.postMessage({
      type: 'progress',
      message: `Exporting layer ${i + 1}/${allLayers.length}: ${layer.name}`
    });

    try {
      const bytes = await layer.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 1 }
      });
      layerExports.push({
        id: layer.id,
        name: layer.name,
        type: layer.type,
        imageData: figma.base64Encode(bytes)
      });
    } catch (error) {
      console.error(`Failed to export layer ${layer.name}:`, error);
      // Still include the layer but without image data
      layerExports.push({
        id: layer.id,
        name: layer.name,
        type: layer.type,
        imageData: ''
      });
    }
  }

  figma.ui.postMessage({
    type: 'layers-for-renaming',
    frameId: frame.id,
    frameName: frame.name,
    layers: layerExports
  });
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
// Message Handler
// ============================================

interface PluginMessage {
  type: string;
  format?: string;
  scale?: number;
  renames?: Array<{ id: string; newName: string }>;
}

figma.ui.onmessage = async (msg: PluginMessage) => {
  console.log('[Plugin] Received message:', msg.type, JSON.stringify(msg));

  if (msg.type === 'cancel') {
    figma.closePlugin();
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

      // Process only the first selected frame for renaming
      await exportLayersForRenaming(frames[0]);
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
        type: 'all-exports-complete'
      });

    } catch (error) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Export failed: ' + (error as Error).message
      });
    }
  }
};
