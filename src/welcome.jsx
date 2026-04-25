import { useState, useEffect } from 'react';
import config from './config.js';

var SPECTROSCOPY_COLORS = {
  'single-slit':         '#b6aea2',
  'manual multi-fiber':  '#afa6e1',
  'slitless':            '#f07d81',
  'robotic multi-fiber': '#44ddaa',
};

var SURVEYS = [
  { id: 'cfa',    cardSide: 'top',    nameSide: 'top'    },
  { id: '2dfgrs', cardSide: 'bottom', nameSide: 'bottom' },
  { id: 'sdss2',  cardSide: 'top',    nameSide: 'top'    },
  { id: 'sdss4',  cardSide: 'top',    nameSide: 'top'    },
  { id: 'quaia',  cardSide: 'bottom', nameSide: 'bottom' },
  { id: 'euclid', cardSide: 'bottom', nameSide: 'bottom' },
  { id: 'desi',   cardSide: 'top',    nameSide: 'top'    },
];

// SVG layout constants (preserving user's values, fixing CHART_BOTTOM)
var BOX_WIDTH  = 750;
var BOX_HEIGHT = 520;
var CHART_LEFT   = 65;
var CHART_RIGHT  = BOX_WIDTH - 10;
var CHART_TOP    = 0;
var CHART_BOTTOM = BOX_HEIGHT - 30;
var CHART_WIDTH  = CHART_RIGHT - CHART_LEFT;
var CHART_HEIGHT = CHART_BOTTOM - CHART_TOP;
var X_MIN = 1975, X_MAX = 2031;
var Y_LOG_MIN = 3.0, Y_LOG_MAX = 9.4;

// Card dimensions (SVG units)
var CARD_SIZE    = 90;  // square card outer size
var LOGO_X_OFFSET  = 10;   // gap between card outer edge and segment line
var LOGO_Y_OFFSET  = 30;   // gap between card outer edge and segment line
var CARD_PADDING = 5;   // padding inside card around logo

function xScale(year) {
  return CHART_LEFT + (year - X_MIN) / (X_MAX - X_MIN) * CHART_WIDTH;
}

function yScale(count) {
  return CHART_BOTTOM - (Math.log10(count) - Y_LOG_MIN) / (Y_LOG_MAX - Y_LOG_MIN) * CHART_HEIGHT;
}

var Y_DECADES = [3, 4, 5, 6, 7, 8];

var X_TICKS = [];
for (var yr = 1980; yr <= 2030; yr += 5) { X_TICKS.push(yr); }

// Compute logo top-left position for a survey given its loaded programs
function computeLogoPos(survey, progs) {
  if (!progs.length) return null;
  var sorted = progs.slice().sort(function(a, b) { return a.start - b.start; });
  var segY = yScale(sorted[0].count);
  var cx   = xScale((sorted[0].start + sorted[0].end) / 2);
  var logoX, logoY;

  if (survey.cardSide === 'top') {
    logoX = cx - CARD_SIZE / 2;
    logoY = segY - LOGO_Y_OFFSET - CARD_SIZE;
  } else if (survey.cardSide === 'bottom') {
    logoX = cx - CARD_SIZE / 2;
    logoY = segY + LOGO_Y_OFFSET;
  } else if (survey.cardSide === 'left') {
    logoX = xScale(sorted[0].start) - LOGO_X_OFFSET - CARD_SIZE;
    logoY = segY - CARD_SIZE / 2;
  } else { // 'right'
    logoX = xScale(sorted[sorted.length - 1].end) + LOGO_X_OFFSET;
    logoY = segY - CARD_SIZE / 2;
  }
  return { logoX: logoX, logoY: logoY, side: survey.cardSide };
}

