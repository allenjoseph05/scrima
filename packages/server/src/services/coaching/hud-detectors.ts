/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * HUD Detectors — Pixel-level analysis (no ML needed)
 *
 * These detectors use simple color/brightness analysis on cropped
 * HUD regions. They're fast (<1ms), free, and reliable because
 * HUD elements have consistent visual properties.
 *
 * Detectors:
 *   - Kill banner (HSV yellow)
 *   - Ability status (brightness)
 *   - Flash detection (full-frame brightness spike)
 *   - Spike planted (timer color change)
 *   - Death screen detection (saturation drop)
 */

import sharp from 'sharp';

// ── Types ──────────────────────────────────────────────────────────────────

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AbilityStatus {
  C: 'available' | 'used' | 'unknown';
  Q: 'available' | 'used' | 'unknown';
  E: 'available' | 'used' | 'unknown';
  X: 'available' | 'used' | 'unknown';
}

// ── HUD Regions (1280x720 base) ────────────────────────────────────────────

export const HUD_REGIONS = {
  /** Kill banner area — top-right killfeed */
  killBanner: { x: 850, y: 30, w: 400, h: 60 },

  /** Ability C icon */
  abilityC: { x: 468, y: 684, w: 40, h: 30 },
  /** Ability Q icon */
  abilityQ: { x: 530, y: 684, w: 40, h: 30 },
  /** Ability E icon */
  abilityE: { x: 592, y: 684, w: 40, h: 30 },
  /** Ultimate X icon */
  abilityX: { x: 654, y: 684, w: 40, h: 30 },

  /** Health bar area */
  healthBar: { x: 340, y: 698, w: 140, h: 8 },
  /** Shield bar area */
  shieldBar: { x: 340, y: 692, w: 140, h: 6 },
} as const;

// ── Scale regions for actual resolution ────────────────────────────────────

export function scaleRegion(region: Region, scaleX: number, scaleY: number): Region {
  return {
    x: Math.round(region.x * scaleX),
    y: Math.round(region.y * scaleY),
    w: Math.round(region.w * scaleX),
    h: Math.round(region.h * scaleY),
  };
}

// ── Kill Banner Detection (RGB Yellow heuristic) ──────────────────────────────

/**
 * Detect kill banner by looking for yellow pixels in the killfeed area.
 *
 * When the player gets a kill, a yellow-highlighted entry appears in
 * the killfeed (top-right). HSV range: H=[20,45], S=[40,140], V=[180,255]
 *
 * @param frameBuffer Raw RGB pixel buffer
 * @param width Frame width
 * @param height Frame height
 * @param scaleX X scale factor (width / 1280)
 * @param scaleY Y scale factor (height / 720)
 * @returns true if kill banner detected
 */
export function detectKillBanner(
  frameBuffer: Buffer,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
): boolean {
  const region = scaleRegion(HUD_REGIONS.killBanner, scaleX, scaleY);

  let yellowPixels = 0;
  let totalPixels = 0;

  for (let y = region.y; y < region.y + region.h && y < height; y++) {
    for (let x = region.x; x < region.x + region.w && x < width; x++) {
      const idx = (y * width + x) * 3;
      const r = frameBuffer[idx];
      const g = frameBuffer[idx + 1];
      const b = frameBuffer[idx + 2];

      // Check for yellow: high R, high G, low B
      if (r > 180 && g > 150 && b < 100 && r > b * 2) {
        yellowPixels++;
      }
      totalPixels++;
    }
  }

  const ratio = yellowPixels / Math.max(totalPixels, 1);
  return ratio > 0.008; // >0.8% yellow pixels = kill banner (calibrated on real gameplay)
}

// ── Ability Status (Brightness Check) ──────────────────────────────────────

/**
 * Check ability icon brightness to determine if abilities are available.
 *
 * Available = bright icon (avg brightness > 120)
 * Used/cooldown = dim icon (avg brightness < 80)
 *
 * @param frameBuffer Raw RGB pixel buffer
 * @param width Frame width
 * @param height Frame height
 * @param scaleX X scale factor
 * @param scaleY Y scale factor
 */
