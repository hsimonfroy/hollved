/**
 * This is the entry point to the app
 */
import './styles/main.less';

import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';
import HomePage from './home';
import GalaxyPage from './galaxy/galaxyPage.jsx';

var pendingNav = sessionStorage.getItem('_galaxyNav');
if (pendingNav) {
  sessionStorage.removeItem('_galaxyNav');
  window.location.hash = '/' + pendingNav;
}

createRoot(document.getElementById('app')).render(
  <HashRouter>
    <Routes>
      <Route path='/' element={<HomePage />} />
      <Route path='/:name' element={<GalaxyPage />} />
    </Routes>
  </HashRouter>
);
