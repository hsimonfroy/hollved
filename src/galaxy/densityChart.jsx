// SVG layout constants — adjust these to resize the chart
var SVG_W  = 400;
var SVG_H  = 300;
var LEFT   = 65;
var RIGHT  = 0;
var TOP    = 10;
var BOTTOM = 46;
var W = SVG_W - LEFT - RIGHT;
var H = SVG_H - TOP - BOTTOM;

// Axis button dimensions — centered on their axis, adjust freely
var XBTN_W = 130;  var XBTN_H = 22;
var YBTN_W = 170;  var YBTN_H = 25;

export default function DensityChart({ tracers, densities, xMode, yMode, onXMode, onYMode }) {
  var nDensityTracers = densities.chi_Mpc.length;

  var visibleIndices = [];
  tracers.forEach(function(t, i) {
    if (i < nDensityTracers && t.visible) visibleIndices.push(i);
  });

  var rangeIndices = visibleIndices.length > 0 ? visibleIndices : (nDensityTracers > 0 ? [0] : []);

  var scales = computeScales(densities, rangeIndices, xMode, yMode);

  if (!scales) {
    return (
      <svg viewBox={'0 0 ' + SVG_W + ' ' + SVG_H} className="density-chart-svg">
        <text x={SVG_W / 2} y={SVG_H / 2} textAnchor="middle" className="density-chart-empty">
          No data
        </text>
      </svg>
    );
  }

  var { xMin, xMax, logMin, logMax, xTicks, yTicks } = scales;

  function xToSVG(v) {
    return LEFT + ((v - xMin) / (xMax - xMin)) * W;
  }

  function yToSVG(v) {
    if (v <= 0) return TOP + H + 9999;
    return TOP + H - ((Math.log10(v) - logMin) / (logMax - logMin)) * H;
  }

  var xLabel = xAxisLabel(xMode);
  var yLabel = yAxisLabel(yMode, xMode);

  // X axis button center
  var xBtnY = TOP + H + 30;
  // Y axis button center (in rotated local coords, centered on the chart)
  var yBtnCx = 15;
  var yBtnCy = TOP + H / 2;

  return (
    <svg viewBox={'0 0 ' + SVG_W + ' ' + SVG_H} width={SVG_W} height={SVG_H} className="density-chart-svg">
      <defs>
        <clipPath id="density-chart-clip">
          <rect x={LEFT} y={TOP} width={W} height={H} />
        </clipPath>
      </defs>

      {/* Y grid lines + tick labels */}
      {yTicks.map(function(v) {
        var sy = yToSVG(v);
        if (sy < TOP - 1 || sy > TOP + H + 1) return null;
        return (
          <g key={v}>
            <line x1={LEFT} y1={sy} x2={LEFT + W} y2={sy} className="density-grid-line" />
            <text x={LEFT - 4} y={sy + 3.5} textAnchor="end" className="density-tick-label">
              10<tspan dy={-6} fontSize={10}>{Math.round(Math.log10(v))}</tspan>
            </text>
          </g>
        );
      })}

      {/* X grid lines + tick labels */}
      {xTicks.map(function(v) {
        var sx = xToSVG(v);
        return (
          <g key={v}>
            <line x1={sx} y1={TOP} x2={sx} y2={TOP + H} className="density-grid-line" />
            <text x={sx} y={TOP + H + 12} textAnchor="middle" className="density-tick-label">
              {formatXTick(v, xMode)}
            </text>
          </g>
        );
      })}

      {/* Chart border */}
      <rect x={LEFT} y={TOP} width={W} height={H} className="density-chart-border" />

      {/* Density lines — clipped */}
      <g clipPath="url(#density-chart-clip)">
        {tracers.map(function(t, i) {
          if (i >= nDensityTracers || !t.visible) return null;
          var xs = getXArray(densities, i, xMode);
          var ys = getYArray(densities, i, xMode, yMode);
          if (!ys) return null;
          var pts = buildPoints(xs, ys, xToSVG, yToSVG);
          if (!pts) return null;
          return (
            <polyline
              key={t.id}
              points={pts}
              fill="none"
              stroke={colorToCSS(t.color)}
              strokeWidth="2"
              strokeOpacity="0.9"
              strokeLinejoin="round"
            />
          );
        })}
      </g>

      {/* Y axis button — rotated; rect and text both centered at local origin */}
      <g className="density-axis-btn"
         transform={'translate(' + yBtnCx + ',' + yBtnCy + ') rotate(-90)'}
         onClick={function() { onYMode(yMode === 'radial' ? 'volume' : 'radial'); }}>
        <rect x={-YBTN_W/2} y={-YBTN_H/2} width={YBTN_W} height={YBTN_H} rx={3} className="density-axis-btn-bg" />
        <text x={0} y={0} textAnchor="middle" dominantBaseline="middle"
              className="density-axis-btn-text">{yLabel}</text>
      </g>

      {/* X axis button — centered at (LEFT+W/2, xBtnY) */}
      <g className="density-axis-btn"
         transform={'translate(' + (LEFT + W / 2) + ',' + xBtnY + ')'}
         onClick={function() { onXMode(xMode === 'chi' ? 'z' : 'chi'); }}>
        <rect x={-XBTN_W/2} y={-XBTN_H/2} width={XBTN_W} height={XBTN_H} rx={3} className="density-axis-btn-bg" />
        <text x={0} y={0} textAnchor="middle" dominantBaseline="middle"
              className="density-axis-btn-text">{xLabel}</text>
      </g>
    </svg>
  );
}