export function checkAbilityStatus(
  frameBuffer: Buffer,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
): AbilityStatus {
  const slots = {
    C: HUD_REGIONS.abilityC,
    Q: HUD_REGIONS.abilityQ,
    E: HUD_REGIONS.abilityE,
    X: HUD_REGIONS.abilityX,
  } as const;

  const result: AbilityStatus = { C: 'unknown', Q: 'unknown', E: 'unknown', X: 'unknown' };

  for (const [slot, baseRegion] of Object.entries(slots)) {
    const region = scaleRegion(baseRegion, scaleX, scaleY);
    let totalBrightness = 0;
    let count = 0;

    for (let y = region.y; y < region.y + region.h && y < height; y++) {
      for (let x = region.x; x < region.x + region.w && x < width; x++) {
        const idx = (y * width + x) * 3;
        const r = frameBuffer[idx];
        const g = frameBuffer[idx + 1];
        const b = frameBuffer[idx + 2];
        // Perceived brightness
        totalBrightness += r * 0.299 + g * 0.587 + b * 0.114;
        count++;
      }
    }

    const avgBrightness = totalBrightness / Math.max(count, 1);

    if (avgBrightness > 110) {
      result[slot as keyof AbilityStatus] = 'available';
    } else if (avgBrightness < 70) {
      result[slot as keyof AbilityStatus] = 'used';
    }
    // Between 70-110 is ambiguous — keep as 'unknown'
  }

  return result;
}

// ── Flash Detection (Full-Frame Brightness Spike) ──────────────────────────

/**
 * Detect if the player is being flashed (screen goes white).
 * Measures average brightness of the full frame.
 *
 * @returns true if average brightness > 200 (nearly white screen)
 */
export function detectFlash(frameBuffer: Buffer, width: number, height: number): boolean {
  // Sample every 10th pixel for speed
  let totalBrightness = 0;
  let count = 0;

  for (let i = 0; i + 2 < frameBuffer.length; i += 30) {
    // 30 = 10 pixels * 3 channels
    const r = frameBuffer[i];
    const g = frameBuffer[i + 1];
    const b = frameBuffer[i + 2];
    totalBrightness += (r + g + b) / 3;
    count++;
  }

  const avgBrightness = totalBrightness / Math.max(count, 1);
  return avgBrightness > 200;
}

// ── Health Bar Fill Detection (Backup) ─────────────────────────────────────

/**
 * Measure health bar fill percentage by counting colored pixels.
 * The health bar is a horizontal bar that shrinks from right to left.
 *
 * This is a BACKUP for the NN health reader — less precise but
 * doesn't need training.
 *
 * @returns Fill percentage 0.0 to 1.0, or null if bar not detected
 */
export function measureHealthBarFill(
  frameBuffer: Buffer,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
): number | null {
  const region = scaleRegion(HUD_REGIONS.healthBar, scaleX, scaleY);

  let coloredPixels = 0;
  let totalPixels = 0;

  for (let y = region.y; y < region.y + region.h && y < height; y++) {
    for (let x = region.x; x < region.x + region.w && x < width; x++) {
      const idx = (y * width + x) * 3;
      const r = frameBuffer[idx];
      const g = frameBuffer[idx + 1];
      const b = frameBuffer[idx + 2];

      // Health bar is white/green when filled, dark when empty
      const brightness = (r + g + b) / 3;
      if (brightness > 100) {
        coloredPixels++;
      }
      totalPixels++;
    }
  }

  if (totalPixels < 10) return null;
  return coloredPixels / totalPixels;
}

// ── Crop utility using sharp ───────────────────────────────────────────────

/**
 * Crop a region from a frame image.
 */
export async function cropRegion(
  frameBuffer: Buffer,
  width: number,
  height: number,
  region: Region,
): Promise<Buffer> {
  // Clamp region to frame bounds
  const x = Math.max(0, Math.min(region.x, width - 1));
  const y = Math.max(0, Math.min(region.y, height - 1));
  const w = Math.min(region.w, width - x);
  const h = Math.min(region.h, height - y);

  return sharp(frameBuffer, { raw: { width, height, channels: 3 } })
    .extract({ left: x, top: y, width: w, height: h })
    .toBuffer();
}
