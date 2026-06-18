# Dictara Icon Generation Guide

## Quick Reference

**Source of Truth:** `landing/public/app-icon-full.svg`

**Regenerate all icons:**
```bash
# Run from project root
SVG="landing/public/app-icon-full.svg"

# Tauri app icons
rsvg-convert -w 32 -h 32 "$SVG" > src-tauri/icons/32x32.png
rsvg-convert -w 64 -h 64 "$SVG" > src-tauri/icons/64x64.png
rsvg-convert -w 128 -h 128 "$SVG" > src-tauri/icons/128x128.png
rsvg-convert -w 256 -h 256 "$SVG" > src-tauri/icons/128x128@2x.png
rsvg-convert -w 512 -h 512 "$SVG" > src-tauri/icons/icon.png

# Landing page
rsvg-convert -w 32 -h 32 "$SVG" > landing/public/favicon.png
rsvg-convert -w 180 -h 180 "$SVG" > landing/public/icon.png
```

---

## Detailed Documentation

### Source Files

| File | Purpose |
|------|---------|
| `landing/public/app-icon-full.svg` | **SOURCE OF TRUTH** - Full icon with gradient background (512x512 viewBox) |
| `landing/public/app-icon.svg` | White icon only, no background (for tray icons & overlays) |

### Icon Locations

#### 1. Tauri Desktop App (`src-tauri/icons/`)

| File | Size | Platform |
|------|------|----------|
| `32x32.png` | 32x32 | All |
| `64x64.png` | 64x64 | All |
| `128x128.png` | 128x128 | All |
| `128x128@2x.png` | 256x256 | Retina displays |
| `icon.png` | 512x512 | All |
| `icon.icns` | Multi-size | macOS |
| `icon.ico` | Multi-size | Windows |
| `tray-icon.png` | Small | System tray |
| `tray-icon@2x.png` | Small @2x | System tray (Retina) |

**Windows Store Logos:**
- `Square30x30Logo.png`, `Square44x44Logo.png`, `Square71x71Logo.png`
- `Square89x89Logo.png`, `Square107x107Logo.png`, `Square142x142Logo.png`
- `Square150x150Logo.png`, `Square284x284Logo.png`, `Square310x310Logo.png`
- `StoreLogo.png` (50x50)

#### 2. Landing Page (`landing/public/`)

| File | Size | Purpose |
|------|------|---------|
| `favicon.png` | 32x32 | Browser tab icon |
| `icon.png` | 180x180 | Apple touch icon |

---

## Generation Commands

### Prerequisites
```bash
# Required: librsvg (for rsvg-convert)
brew install librsvg

# Optional: ImageMagick (for .ico files)
brew install imagemagick
```

### Generate All PNG Icons
```bash
SVG="landing/public/app-icon-full.svg"
OUT="src-tauri/icons"

# Standard sizes
rsvg-convert -w 32 -h 32 "$SVG" > "$OUT/32x32.png"
rsvg-convert -w 64 -h 64 "$SVG" > "$OUT/64x64.png"
rsvg-convert -w 128 -h 128 "$SVG" > "$OUT/128x128.png"
rsvg-convert -w 256 -h 256 "$SVG" > "$OUT/128x128@2x.png"
rsvg-convert -w 512 -h 512 "$SVG" > "$OUT/icon.png"

# Windows Store logos
rsvg-convert -w 30 -h 30 "$SVG" > "$OUT/Square30x30Logo.png"
rsvg-convert -w 44 -h 44 "$SVG" > "$OUT/Square44x44Logo.png"
rsvg-convert -w 71 -h 71 "$SVG" > "$OUT/Square71x71Logo.png"
rsvg-convert -w 89 -h 89 "$SVG" > "$OUT/Square89x89Logo.png"
rsvg-convert -w 107 -h 107 "$SVG" > "$OUT/Square107x107Logo.png"
rsvg-convert -w 142 -h 142 "$SVG" > "$OUT/Square142x142Logo.png"
rsvg-convert -w 150 -h 150 "$SVG" > "$OUT/Square150x150Logo.png"
rsvg-convert -w 284 -h 284 "$SVG" > "$OUT/Square284x284Logo.png"
rsvg-convert -w 310 -h 310 "$SVG" > "$OUT/Square310x310Logo.png"
rsvg-convert -w 50 -h 50 "$SVG" > "$OUT/StoreLogo.png"
```

### Generate macOS .icns
```bash
SVG="landing/public/app-icon-full.svg"
ICONSET="/tmp/AppIcon.iconset"
mkdir -p "$ICONSET"

rsvg-convert -w 16 -h 16 "$SVG" > "$ICONSET/icon_16x16.png"
rsvg-convert -w 32 -h 32 "$SVG" > "$ICONSET/icon_16x16@2x.png"
rsvg-convert -w 32 -h 32 "$SVG" > "$ICONSET/icon_32x32.png"
rsvg-convert -w 64 -h 64 "$SVG" > "$ICONSET/icon_32x32@2x.png"
rsvg-convert -w 128 -h 128 "$SVG" > "$ICONSET/icon_128x128.png"
rsvg-convert -w 256 -h 256 "$SVG" > "$ICONSET/icon_128x128@2x.png"
rsvg-convert -w 256 -h 256 "$SVG" > "$ICONSET/icon_256x256.png"
rsvg-convert -w 512 -h 512 "$SVG" > "$ICONSET/icon_256x256@2x.png"
rsvg-convert -w 512 -h 512 "$SVG" > "$ICONSET/icon_512x512.png"
rsvg-convert -w 1024 -h 1024 "$SVG" > "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "src-tauri/icons/icon.icns"
rm -rf "$ICONSET"
```

### Generate Windows .ico (requires ImageMagick)
```bash
magick src-tauri/icons/256x256.png \
  \( -clone 0 -resize 16x16 \) \
  \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 64x64 \) \
  \( -clone 0 -resize 128x128 \) \
  \( -clone 0 -resize 256x256 \) \
  -delete 0 src-tauri/icons/icon.ico
```

### Generate Tray Icons (from white SVG)
```bash
SVG="landing/public/app-icon.svg"
rsvg-convert -w 22 -h 22 "$SVG" > src-tauri/icons/tray-icon.png
rsvg-convert -w 44 -h 44 "$SVG" > src-tauri/icons/tray-icon@2x.png
```

### Generate Landing Page Icons
```bash
SVG="landing/public/app-icon-full.svg"
rsvg-convert -w 32 -h 32 "$SVG" > landing/public/favicon.png
rsvg-convert -w 180 -h 180 "$SVG" > landing/public/icon.png
```

---

## Icon Design

The app icon (`app-icon-full.svg`) consists of:
- **Background**: Rounded square with warm gradient (coral #e879a0 → orange #f59e6b → golden #fbbf4a)
- **Icon**: Sound wave bars with AI sparkles (white)

The icon design is also used in `landing/src/components/icons/FeatureIcons.tsx` as `IconWhisper`.

---

## Troubleshooting

**rsvg-convert not found:**
```bash
brew install librsvg
```

**iconutil not found:**
- Only available on macOS (built-in)

**Poor quality at small sizes:**
- SVG icons may need manual tweaking for very small sizes (16x16, 32x32)
- Consider creating separate optimized SVGs for small sizes