// ── Axis label content ────────────────────────────────────────────────────────

function xAxisLabel(xMode) {
  return xMode === 'chi' ? 'Distance [Mpc]' : 'Redshift z';
}

function yAxisLabel(yMode, xMode) {
  if (yMode === 'volume') return <>Volume density [Mpc<tspan dy={-6} fontSize={10}>-3</tspan><tspan dy={8}>]</tspan></>;
  if (xMode === 'chi')    return <>Radial density [Mpc<tspan dy={-6} fontSize={10}>-1</tspan><tspan dy={8}>]</tspan></>;
  return 'Radial density';
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function getXArray(densities, i, xMode) {
  return xMode === 'chi' ? densities.chi_Mpc[i] : densities.z[i];
}

function getYArray(densities, i, xMode, yMode) {
  if (yMode === 'volume') return computeDndv(densities, i);
  return xMode === 'chi' ? densities.dndchi[i] : densities.dndz[i];
}

function computeDndv(densities, i) {
  var fsky = densities.footprint[i] / 41253;
  var chi  = densities.chi_Mpc[i];
  var dn   = densities.dndchi[i];
  return chi.map(function(c, j) {
    if (c <= 0) return 0;
    return dn[j] / (4 * Math.PI * c * c * fsky);
  });
}

function buildPoints(xs, ys, xToSVG, yToSVG) {
  var parts = [];
  for (var j = 0; j < xs.length; j++) {
    var y = ys[j];
    if (!y || y <= 0) continue;
    parts.push(xToSVG(xs[j]).toFixed(2) + ',' + yToSVG(y).toFixed(2));
  }
  return parts.length > 1 ? parts.join(' ') : null;
}

// ── Scale computation ─────────────────────────────────────────────────────────

function computeScales(densities, indices, xMode, yMode) {
  var allX = [], allY = [];
  indices.forEach(function(i) {
    var xs = getXArray(densities, i, xMode);
    var ys = getYArray(densities, i, xMode, yMode);
    if (!ys) return;
    for (var j = 0; j < xs.length; j++) {
      allX.push(xs[j]);
      if (ys[j] > 0) allY.push(ys[j]);
    }
  });
  if (allX.length === 0 || allY.length === 0) return null;

  var xMin = Math.min.apply(null, allX);
  var xMax = Math.max.apply(null, allX);
  if (xMin === xMax) xMax = xMin + 1;

  var yMinVal = Math.min.apply(null, allY);
  var yMaxVal = Math.max.apply(null, allY);
  var logMin = Math.floor(Math.log10(yMinVal));
  var logMax = Math.ceil(Math.log10(yMaxVal));
  if (logMax === logMin) logMax++;

  var xTicks = niceLinearTicks(xMin, xMax, 5);
  var yTicks = [];
  for (var e = logMin; e <= logMax; e++) yTicks.push(Math.pow(10, e));

  return { xMin, xMax, logMin, logMax, xTicks, yTicks };
}

// ── Tick helpers ──────────────────────────────────────────────────────────────

function niceLinearTicks(min, max, count) {
  var range = max - min;
  var mag = Math.pow(10, Math.floor(Math.log10(range / count)));
  var step = [1, 2, 5, 10].map(function(f) { return f * mag; })
    .find(function(s) { return range / s <= count + 1; }) || mag * 10;
  var start = Math.ceil(min / step) * step;
  var ticks = [];
  for (var v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(parseFloat(v.toFixed(10)));
  }
  return ticks;
}

function formatXTick(v, xMode) {
  if (xMode === 'z') return v.toFixed(v < 0.1 ? 3 : 2);
  return String(Math.round(v));
}

function colorToCSS(color32) {
  var r = (color32 >>> 24) & 0xff;
  var g = (color32 >>> 16) & 0xff;
  var b = (color32 >>> 8)  & 0xff;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
