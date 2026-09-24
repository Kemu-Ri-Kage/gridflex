/**
 * The landing hero's price grid: every hour of the last 30 published days
 * of the day-ahead Texas power price, one bar per hour, drawn as a small
 * 3D field on a 2D canvas. This module is the geometry - projection, which
 * faces show, draw order, hit-testing - and the colour scale, with no DOM,
 * so it is tested directly. Hours run left to right (00:00 to 23:00
 * Central), days back to front (oldest furthest away), height is the price.
 */

/** One published day: its 24 hourly prices and its daily average, in cents. */
export interface GridDay {
  dayKey: number;
  average: number;
  hours: number[];
}

/** web/public/data/price-grid.json, written by build_feed_data.py. */
export interface PriceGrid {
  metricId: string;
  days: GridDay[];
}

/** An orthographic camera turned `yaw` about the vertical and tilted `pitch` down, radians. */
export interface Camera {
  yaw: number;
  pitch: number;
  /** Screen pixels per world unit. */
  scale: number;
  /** Screen position of the world origin. */
  cx: number;
  cy: number;
}

export interface Point {
  x: number;
  y: number;
}

/** World units between bar centres; a bar's footprint is BAR_WIDTH of that. */
export const BAR_WIDTH = 0.72;
/** World height of the tallest bar in the grid. */
export const GRID_HEIGHT = 17;

/** A world point (x across hours, y up, z across days) on screen. */
export function project(x: number, y: number, z: number, camera: Camera): Point {
  const cos = Math.cos(camera.yaw);
  const sin = Math.sin(camera.yaw);
  const across = x * cos - z * sin;
  const toward = x * sin + z * cos;
  return {
    x: camera.cx + across * camera.scale,
    y: camera.cy + (toward * Math.sin(camera.pitch) - y * Math.cos(camera.pitch)) * camera.scale,
  };
}

/** How near a ground point sits to the viewer: larger is nearer, drawn later. */
export function depth(x: number, z: number, yaw: number): number {
  return x * Math.sin(yaw) + z * Math.cos(yaw);
}

/** Screen pixels per world unit that fit a `hours` x `days` grid in a width x height box at this pitch. */
export function fitScale(width: number, height: number, hours: number, days: number, pitch: number): number {
  // The footprint's diagonal is the widest it gets at any yaw.
  const diagonal = Math.hypot(hours, days);
  const tall = diagonal * Math.sin(pitch) + GRID_HEIGHT * Math.cos(pitch);
  return Math.max(0, Math.min(width / diagonal, height / tall)) * 0.94;
}

/** A bar's centre on the ground, the grid centred on the origin, newest day nearest. */
export function barCentre(hour: number, dayIndex: number, hours: number, days: number): { x: number; z: number } {
  return { x: hour - (hours - 1) / 2, z: dayIndex - (days - 1) / 2 };
}

/** A face of a bar as screen polygon points, with its light level (1 = top). */
export interface Face {
  points: Point[];
  light: number;
}

/**
 * The faces of one bar the camera can see: its top, and the two sides
 * whose outward normal points toward the viewer.
 */
export function barFaces(x: number, z: number, height: number, camera: Camera): Face[] {
  const w = BAR_WIDTH / 2;
  const at = (dx: number, y: number, dz: number) => project(x + dx, y, z + dz, camera);
  const sin = Math.sin(camera.yaw);
  const cos = Math.cos(camera.yaw);
  const faces: Face[] = [];
  // A side faces the viewer when its normal's toward-viewer component is positive.
  const sides: [number, number, number][] = [
    [1, 0, sin],
    [-1, 0, -sin],
    [0, 1, cos],
    [0, -1, -cos],
  ];
  for (const [nx, nz, facing] of sides) {
    if (facing <= 0) continue;
    const corners =
      nx !== 0
        ? [at(nx * w, 0, -w), at(nx * w, 0, w), at(nx * w, height, w), at(nx * w, height, -w)]
        : [at(-w, 0, nz * w), at(w, 0, nz * w), at(w, height, nz * w), at(-w, height, nz * w)];
    // Sides turned toward the viewer are lit more than those seen edge-on.
    faces.push({ points: corners, light: 0.42 + 0.3 * facing });
  }
  faces.push({ points: [at(-w, height, -w), at(w, height, -w), at(w, height, w), at(-w, height, w)], light: 1 });
  return faces;
}

/** Whether `point` is inside the convex or simple `polygon` (even-odd rule). */
export function inside(point: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

/** Parse #rrggbb to [r, g, b]. */
export function hexRgb(hex: string): [number, number, number] {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? '000000';
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

/** `from` mixed toward `to` by t (0..1), as an rgb() string. */
export function mix(from: [number, number, number], to: [number, number, number], t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const [r, g, b] = from.map((c, i) => Math.round(c + (to[i] - c) * k));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * A bar's brightness from its price: a square-root scale up to the grid's
 * highest hour, so the ordinary $20-$50 hours still read as different
 * heights of grey while the spikes stand out. Heights stay linear.
 */
export function brightness(cents: number, maxCents: number): number {
  if (!(maxCents > 0)) return 0;
  return 0.18 + 0.82 * Math.sqrt(Math.max(0, cents) / maxCents);
}

/** The cheapest and dearest hour of a day, as hour indexes (first one on ties). */
export function extremes(hours: readonly number[]): { cheapest: number; dearest: number } {
  let cheapest = 0;
  let dearest = 0;
  hours.forEach((value, hour) => {
    if (value < hours[cheapest]) cheapest = hour;
    if (value > hours[dearest]) dearest = hour;
  });
  return { cheapest, dearest };
}

/** Intro rise: 0 before the row's turn, easing out to 1 over `duration` ms. */
export function riseProgress(elapsedMs: number, dayIndex: number, staggerMs = 28, duration = 900): number {
  const t = (elapsedMs - dayIndex * staggerMs) / duration;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - (1 - t) ** 3;
}
