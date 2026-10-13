/**
 * Small, dependency-free SVG charts.
 *
 * Design rules followed: thin marks (2px lines, <=24px bars), rounded data
 * ends with square baselines, a 2px surface-coloured gap between stacked
 * segments, hairline solid gridlines, one y-axis only, a legend whenever
 * there are 2+ series, hover tooltips on every chart, and a table elsewhere
 * on the page carrying the same numbers (so nothing depends on hovering).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { fmtInt } from '../format';

/** Round a step up to 1, 2, 2.5 or 5 x 10^n so axis ticks are clean numbers. */
function niceStep(rough) {
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * power;
}

function niceTicks(max, count = 5) {
  if (!max || max <= 0) return [0, 1];
  const step = niceStep(max / count);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/**
 * Label every n-th tick counted back from the last point, so the newest
 * period always has a label and two labels never crowd at the right edge.
 */
function showLabel(i, length, every) {
  return (length - 1 - i) % every === 0;
}

/**
 * Width of the chart's container in pixels. The SVG's viewBox uses this width,
 * so one SVG unit is one screen pixel and axis text renders at a true 12px.
 */
function useContainerWidth(fallback = 720) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Map a pointer event to SVG viewBox x. */
function pointerX(event, svg, viewWidth) {
  const rect = svg.getBoundingClientRect();
  return ((event.clientX - rect.left) / rect.width) * viewWidth;
}

/** Path for a bar with rounded top corners and a square bottom. */
function topRoundedBar(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/**
 * left and top are percentages of the chart box. Near the top of a chart the
 * tooltip opens below the point instead of above it, because cards clip
 * anything that spills outside them.
 */
function Tooltip({ left, top, title, rows }) {
  const below = top < 45;
  return (
    // Clamp so the tooltip never hangs off the left/right edge of the chart.
    <div
      className={`pointer-events-none absolute z-10 min-w-[144px] rounded-lg border border-border bg-popover px-2 py-2 text-xs whitespace-nowrap shadow-md ${below ? 'translate-x-[-50%] translate-y-4' : 'translate-x-[-50%] translate-y-[calc(-100%-16px)]'}`}
      style={{ left: `${Math.min(86, Math.max(14, left))}%`, top: `${top}%` }}
      role="status"
    >
      <div className="mb-1 text-muted-foreground">{title}</div>
      {rows.map((r) => (
        <div className="flex items-center gap-2" key={r.label}>
          {r.color && <span className="h-0.5 w-3 flex-none rounded-full" style={{ background: r.color }} />}
          <strong className="font-semibold text-foreground">{r.value}</strong>
          <span className="text-muted-foreground">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Horizontal bars with the value written at the tip of each bar.
 * items: [{ label, value, color, note }]
 */
export function BarList({ items, formatValue = fmtInt, max }) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="grid gap-2">
      {items.map((item) => (
        <div className="grid grid-cols-[minmax(112px,32%)_1fr] items-center gap-4" key={item.label}>
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">{item.label}</div>
          <div className="flex h-8 items-center gap-2">
            <div className="h-4 min-w-0.5 rounded-r-sm transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.max(0.5, (item.value / top) * 80)}%`, background: item.color }} />
            <span className="text-sm font-semibold whitespace-nowrap">{formatValue(item.value)}</span>
            {item.note && <span className="text-xs text-muted-foreground">{item.note}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One line over time with horizontal threshold lines and a crosshair tooltip.
 * data: [{ x: label, y: number }]; thresholds: [{ value, label, color }]
 * tooltipRows(point) -> extra rows for the tooltip
 */
export function LineChart({ data, thresholds = [], formatY = (v) => v, formatX = (x) => x, yTicks, tooltipRows, seriesLabel, height = 240 }) {
  const svgRef = useRef(null);
  const [boxRef, W] = useContainerWidth();
  const [hover, setHover] = useState(null);
  const H = height;
  const m = { top: 12, right: 92, bottom: 28, left: 40 };
  const innerW = W - m.left - m.right;
  const innerH = H - m.top - m.bottom;

  const maxY = Math.max(...data.map((d) => d.y ?? 0), ...thresholds.map((t) => t.value));
  const ticks = yTicks || niceTicks(maxY);
  const yMax = ticks[ticks.length - 1];
  const x = (i) => m.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v) => m.top + innerH - (v / yMax) * innerH;
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.y)}`).join(' ');
  const labelEvery = Math.ceil(data.length / 7);

  const onMove = (event) => {
    const px = pointerX(event, svgRef.current, W);
    const i = Math.round(((px - m.left) / innerW) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  const onKey = (event) => {
    if (event.key === 'ArrowRight') setHover((h) => Math.min(data.length - 1, (h ?? -1) + 1));
    if (event.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? data.length) - 1));
  };

  const point = hover !== null ? data[hover] : null;
  return (
    <div className="chart relative w-full" ref={boxRef}>
      <svg
        className="block h-auto w-full overflow-visible"
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${seriesLabel || 'Value'} over ${data.length} periods. Use arrow keys to read values.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'baseline' : 'grid-line'} x1={m.left} x2={m.left + innerW} y1={y(t)} y2={y(t)} />
            <text x={m.left - 8} y={y(t) + 4} textAnchor="end">{formatY(t)}</text>
          </g>
        ))}
        {thresholds.map((t) => (
          <g key={t.label}>
            <line x1={m.left} x2={m.left + innerW} y1={y(t.value)} y2={y(t.value)} stroke={t.color} strokeWidth={1.5} />
            <text x={m.left + innerW + 8} y={y(t.value) + 4}>{t.label}</text>
          </g>
        ))}
        {data.map((d, i) => showLabel(i, data.length, labelEvery) && (
          <text key={d.x} x={x(i)} y={H - 8} textAnchor="middle">{formatX(d.x)}</text>
        ))}
        <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={d.x} cx={x(i)} cy={y(d.y)} r={hover === i ? 5.5 : 4} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
        ))}
        {point && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + innerH} />}
        {/* Invisible layer that catches the pointer anywhere over the plot. */}
        <rect x={m.left - 10} y={m.top} width={innerW + 20} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {point && (
        <Tooltip
          left={(x(hover) / W) * 100}
          top={(y(point.y) / H) * 100}
          title={formatX(point.x)}
          rows={[{ label: seriesLabel || 'Value', value: formatY(point.y), color: 'var(--chart-1)' }, ...(tooltipRows ? tooltipRows(point) : [])]}
        />
      )}
    </div>
  );
}

/**
 * Stacked columns (e.g. monthly cost split into Snowflake and AWS).
 * data: [{ x, values: { key: number } }]; series: [{ key, label, color }]
 */
export function StackedColumns({ data, series, formatY = (v) => v, formatValue = formatY, formatX = (x) => x, height = 260 }) {
  const svgRef = useRef(null);
  const [boxRef, W] = useContainerWidth();
  const [hover, setHover] = useState(null);
  const H = height;
  const m = { top: 12, right: 8, bottom: 28, left: 56 };
  const innerW = W - m.left - m.right;
  const innerH = H - m.top - m.bottom;
  const GAP = 2; // surface-coloured gap between stacked segments

  const totals = data.map((d) => series.reduce((acc, s) => acc + (d.values[s.key] || 0), 0));
  const ticks = niceTicks(Math.max(...totals));
  const yMax = ticks[ticks.length - 1];
  const band = innerW / data.length;
  // Thin columns: at most 24px wide (one viewBox unit = one pixel).
  const barW = Math.min(24, band * 0.5);
  const y = (v) => m.top + innerH - (v / yMax) * innerH;
  const labelEvery = Math.ceil(data.length / 7);

  const onMove = (event) => {
    const px = pointerX(event, svgRef.current, W);
    const i = Math.floor((px - m.left) / band);
    setHover(i >= 0 && i < data.length ? i : null);
  };
  const onKey = (event) => {
    if (event.key === 'ArrowRight') setHover((h) => Math.min(data.length - 1, (h ?? -1) + 1));
    if (event.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? data.length) - 1));
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-2">
            <i className="inline-block size-2.5 rounded-xs" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="chart relative w-full" ref={boxRef}>
      <svg className="block h-auto w-full overflow-visible" ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Stacked columns per period. Use arrow keys to read values." tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'baseline' : 'grid-line'} x1={m.left} x2={m.left + innerW} y1={y(t)} y2={y(t)} />
            <text x={m.left - 8} y={y(t) + 4} textAnchor="end">{formatY(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = m.left + band * i + band / 2;
          let base = 0;
          const segments = series.map((s, si) => {
            const v = d.values[s.key] || 0;
            const y0 = y(base);
            const y1 = y(base + v);
            base += v;
            const isTop = si === series.length - 1;
            // Leave a 2px gap above every segment except the top one.
            const top = isTop ? y1 : y1 + GAP;
            const h = Math.max(0, y0 - top);
            return isTop
              ? <path key={s.key} d={topRoundedBar(cx - barW / 2, top, barW, h)} fill={s.color} />
              : <rect key={s.key} x={cx - barW / 2} y={top} width={barW} height={h} fill={s.color} />;
          });
          return (
            <g key={d.x} opacity={hover === null || hover === i ? 1 : 0.55}>
              {segments}
              {showLabel(i, data.length, labelEvery) && <text x={cx} y={H - 8} textAnchor="middle">{formatX(d.x)}</text>}
            </g>
          );
        })}
        <rect x={m.left} y={m.top} width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <Tooltip
          left={((m.left + band * hover + band / 2) / W) * 100}
          top={(y(totals[hover]) / H) * 100}
          title={formatX(data[hover].x)}
          rows={[
            ...[...series].reverse().map((s) => ({ label: s.label, value: formatValue(data[hover].values[s.key] || 0), color: s.color })),
            { label: 'Total', value: formatValue(totals[hover]) },
          ]}
        />
      )}
      </div>
    </div>
  );
}
