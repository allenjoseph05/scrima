/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * Ability Bar Analysis — Shared Module
 *
 * Pixel-level analysis of the Valorant ability bar to determine
 * which abilities are available vs on cooldown. Zero AI cost.
 *
 * Extracted from fact-verification.service.ts for reuse in the CV pipeline.
 */

import sharp from 'sharp';
import { AGENTS } from '../../games/valorant/knowledge.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AbilitySlotState {
  slot: number; // 0-3 (C, Q, E, X)
  brightness: number; // 0-255 average
  available: boolean; // true if brightness exceeds threshold
}

export interface AbilityBarAnalysis {
  slots: AbilitySlotState[];
  availableCount: number;
  summary: string; // e.g., "2/4 abilities available (slots 1,3 lit, slots 2,4 dark)"
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze the ability bar from a full game frame.
 * Crops the ability bar region, splits into 4 slots, measures brightness.
 * Returns per-slot availability state.
 */
export async function analyzeAbilityBar(frameBase64: string): Promise<AbilityBarAnalysis | null> {
  try {
    const buf = Buffer.from(frameBase64, 'base64');
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 1280;
    const h = meta.height ?? 720;

    const barW = Math.round(w * 0.3);
    const barH = Math.round(h * 0.1);
    const barLeft = Math.round(w * 0.35);
    const barTop = Math.round(h * 0.88);

    const { data: rawPixels, info } = await sharp(buf)
      .extract({ left: barLeft, top: barTop, width: barW, height: barH })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const slotWidth = Math.floor(info.width / 4);
    const slots: AbilitySlotState[] = [];

    for (let slot = 0; slot < 4; slot++) {
      let totalBrightness = 0;
      let pixelCount = 0;

      for (let y = 0; y < info.height; y++) {
        for (let x = slot * slotWidth; x < (slot + 1) * slotWidth && x < info.width; x++) {
          totalBrightness += rawPixels[y * info.width + x];
          pixelCount++;
        }
      }

      const brightness = pixelCount > 0 ? totalBrightness / pixelCount : 0;
      slots.push({ slot, brightness, available: false });
    }

    const maxBright = Math.max(...slots.map((s) => s.brightness));
    const minBright = Math.min(...slots.map((s) => s.brightness));
    const range = maxBright - minBright;

    if (range < 15) {
      const allAvailable = maxBright > 80;
      for (const s of slots) s.available = allAvailable;
    } else {
      const threshold = minBright + range * 0.4;
      for (const s of slots) s.available = s.brightness > threshold;
    }

    const availableCount = slots.filter((s) => s.available).length;
    const litSlots = slots
      .filter((s) => s.available)
      .map((s) => s.slot + 1)
      .join(',');
    const darkSlots = slots
      .filter((s) => !s.available)
      .map((s) => s.slot + 1)
      .join(',');
    const summary = `${availableCount}/4 abilities available${litSlots ? ` (slots ${litSlots} lit` : ''}${darkSlots ? `, slots ${darkSlots} dark)` : ')'}`;

    return { slots, availableCount, summary };
  } catch {
    return null;
  }
}

/**
 * Compare ability bar state between an early frame and a late (predeath) frame.
 * Returns a description of what changed: abilities used during the fight.
 */
export function compareAbilityStates(
  early: AbilityBarAnalysis | null,
  late: AbilityBarAnalysis | null,
  agentName: string,
): string {
  if (!late) return 'Ability bar state: unknown.';
  if (!early) return `At death: ${late.summary}.`;

  const used: number[] = [];
  const stillAvailable: number[] = [];
  const alreadyUsed: number[] = [];

  for (let i = 0; i < 4; i++) {
    const e = early.slots[i];
    const l = late.slots[i];
    if (e?.available && !l?.available) {
      used.push(i + 1);
    } else if (l?.available) {
      stillAvailable.push(i + 1);
    } else {
      alreadyUsed.push(i + 1);
    }
  }

  const agentKey = agentName.toLowerCase() === 'kay/o' ? 'kay/o' : agentName.toLowerCase();
  const agentData = AGENTS[agentKey];
  const slotKeys = ['C', 'Q', 'E', 'X'];
  const slotLabels = ['C', 'Q', 'E', 'X (Ultimate)'];

  const abilityNames: Record<string, string> = {};
  if (agentData?.abilities) {
    for (const line of agentData.abilities.split('\n')) {
      const m = line.match(/^([CQEX])\s+(\w[\w\s'-]*?)(?:\s*\(|:)/);
      if (m) abilityNames[m[1]] = m[2].trim();
    }
  }

  const nameSlot = (slot: number) => {
    const key = slotKeys[slot - 1];
    const name = abilityNames[key];
    return name ? `${slotLabels[slot - 1]}: ${name}` : slotLabels[slot - 1];
  };

  const parts: string[] = [];
  if (used.length > 0) parts.push(`USED during fight: ${used.map(nameSlot).join(', ')}`);
  if (stillAvailable.length > 0)
    parts.push(`AVAILABLE at death (not used): ${stillAvailable.map(nameSlot).join(', ')}`);
  if (alreadyUsed.length > 0)
    parts.push(`Already on cooldown: ${alreadyUsed.map(nameSlot).join(', ')}`);

  return parts.length > 0
    ? `Ability tracking: ${parts.join(' | ')}`
    : 'Ability bar: could not determine state.';
}
