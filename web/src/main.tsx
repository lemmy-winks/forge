import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DashboardApp from './dashboard';
import { openQueue, flushQueue } from './queue';
import { applyPalette, applyTheme, storedPalette, storedTheme } from './ui';
import './styles.css';

applyTheme(storedTheme()); // before first paint — prefs sync again after sign-in
applyPalette(storedPalette());
openQueue().then(() => flushQueue());

const isDashboard = location.pathname.startsWith('/dashboard');

/* iOS keyboard handling: size the app to the *visual* viewport and undo the
   automatic pan Safari applies when an input near the bottom gets focus.
   Not on /dashboard — that page scrolls the body normally. */
if (!isDashboard && window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    // Engage only when the keyboard is actually up — iOS reports transiently
    // short viewports during launch, which must not stick as the app height.
    const keyboardUp = document.documentElement.clientHeight - vv.height > 80;
    if (keyboardUp) {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
      window.scrollTo(0, 0);
    } else {
      document.documentElement.style.removeProperty('--vvh');
    }
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDashboard ? <DashboardApp /> : <App />}
  </StrictMode>,
);
