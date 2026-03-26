/**
 * This is the entry point to the app
 */
import './styles/main.less';

import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';
import WelcomePage from './welcome';
import GalaxyPage from './galaxy/galaxyPage.jsx';

createRoot(document.getElementById('app')).render(
  <HashRouter>
    <Routes>
      <Route path='/' element={<WelcomePage />} />
      <Route path='/:name' element={<GalaxyPage />} />
    </Routes>
  </HashRouter>
);
