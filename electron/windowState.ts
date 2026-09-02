import type { Rectangle } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface PersistedWindowState {
  bounds: Rectangle;
  maximized: boolean;
  fullscreen: boolean;
}

const DEFAULT_BOUNDS: Rectangle = { x: 120, y: 80, width: 1400, height: 900 };

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function intersectionArea(first: Rectangle, second: Rectangle): number {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

function fitBoundsToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(Math.max(bounds.width, 900), workArea.width);
  const height = Math.min(Math.max(bounds.height, 600), workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

export function normalizeWindowState(
  raw: unknown,
  workAreas: Rectangle[],
  primaryWorkArea: Rectangle = workAreas[0] ?? DEFAULT_BOUNDS,
): PersistedWindowState {
  const fallbackArea = primaryWorkArea;
  const parsed = raw && typeof raw === 'object'
    ? raw as Partial<PersistedWindowState> & { version?: unknown }
    : {};
  const version = finiteInteger(parsed.version);
  const candidate = version !== null && version !== 1 && version !== 2 ? {} : parsed;
  const candidateBounds = candidate.bounds && typeof candidate.bounds === 'object'
    ? candidate.bounds as Partial<Rectangle>
    : {};
  const x = finiteInteger(candidateBounds.x);
  const y = finiteInteger(candidateBounds.y);
  const width = finiteInteger(candidateBounds.width);
  const height = finiteInteger(candidateBounds.height);
  const bounds = x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0
    ? { x, y, width, height }
    : {
      x: fallbackArea.x + Math.max(0, Math.round((fallbackArea.width - DEFAULT_BOUNDS.width) / 2)),
      y: fallbackArea.y + Math.max(0, Math.round((fallbackArea.height - DEFAULT_BOUNDS.height) / 2)),
      width: Math.min(DEFAULT_BOUNDS.width, fallbackArea.width),
      height: Math.min(DEFAULT_BOUNDS.height, fallbackArea.height),
    };
  const targetArea = workAreas
    .map(workArea => ({ workArea, area: intersectionArea(bounds, workArea) }))
    .sort((left, right) => right.area - left.area)[0];
  const selectedArea = targetArea && targetArea.area >= 64 * 64 ? targetArea.workArea : fallbackArea;
  return {
    bounds: fitBoundsToWorkArea(bounds, selectedArea),
    maximized: candidate.maximized === true,
    fullscreen: candidate.fullscreen === true,
  };
}

export function readWindowState(
  filePath: string,
  workAreas: Rectangle[],
  primaryWorkArea: Rectangle = workAreas[0] ?? DEFAULT_BOUNDS,
): PersistedWindowState {
  try {
    return normalizeWindowState(JSON.parse(fs.readFileSync(filePath, 'utf8')), workAreas, primaryWorkArea);
  } catch {
    return normalizeWindowState(null, workAreas, primaryWorkArea);
  }
}

export function writeWindowState(filePath: string, state: PersistedWindowState): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ version: 2, ...state }), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}
