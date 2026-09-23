/**
 * What the settlement-price chart draws on Lightweight Charts' canvas, in
 * the chart's own coordinates, so it stays anchored at any zoom: the daily
 * candles (a custom series, for the thin bodies, hollow or light up
 * candles and the caret on a capped wick), and the strike ladder (a series
 * primitive: the shade above the selected strike, every strike's dashed
 * line and its listed days, and its price tag on the axis).
 */
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type ISeriesPrimitiveAxisView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';

import { labelLeft, spreadLabels } from '@/lib/strike-ladder';

type DrawTarget = Parameters<ICustomSeriesPaneRenderer['draw']>[0];

/** One day, in dollars: its hourly open, high, low and close, and the daily average. */
export interface CandlePoint extends CustomData<Time> {
  dayKey: number;
  open: number;
  high: number;
  low: number;
  close: number;
  average: number;
}

/** Up days drawn as an outline, or filled lighter than down days. */
export type CandleStyle = 'hollow' | 'light';

export interface CandlePalette {
  up: string;
  /** --up at reduced opacity, for light up bodies. */
  upLight: string;
  down: string;
  /** A day that closed exactly at its open. */
  flat: string;
  background: string;
}

/**
 * Shared between the candle series' autoscale provider and its renderer:
 * the price the visible scale stops at when a wick runs past it, or null.
 */
export interface ScaleState {
  cap: number | null;
}

/**
 * Body width for the space each day gets, in px: about half the space when
 * days are packed tight, growing more slowly than the space as the chart
 * zooms in, so the gaps widen with it and a zoomed candle stays a candle
 * rather than a block.
 */
export function bodyWidthFor(barSpacing: number): number {
  return Math.min(barSpacing * 0.55, 3 + barSpacing * 0.18);
}

/** The caret over a wick that runs past the capped scale, in px. */
export const CARET_WIDTH = 9;
export const CARET_HEIGHT = 7;
/** Space between the cut wick and its caret, so the break reads as deliberate. */
export const CARET_GAP = 3;
/** Room above the cap for the carets. */
export const TOP_MARGIN = CARET_GAP + CARET_HEIGHT + 6;

class CandleRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, CandlePoint> | null = null;

  constructor(
    private readonly style: CandleStyle,
    private readonly palette: CandlePalette,
    private readonly scale: ScaleState,
  ) {}

  draw(target: DrawTarget, priceToCoordinate: PriceToCoordinateConverter): void {
    const data = this.data;
    if (!data?.visibleRange) return;
    const { bars, barSpacing, visibleRange } = data;
    const { style, palette, scale } = this;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const bodyWidth = Math.max(1, Math.round(bodyWidthFor(barSpacing) * hpr));
      const wickWidth = Math.max(1, Math.floor(hpr));
      const line = Math.max(1, Math.floor(hpr));
      // Narrower than CARET_WIDTH when days are packed tight, so neighbouring
      // carets stay apart.
      const caretHalf = Math.min(CARET_WIDTH / 2, Math.max(2.5, barSpacing * 0.45)) * hpr;
      const cap = scale.cap;
      const capY = cap === null ? null : priceToCoordinate(cap);

      for (let i = visibleRange.from; i < visibleRange.to; i++) {
        const bar = bars[i];
        const d = bar?.originalData;
        if (!d || d.close === undefined) continue;
        const ys = [d.open, d.close, d.high, d.low].map((price) => priceToCoordinate(price));
        if (ys.some((y) => y === null)) continue;
        const [yOpen, yClose, yHigh, yLow] = (ys as number[]).map((y) => Math.round(y * vpr));
        const clipped = cap !== null && capY !== null && d.high > cap;
        const topLimit = clipped ? Math.round((capY as number) * vpr) : yHigh;

        const direction = d.close > d.open ? 'up' : d.close < d.open ? 'down' : 'flat';
        const color = direction === 'up' ? palette.up : direction === 'down' ? palette.down : palette.flat;
        const center = Math.round(bar.x * hpr);
        const left = center - Math.floor(bodyWidth / 2);
        let bodyTop = Math.max(Math.min(yOpen, yClose), topLimit);
        const bodyBottom = Math.max(Math.max(yOpen, yClose), bodyTop + line);
        bodyTop = Math.min(bodyTop, bodyBottom - line);

        // The wick in two pieces, above and below the body, so a hollow
        // body stays empty inside.
        ctx.fillStyle = color;
        const wickLeft = center - Math.floor(wickWidth / 2);
        if (bodyTop > topLimit) ctx.fillRect(wickLeft, topLimit, wickWidth, bodyTop - topLimit);
        if (yLow > bodyBottom) ctx.fillRect(wickLeft, bodyBottom, wickWidth, yLow - bodyBottom);

        const height = bodyBottom - bodyTop;
        if (direction === 'up' && style === 'hollow' && bodyWidth >= 3 * line && height >= 3 * line) {
          ctx.fillRect(left, bodyTop, bodyWidth, line);
          ctx.fillRect(left, bodyBottom - line, bodyWidth, line);
          ctx.fillRect(left, bodyTop, line, height);
          ctx.fillRect(left + bodyWidth - line, bodyTop, line, height);
        } else {
          ctx.fillStyle = direction === 'up' && style === 'light' ? palette.upLight : color;
          ctx.fillRect(left, bodyTop, bodyWidth, height);
        }

        if (clipped) {
          const base = topLimit - CARET_GAP * vpr;
          const tip = base - CARET_HEIGHT * vpr;
          ctx.beginPath();
          ctx.moveTo(center - caretHalf, base);
          ctx.lineTo(center, tip);
          ctx.lineTo(center + caretHalf, base);
          ctx.closePath();
          ctx.lineJoin = 'round';
          ctx.lineWidth = 1.5 * hpr;
          ctx.strokeStyle = palette.background;
          ctx.stroke();
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    });
  }
}