function SurveyTimeline({ SURVEYS, surveysData, logoErrors, onLogoError }) {
  // Build flat program list, carrying cardSide from the parent survey
  var programs = [];
  SURVEYS.forEach(function(s) {
    var manifest = surveysData[s.id];
    if (!manifest || !manifest.programs) return;
    manifest.programs.forEach(function(p) {
      programs.push({
        surveyId: s.id,
        nameSide: s.nameSide,
        name: p.name,
        start: p.start,
        end: p.end,
        count: p.count,
        spectroscopy: p.spectroscopy || '',
        color: SPECTROSCOPY_COLORS[p.spectroscopy] || '#888888',
      });
    });
  });

  // Legend: unique spectroscopy types present in loaded data, in canonical order
  var TYPE_ORDER = ['single-slit', 'manual multi-fiber', 'slitless', 'robotic multi-fiber'];
  var seenSpec = {};
  var legendEntries = [];
  programs.forEach(function(p) {
    if (p.spectroscopy && !seenSpec[p.spectroscopy]) {
      seenSpec[p.spectroscopy] = true;
      legendEntries.push({ type: p.spectroscopy, color: p.color });
    }
  });
  legendEntries.sort(function(a, b) {
    return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
  });

  // Compute logo positions per survey
  var logoData = SURVEYS.map(function(s) {
    var manifest = surveysData[s.id];
    var progs = (manifest && manifest.programs) ? manifest.programs : [];
    return { survey: s, pos: computeLogoPos(s, progs) };
  });

  var midY = (CHART_TOP + CHART_BOTTOM) / 2;

  return (
    <div className='survey-timeline-wrap'>
      <svg
        viewBox={'0 0 '+ BOX_WIDTH +' '+ BOX_HEIGHT}
        style={{ width: 'min(100%, '+ BOX_WIDTH +'px)', height: 'auto' }}
        aria-label='Survey timeline'
      >
        {/* Y-axis grid lines + decade labels */}
        {Y_DECADES.map(function(exp) {
          var y = yScale(Math.pow(10, exp));
          return (
            <g key={exp}>
              <line
                x1={CHART_LEFT} y1={y} x2={CHART_RIGHT} y2={y}
                stroke='rgba(255,255,255,0.20)' strokeWidth={1}
              />
              <text
                x={CHART_LEFT - 10} y={y}
                textAnchor='end' dominantBaseline='middle'
                fontSize={14} fill='rgba(255,255,255,0.70)'
                fontFamily='Roboto, Consolas, monospace'
              >
                10<tspan dy='-8' fontSize='11'>{exp}</tspan>
              </text>
            </g>
          );
        })}

        {/* Rotated Y-axis label */}
        <text
          x={CHART_LEFT-50} y={midY}
          textAnchor='middle' fontSize={16} fill='rgba(255,255,255,0.70)'
          fontFamily='Roboto, sans-serif'
          transform={'rotate(-90,' + (CHART_LEFT-50) + ',' + midY + ')'}
        >
          Galaxies
        </text>

        {/* X-axis baseline
        <line
          x1={CHART_LEFT} y1={CHART_BOTTOM} x2={CHART_RIGHT} y2={CHART_BOTTOM}
          stroke='rgba(255,255,255,0.20)' strokeWidth={1}
        /> */}

        {/* X-axis ticks + year labels */}
        {X_TICKS.map(function(tickYear) {
          var x = xScale(tickYear);
          return (
            <g key={tickYear}>
              <line
                x1={x} y1={CHART_BOTTOM} x2={x} y2={CHART_BOTTOM + 5}
                stroke='rgba(255,255,255,0.50)' strokeWidth={1}
              />
              <text
                x={x} y={CHART_BOTTOM + 20}
                textAnchor='middle' fontSize={14} fill='rgba(255,255,255,0.70)'
                fontFamily='Roboto, Consolas, monospace'
              >
                {tickYear}
              </text>
            </g>
          );
        })}

        {/* Program segments + name labels */}
        {programs.map(function(p) {
          var x1 = xScale(p.start), x2 = xScale(p.end);
          var sy = yScale(p.count);
          var mx = (x1 + x2) / 2;
          var labelY = p.nameSide === 'bottom' ? sy + 20 : sy - 9;
          return (
            <g key={p.surveyId + '-' + p.name}>
              <line
                x1={x1} y1={sy} x2={x2} y2={sy}
                stroke={p.color} strokeWidth={5} strokeLinecap='round'
              />
              <text
                x={mx} y={labelY}
                textAnchor='middle' fontSize={14}
                fill='rgba(255,255,255,0.8)'
                fontFamily='Roboto, sans-serif'
              >
                {p.name}
              </text>
            </g>
          );
        })}

        {/* Clickable logos with card background */}
        {logoData.map(function(ld) {
          if (!ld.pos || logoErrors[ld.survey.id]) return null;
          var s = ld.survey;
          var pos = ld.pos;
          var imgSize = CARD_SIZE - 2 * CARD_PADDING;
          return (
            <a key={s.id} href={'#/' + s.id} className='timeline-card'>
              <rect
                x={pos.logoX} y={pos.logoY}
                width={CARD_SIZE} height={CARD_SIZE}
                rx={10}
                className='timeline-card-bg'
              />
              <image
                href={config.dataUrl + s.id + '/logo.png'}
                x={pos.logoX + CARD_PADDING} y={pos.logoY + CARD_PADDING}
                width={imgSize} height={imgSize}
                preserveAspectRatio='xMidYMid meet'
                onError={function() { onLogoError(s.id); }}
              />
            </a>
          );
        })}
        {/* Spectroscopy legend */}
        {legendEntries.length > 0 && (function() {
          var LW = 145, TITLE_H = 26, ROW_H = 20, PAD_B = 5;
          var LH = TITLE_H + legendEntries.length * ROW_H + PAD_B;
          var LX = CHART_LEFT + 5;
          var LY = CHART_TOP + 120;
        //   var LX = CHART_RIGHT - LW - 5;
        //   var LY = CHART_BOTTOM - LH - 2;
          return (
            <g>
              <rect
                x={LX} y={LY} width={LW} height={LH}
                fill='rgba(5,8,20,0.55)' stroke='rgba(255,255,255,0.22)'
                strokeWidth={1} rx={6}
              />
              <text
                x={LX + 12} y={LY + 16}
                fontSize={10} fill='rgba(255,255,255,0.45)'
                fontFamily='Roboto, sans-serif' fontWeight='bold' letterSpacing={1}
              >SPECTROSCOPY</text>
              {legendEntries.map(function(entry, i) {
                var rowY = LY + TITLE_H + i * ROW_H + ROW_H / 2;
                return (
                  <g key={entry.type}>
                    <line
                      x1={LX + 10} y1={rowY} x2={LX + 30} y2={rowY}
                      stroke={entry.color} strokeWidth={4} strokeLinecap='round'
                    />
                    <text
                      x={LX + 40} y={rowY + 4}
                      fontSize={12} fill='rgba(255,255,255,0.75)'
                      fontFamily='Roboto, sans-serif'
                    >{entry.type}</text>
                  </g>
                );
              })}
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

export default function WelcomePage() {
  var [surveysData, setSurveysData] = useState({});
  var [logoErrors, setLogoErrors] = useState({});

  useEffect(function() {
    SURVEYS.forEach(function(s) {
      fetch(config.dataUrl + s.id + '/manifest.json')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          setSurveysData(function(prev) {
            return Object.assign({}, prev, { [s.id]: data });
          });
        })
        .catch(function() {});
    });
  }, []);

  function handleLogoError(id) {
    setLogoErrors(function(prev) {
      return Object.assign({}, prev, { [id]: true });
    });
  }

  return (
    <div className='welcome-page'>
      <h1 className='welcome-title'>Lost in expansion</h1>
      <p className='welcome-subtitle'>Explore the largest 3D maps of the (observable) Universe</p>
      <SurveyTimeline
        SURVEYS={SURVEYS}
        surveysData={surveysData}
        logoErrors={logoErrors}
        onLogoError={handleLogoError}
      />
      <div className='welcome-description'>
        <ul>
          <li>The observation that galaxies appear redder the further they are has led to the cosmological discovery that <strong>the Universe is expanding!</strong></li>
          <li>By measuring how <strong>redshifted</strong> a galaxy's light is, <strong>spectroscopic surveys</strong> can infer how much the Universe has expanded since that light was emitted, and therefore how far away the galaxy lies.</li>
          <li><strong>Current surveys catalogue millions of galaxies</strong>, charting the cosmic web across billions of light-years and revealing the history and fate of the Universe. <strong>So pick a survey, and dive into the deep!</strong></li>
        </ul>
      </div>
      <div className='welcome-status'>
        <div className='welcome-status-title'>Status</div>
        <p>
          This project is currently in development. If you find it useful, consider sharing it, providing feedback, or starring ⭐ the{' '}
          <a href='https://github.com/hsimonfroy/hollved' target='_blank' rel='noopener noreferrer'>
            GitHub repository
          </a>.
        </p>
      </div>
      <footer className='welcome-footer'>
        MIT License &middot; Copyright &copy; 2025{' '}
        <a href='https://hsimonfroy.github.io/' target='_blank' rel='noopener noreferrer'>
          Hugo Simon
        </a>
      </footer>
    </div>
  );
}
