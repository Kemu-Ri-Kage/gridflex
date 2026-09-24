'use client';

import * as React from 'react';

import { formatPrice } from '@/lib/format';
import { dayLabel } from '@/lib/markets';
import {
  barCentre,
  barFaces,
  depth,
  extremes,
  fitScale,
  GRID_HEIGHT,
  hexRgb,
  inside,
  mix,
  brightness,
  project,
  riseProgress,
  type Camera,
  type Face,
  type PriceGrid,
} from '@/lib/price-grid';
import { usePriceGrid } from '@/lib/site-data';

const HOURS = 24;
/** Resting turn and tilt, radians: hours run diagonally, days recede to the top right. */
const BASE_YAW = -0.62;
const BASE_PITCH = 0.5;
/** The idle sway's reach and period. */
const SWAY = 0.28;
const SWAY_MS = 16_000;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function hourText(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

interface Palette {
  background: [number, number, number];
  foreground: [number, number, number];
  dim: [number, number, number];
  up: [number, number, number];
  down: [number, number, number];
  warning: [number, number, number];
  border: string;
  muted: string;
  font: string;
}

/** Canvas can't resolve var(...): read the tokens once from the stylesheet. */
function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: hexRgb(token('--background', '#0a0b0d')),
    foreground: hexRgb(token('--foreground', '#e7e9ed')),
    dim: hexRgb(token('--border', '#262a33')),
    up: hexRgb(token('--up', '#1fce7a')),
    down: hexRgb(token('--down', '#ef4444')),
    warning: hexRgb(token('--warning', '#e8a33d')),
    border: token('--border', '#262a33'),
    muted: token('--muted-foreground', '#9aa1ac'),
    font: token('--font-geist-mono', 'ui-monospace, monospace'),
  };
}

interface Bar {
  day: number;
  hour: number;
  faces: Face[];
  depth: number;
}

interface View {
  yawOffset: number;
  pitch: number;
  hover: { day: number; hour: number } | null;
  bars: Bar[];
}

/** Every bar at this moment, far to near, with its visible faces. */
function layout(grid: PriceGrid, camera: Camera, maxCents: number, elapsed: number, still: boolean): Bar[] {
  const days = grid.days.length;
  const bars: Bar[] = [];
  grid.days.forEach((day, d) => {
    const rise = still ? 1 : riseProgress(elapsed, d);
    day.hours.forEach((cents, hour) => {
      const { x, z } = barCentre(hour, d, HOURS, days);
      const height = Math.max(0.02, (Math.max(0, cents) / maxCents) * GRID_HEIGHT * rise);
      bars.push({ day: d, hour, faces: barFaces(x, z, height, camera), depth: depth(x, z, camera.yaw) });
    });
  });
  return bars.sort((a, b) => a.depth - b.depth);
}

function fill(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[], colour: string) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

/**
 * The landing hero's centrepiece: every hour of the last 30 published days
 * of the day-ahead Texas power price, the same hourly prices the daily
 * price markets settle on is the average of, as a field of bars. The
 * headline's two hours - the latest day's cheapest and dearest - are the
 * green and red bars in the nearest row. It carries the page's argument:
 * the swing is every day, not one bad afternoon.
 *
 * Canvas 2D with its own small projection (lib/price-grid.ts) rather than a
 * 3D library: 720 flat-shaded bars need no more, and the page stays light.
 * Rows rise on load and the field sways slowly; drag turns and tilts it;
 * hovering reads out the hour. Under prefers-reduced-motion it is drawn
 * once, still, and only redrawn when the viewer drags or hovers.
 */
