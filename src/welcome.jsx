import { useState } from 'react';
import config from './config.js';

var surveys = [
  { id: 'desi',  name: 'DESI' },
  { id: 'quaia', name: 'Quaia' },
  { id: 'sdss',  name: 'SDSS' },
];

function SurveyCard({ id, name }) {
  var [logoError, setLogoError] = useState(false);
  return (
    <a href={'#/' + id} className='survey-card'>
      {!logoError && (
        <img
          src={config.dataUrl + id + '/logo.png'}
          alt={name}
          onError={function() { setLogoError(true); }}
        />
      )}
      <span className='survey-card-name'>{name}</span>
    </a>
  );
}

export default function WelcomePage() {
  return (
    <div className='welcome-page'>
      <h1 className='welcome-title'>Lost in expansion</h1>
      <p className='welcome-subtitle'>Explore the largest 3D maps of the (observable) Universe!</p>
      <div className='survey-grid'>
        {surveys.map(function(s) {
          return <SurveyCard key={s.id} id={s.id} name={s.name} />;
        })}
      </div>
      <div className='welcome-description'>
        <ul>
          <li>The observation that galaxies appear redder the further they are has led to the cosmological discovery that <strong>the Universe is expanding</strong>.</li>
          <li>By measuring how <strong>redshifted</strong> a galaxy's light is, spectroscopic surveys can infer how much the Universe has expanded since that light was emitted, and therefore how far away the galaxy lies.</li>
          <li>Current surveys catalogue millions of galaxies, charting the cosmic web across billions of light-years and revealing the history and fate of the Universe. <strong>So pick a survey, and dive into the deep!</strong></li>
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
