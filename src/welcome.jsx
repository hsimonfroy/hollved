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
      <p className='welcome-subtitle'>Explore the largest 3D maps of the (visible) Universe!</p>
      <div className='survey-grid'>
        {surveys.map(function(s) {
          return <SurveyCard key={s.id} id={s.id} name={s.name} />;
        })}
      </div>
      <footer className='welcome-footer'>
        MIT License &middot; Copyright &copy; 2025{' '}
        <a href='https://hsimonsfroy.github.io/' target='_blank' rel='noopener noreferrer'>
          Hugo Simon
        </a>
      </footer>
    </div>
  );
}