/** The daily candles as a Lightweight Charts custom series. */
export class CandleSeriesView implements ICustomSeriesPaneView<Time, CandlePoint, CustomSeriesOptions> {
  private readonly paneRenderer: CandleRenderer;

  constructor(style: CandleStyle, palette: CandlePalette, scale: ScaleState) {
    this.paneRenderer = new CandleRenderer(style, palette, scale);
  }

  renderer(): ICustomSeriesPaneRenderer {
    return this.paneRenderer;
  }

  update(data: PaneRendererCustomData<Time, CandlePoint>): void {
    this.paneRenderer.data = data;
  }

  priceValueBuilder(point: CandlePoint): number[] {
    return [point.low, point.high, point.close];
  }

  isWhitespace(point: CandlePoint | WhitespaceData<Time>): point is WhitespaceData<Time> {
    return (point as Partial<CandlePoint>).close === undefined;
  }

  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}

/** One listed strike: its price in dollars, its tag and the days it settles. */
export interface LadderLine {
  price: number;
  tag: string;
  days: string;
  selected: boolean;
}

export interface LadderPalette {
  warning: string;
  muted: string;
  background: string;
  font: string;
}

/** Label size and the minimum vertical gap between two labels (px). */
const LABEL_FONT = 10;
const LABEL_GAP = 14;
/** The height of a price-scale tag at the chart's 10px axis font. */
const TAG_GAP = 17;

type MediaScope = Parameters<Parameters<DrawTarget['useMediaCoordinateSpace']>[0]>[0];

function paneRenderer(draw: (scope: MediaScope) => void, background = false): IPrimitivePaneRenderer {
  const run = (target: DrawTarget) => target.useMediaCoordinateSpace(draw);
  return background ? { draw: () => {}, drawBackground: run } : { draw: run };
}

/**
 * Every listed strike, redrawn from the series' own price scale on every
 * frame, so the lines, their labels and the shade stay put at any zoom.
 */
