# Image Reconstruction Script

This TypeScript script reconstructs the complete image from exported Figma frame data (meta.json + layer PNGs).

## How It Works

The script:
1. Reads the `meta.json` file to get component dimensions and layer metadata
2. Filters visible layers and sorts them by z-index (ascending)
3. Creates a transparent canvas matching the component dimensions
4. Composites each layer PNG onto the canvas at the exact position specified in the JSON
5. Outputs a single reconstructed PNG image

## Prerequisites

Dependencies are already installed if you ran `npm install`. The script uses:
- `sharp` - High-performance image processing library
- `@types/node` - TypeScript definitions for Node.js

## Usage

### Basic Usage

```bash
npm run reconstruct <path-to-exported-folder>
```

Example:
```bash
npm run reconstruct ./login_card
```

This will create `Login Card_reconstructed.png` inside the `login_card` folder.

### Custom Output Path

```bash
npm run reconstruct <path-to-exported-folder> <output-path>
```

Example:
```bash
npm run reconstruct ./login_card ./output/final.png
```

## Expected Folder Structure

The input folder should have this structure (as exported by the Figma plugin):

```
login_card/
├── meta.json
└── layers/
    ├── 3_45.png
    ├── 3_46.png
    └── ...
```

## Output

The script will create a single PNG file that perfectly recreates the original Figma frame by:
- Positioning each layer exactly at (x, y) coordinates
- Respecting layer visibility (invisible layers are skipped)
- Maintaining proper z-index order (lower z-index drawn first, higher on top)
- Preserving transparency where applicable

## Example Output

```
🔍 Reading metadata from: ./login_card
📦 Component: Login Card (1440x900)
📚 Total layers: 15
✨ Visible layers: 13
🎨 Creating canvas: 1440x900
  ✓ Layer 0: Background at (0, 0)
  ✓ Layer 1: Container at (100, 100)
  ✓ Layer 2: Header Text at (120, 120)
  ...
  ✓ Layer 12: CTA Button at (620, 520)

✅ Image reconstructed successfully!
📁 Output: ./login_card/Login Card_reconstructed.png
🎉 Done!
```

## Technical Details

- Images are composited using the `sharp` library for high performance
- Layers are resized to match exact dimensions from the JSON
- Position coordinates are rounded to nearest pixel
- Transparent backgrounds are preserved
- All composite operations are batched for efficiency

## Troubleshooting

**Error: meta.json not found**
- Ensure you're pointing to the correct folder containing the exported data

**Warning: Layer image not found**
- Some layer PNG files might be missing from the `layers/` folder
- The script will skip missing layers and continue with available ones

**Output image looks different**
- Verify that all layer PNGs are present in the `layers/` folder
- Check that the z-index values in meta.json are correct
- Ensure layer positions (x, y) are accurate in the JSON