export function PriceGrid3D() {
  const grid = usePriceGrid();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const readoutRef = React.useRef<HTMLDivElement | null>(null);

  const summary = React.useMemo(() => {
    if (!grid) return null;
    const latest = grid.days[grid.days.length - 1];
    const maxCents = Math.max(...grid.days.flatMap((day) => day.hours));
    return { latest, maxCents, ...extremes(latest.hours) };
  }, [grid]);

  const restingText = React.useMemo(() => {
    if (!summary) return '';
    const { latest } = summary;
    return `${dayLabel(latest.dayKey, true)} · average ${formatPrice(latest.average, 'MWh')}, the price markets settle on`;
  }, [summary]);

  React.useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const readout = readoutRef.current;
    const ctx = canvas?.getContext('2d');
    if (!grid || !summary || !container || !canvas || !readout || !ctx) return;

    const palette = readPalette();
    const still = prefersReducedMotion();
    const days = grid.days.length;
    const view: View = { yawOffset: 0, pitch: BASE_PITCH, hover: null, bars: [] };
    let width = 0;
    let height = 0;
    let started = -1;
    let frame = 0;
    let visible = true;
    let dragging: { x: number; y: number } | null = null;

    const camera = (elapsed: number): Camera => {
      const sway = still ? 0 : SWAY * Math.sin((elapsed / SWAY_MS) * Math.PI * 2);
      const scale = fitScale(width, height * 0.9, HOURS, days, view.pitch);
      return {
        yaw: BASE_YAW + sway + view.yawOffset,
        pitch: view.pitch,
        scale,
        cx: width / 2,
        // Centre the field and its tallest bars, not just the ground.
        cy: height / 2 + (GRID_HEIGHT * Math.cos(view.pitch) * scale) / 2.4,
      };
    };

    const colourOf = (bar: Bar, light: number): string => {
      const cents = grid.days[bar.day].hours[bar.hour];
      const latest = bar.day === days - 1;
      let base: string;
      if (view.hover && view.hover.day === bar.day && view.hover.hour === bar.hour) {
        base = mix(palette.background, palette.warning, light);
      } else if (latest && bar.hour === summary.cheapest) {
        base = mix(palette.background, palette.up, light);
      } else if (latest && bar.hour === summary.dearest) {
        base = mix(palette.background, palette.down, light);
      } else {
        const tone = brightness(cents, summary.maxCents);
        const [r, g, b] = palette.dim.map((c, i) => c + (palette.foreground[i] - c) * tone);
        base = mix(palette.background, [r, g, b], light);
      }
      return base;
    };

    const labels = (cam: Camera) => {
      ctx.font = `10px ${palette.font}`;
      ctx.fillStyle = palette.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Hours along the nearest row, days down the left edge.
      const front = barCentre(0, days - 1, HOURS, days).z + 2.2;
      for (const hour of [6, 12, 18]) {
        const { x } = barCentre(hour, 0, HOURS, days);
        const p = project(x, 0, front, cam);
        ctx.fillText(hourText(hour), p.x, p.y);
      }
      const left = barCentre(0, 0, HOURS, days).x - 3.2;
      for (const d of [0, days - 1]) {
        const { z } = barCentre(0, d, HOURS, days);
        const p = project(left, 0, z, cam);
        ctx.fillText(dayLabel(grid.days[d].dayKey), p.x, p.y);
      }
    };

    const draw = (now: number) => {
      if (started < 0) started = now;
      const elapsed = now - started;
      const cam = camera(elapsed);
      ctx.clearRect(0, 0, width, height);

      // The ground: a hairline outline of the grid's footprint.
      const half = { x: HOURS / 2, z: days / 2 };
      const ground = [
        project(-half.x, 0, -half.z, cam),
        project(half.x, 0, -half.z, cam),
        project(half.x, 0, half.z, cam),
        project(-half.x, 0, half.z, cam),
      ];
      ctx.beginPath();
      ground.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = palette.border;
      ctx.lineWidth = 1;
      ctx.stroke();

      view.bars = layout(grid, cam, summary.maxCents, elapsed, still);
      for (const bar of view.bars) {
        for (const face of bar.faces) fill(ctx, face.points, colourOf(bar, face.light));
      }
      labels(cam);
      return elapsed;
    };

    const loop = (now: number) => {
      const elapsed = draw(now);
      // Keep animating while visible; under reduced motion, only on demand.
      const rising = elapsed < days * 28 + 900;
      if (visible && (!still || rising || dragging)) frame = requestAnimationFrame(loop);
      else frame = 0;
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(loop);
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      kick();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) kick();
    });
    intersection.observe(container);

    const showReadout = (hit: { day: number; hour: number } | null) => {
      if (!hit) {
        readout.textContent = restingText;
        return;
      }
      const day = grid.days[hit.day];
      readout.textContent = `${dayLabel(day.dayKey, true)} · ${hourText(hit.hour)} Central · ${formatPrice(day.hours[hit.hour], 'MWh')}`;
    };

    const pointFrom = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      kick();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging) {
        view.yawOffset += (event.clientX - dragging.x) * 0.006;
        view.pitch = Math.min(1.05, Math.max(0.3, view.pitch + (event.clientY - dragging.y) * 0.004));
        dragging = { x: event.clientX, y: event.clientY };
        kick();
        return;
      }
      // Nearest bar under the pointer: the list is far to near, so search backwards.
      const point = pointFrom(event);
      let hit: { day: number; hour: number } | null = null;
      for (let i = view.bars.length - 1; i >= 0 && !hit; i--) {
        const bar = view.bars[i];
        if (bar.faces.some((face) => inside(point, face.points))) hit = { day: bar.day, hour: bar.hour };
      }
      if (hit?.day !== view.hover?.day || hit?.hour !== view.hover?.hour) {
        view.hover = hit;
        showReadout(hit);
        kick();
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onPointerLeave = () => {
      if (dragging) return;
      view.hover = null;
      showReadout(null);
      kick();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    showReadout(null);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [grid, summary, restingText]);

  const first = grid?.days[0];
  const last = grid?.days[grid.days.length - 1];
  const label =
    first && last && summary
      ? `Every hour of the day-ahead Texas power price from ${dayLabel(first.dayKey, true)} to ${dayLabel(last.dayKey, true)}, as bars; the highest hour was ${formatPrice(summary.maxCents, 'MWh')}.`
      : 'Hourly Texas power prices, loading.';

  return (
    <figure className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1" ref={containerRef}>
        <canvas
          aria-hidden="true"
          className="absolute inset-0 cursor-grab touch-pan-y active:cursor-grabbing"
          ref={canvasRef}
        />
        <p className="sr-only">{label}</p>
        <div
          aria-live="polite"
          className="pointer-events-none absolute top-0 left-0 font-mono text-xs tabular-nums text-foreground"
          ref={readoutRef}
        />
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] leading-5 text-muted-foreground">
        <span>Every hour, last {grid?.days.length ?? 30} published days · day-ahead Texas power price, $/MWh</span>
        {last && (
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block size-2 bg-up" />
              cheapest hour, {dayLabel(last.dayKey)}
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block size-2 bg-down" />
              dearest
            </span>
          </span>
        )}
        <span className="hidden sm:inline">Drag to turn</span>
      </figcaption>
    </figure>
  );
}