export class StrikeLadderPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private chart: SeriesAttachedParameter<Time>['chart'] | null = null;
  private requestUpdate: (() => void) | null = null;
  private lines: LadderLine[] = [];
  private ys: (number | null)[] = [];
  private tagYs: number[] = [];

  constructor(private readonly palette: LadderPalette) {}

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setLines(lines: LadderLine[]): void {
    this.lines = lines;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    const series = this.series;
    this.ys = this.lines.map((line) => (series ? series.priceToCoordinate(line.price) : null));
    this.tagYs = spreadLabels(
      this.ys.map((y) => y ?? -TAG_GAP),
      TAG_GAP,
      TAG_GAP / 2,
      (this.chart?.paneSize().height ?? Number.POSITIVE_INFINITY) - TAG_GAP / 2,
    );
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const { palette } = this;
    const lines = this.lines;
    const ys = this.ys;
    const selected = lines.findIndex((line) => line.selected);

    // A very light shade over where a day settles YES, behind the candles.
    const shade: IPrimitivePaneView = {
      zOrder: () => 'bottom',
      renderer: () =>
        paneRenderer(({ context, mediaSize }) => {
          const y = selected === -1 ? null : ys[selected];
          if (y === null || y === undefined) return;
          context.globalAlpha = 0.05;
          context.fillStyle = palette.warning;
          context.fillRect(0, 0, mediaSize.width, Math.min(Math.max(y, 0), mediaSize.height));
          context.globalAlpha = 1;
        }, true),
    };

    // Dashed lines, the selected one last so it sits on top, then each
    // strike's listed days at the left edge, spread so a $2 ladder stays
    // readable.
    const ladder: IPrimitivePaneView = {
      zOrder: () => 'top',
      renderer: () =>
        paneRenderer(({ context, mediaSize }) => {
          const order = lines.map((_, i) => i).sort((a, b) => Number(lines[a].selected) - Number(lines[b].selected));
          context.lineWidth = 1;
          context.setLineDash([4, 3]);
          for (const i of order) {
            const y = ys[i];
            if (y === null) continue;
            context.globalAlpha = lines[i].selected ? 1 : 0.45;
            context.strokeStyle = lines[i].selected ? palette.warning : palette.muted;
            context.beginPath();
            context.moveTo(0, Math.round(y) + 0.5);
            context.lineTo(mediaSize.width, Math.round(y) + 0.5);
            context.stroke();
          }
          context.setLineDash([]);

          const placed = lines.map((_, i) => ys[i] ?? -LABEL_GAP);
          const labelYs = spreadLabels(
            placed.map((y) => y - LABEL_GAP / 2),
            LABEL_GAP,
            LABEL_GAP / 2,
            mediaSize.height - LABEL_GAP / 2,
          );
          context.font = `${LABEL_FONT}px ${palette.font}`;
          context.textBaseline = 'middle';
          context.lineJoin = 'round';
          for (const i of order) {
            if (ys[i] === null) continue;
            const text = lines[i].selected ? `Strike · ${lines[i].days}` : lines[i].days;
            context.globalAlpha = lines[i].selected ? 1 : 0.75;
            // A halo in the background colour keeps the label legible
            // over the candles without a box hiding them.
            context.lineWidth = 3;
            context.strokeStyle = palette.background;
            // Clear of the attribution mark in the bottom-left corner.
            const x = labelLeft(labelYs[i], LABEL_GAP, mediaSize.height);
            context.strokeText(text, x, labelYs[i]);
            context.fillStyle = lines[i].selected ? palette.warning : palette.muted;
            context.fillText(text, x, labelYs[i]);
          }
          context.globalAlpha = 1;
        }),
    };

    return [shade, ladder];
  }

  /**
   * Each strike's price as a tag on the price scale, spread so tags $2 apart
   * don't cover each other, the selected one drawn last.
   */
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const { palette, lines } = this;
    const order = lines.map((_, i) => i).sort((a, b) => Number(lines[a].selected) - Number(lines[b].selected));
    return order.map((i) => ({
      coordinate: () => -1000,
      fixedCoordinate: () => this.tagYs[i],
      visible: () => this.ys[i] !== null,
      text: () => lines[i].tag,
      textColor: () => (lines[i].selected ? palette.background : palette.muted),
      backColor: () => (lines[i].selected ? palette.warning : palette.background),
    }));
  }
}
