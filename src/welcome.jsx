import { useState, useEffect } from 'react';
import config from './config.js';

var surveys = [
  { id: 'cfa',    name: 'CfA',    year: 1977, cardSide: 'above' },
  { id: '2dfgrs', name: '2dFGRS', year: 1997, cardSide: 'above' },
  { id: 'sdss',   name: 'SDSS',   year: 2009, cardSide: 'above' },
  { id: 'quaia',  name: 'Quaia',  year: 2014, cardSide: 'below' },
  { id: 'desi',   name: 'DESI',   year: 2021, cardSide: 'above' },
];

var SURVEY_COLORS = {
  cfa:      '#7d92bc',
  '2dfgrs': '#bbaa88',
  sdss:     '#7164ba',
  quaia:    '#f1666a',
  desi:     '#44ddaa',
};

// SVG layout constants (preserving user's values, fixing CHART_BOTTOM)
var BOX_WIDTH  = 750;
var BOX_HEIGHT = 520;
var CHART_LEFT   = 70;
var CHART_RIGHT  = BOX_WIDTH - 10;
var CHART_TOP    = 40;
var CHART_BOTTOM = BOX_HEIGHT - 30;
var CHART_WIDTH  = CHART_RIGHT - CHART_LEFT;
var CHART_HEIGHT = CHART_BOTTOM - CHART_TOP;
var X_MIN = 1975, X_MAX = 2031;
var Y_LOG_MIN = 3.0, Y_LOG_MAX = 9.0;

// Logo dimensions (SVG units)
var LOGO_W      = 150;
var LOGO_H      = 100;
var LOGO_OFFSET = 30;  // gap between logo edge and segment line

function xScale(year) {
  return CHART_LEFT + (year - X_MIN) / (X_MAX - X_MIN) * CHART_WIDTH;
}

function yScale(count) {
  return CHART_BOTTOM - (Math.log10(count) - Y_LOG_MIN) / (Y_LOG_MAX - Y_LOG_MIN) * CHART_HEIGHT;
}

var Y_DECADES      = [3, 4, 5, 6, 7, 8];
var Y_SUPERSCRIPTS = ['\u00B3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078'];

var X_TICKS = [];
for (var yr = 1980; yr <= 2030; yr += 5) { X_TICKS.push(yr); }

// Compute logo top-left position for a survey given its loaded programs
function computeLogoPos(survey, progs) {
  if (!progs.length) return null;
  var sorted = progs.slice().sort(function(a, b) { return a.start - b.start; });

  // Place logo above or below the first program segment
  var cx = xScale((sorted[0].end + sorted[0].start) / 2);
  var segY = yScale(sorted[0].count);
    
  var logoY;
  if (survey.cardSide === 'above') {
    logoY = segY - LOGO_OFFSET - LOGO_H;
  } else {
    logoY = segY + LOGO_OFFSET;
  }
  return { logoX: cx - LOGO_W / 2, logoY: logoY };
}

function SurveyTimeline({ surveys, surveysData, logoErrors, onLogoError }) {
  // Build flat program list, carrying cardSide from the parent survey
  var programs = [];
  surveys.forEach(function(s) {
    var manifest = surveysData[s.id];
    if (!manifest || !manifest.programs) return;
    manifest.programs.forEach(function(p) {
      programs.push({
        surveyId: s.id,
        cardSide: s.cardSide,
        name: p.name,
        start: p.start,
        end: p.end,
        count: p.count,
        color: SURVEY_COLORS[s.id],
      });
    });
  });

  // Compute logo positions per survey
  var logoData = surveys.map(function(s) {
    var manifest = surveysData[s.id];
    var progs = (manifest && manifest.programs) ? manifest.programs : [];
    return { survey: s, pos: computeLogoPos(s, progs) };
  });

  var midY = (CHART_TOP + CHART_BOTTOM) / 2;

  return (
    <div className='survey-timeline-wrap'>
      <svg
        viewBox={'0 0 '+ BOX_WIDTH +' '+ BOX_HEIGHT}
        style={{ width: 'min(100%, '+ BOX_WIDTH +'px)', minWidth: '256px', height: 'auto' }}
        aria-label='Survey timeline'
      >
        {/* Y-axis grid lines + decade labels */}
        {Y_DECADES.map(function(exp, i) {
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
                {'10' + Y_SUPERSCRIPTS[i]}
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
          var labelY = p.cardSide === 'below' ? sy + 20 : sy - 9;
          return (
            <g key={p.surveyId + '-' + p.name}>
              <line
                x1={x1} y1={sy} x2={x2} y2={sy}
                stroke={p.color} strokeWidth={6} strokeLinecap='round'
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

        {/* Survey logos — bare clickable images, no card background */}
        {logoData.map(function(ld) {
          if (!ld.pos || logoErrors[ld.survey.id]) return null;
          var s = ld.survey;
          return (
            <a key={s.id} href={'#/' + s.id} className='timeline-card'>
              <image
                href={config.dataUrl + s.id + '/logo.png'}
                x={ld.pos.logoX} y={ld.pos.logoY}
                width={LOGO_W} height={LOGO_H}
                preserveAspectRatio='xMidYMid meet'
                onError={function() { onLogoError(s.id); }}
              />
            </a>
          );
        })}
      </svg>
    </div>
  );
}

export default function WelcomePage() {
  var [surveysData, setSurveysData] = useState({});
  var [logoErrors, setLogoErrors] = useState({});

  useEffect(function() {
    surveys.forEach(function(s) {
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
        surveys={surveys}
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
