import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DashboardApp from './dashboard';
import { openQueue, flushQueue } from './queue';
import { applyTheme, storedTheme } from './ui';
import './styles.css';

applyTheme(storedTheme()); // before first paint — prefs sync again after sign-in
openQueue().then(() => flushQueue());

const isDashboard = location.pathname.startsWith('/dashboard');

/* iOS keyboard handling: size the app to the *visual* viewport and undo the
   automatic pan Safari applies when an input near the bottom gets focus.
   Not on /dashboard — that page scrolls the body normally. */
if (!isDashboard && window.visualViewport) {
  const vv = window.visualViewport;
  // The keyboard can only be up while an editable element has focus — a short
  // viewport alone is NOT enough: iOS reports transiently short visual
  // viewports during the standalone launch animation, and if that reading
  // sticks as --vvh the app renders with dead space under the tab bar.
  const editing = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
      || (el as HTMLElement).isContentEditable);
  };
  const sync = () => {
    const keyboardUp = editing() && document.documentElement.clientHeight - vv.height > 80;
    if (keyboardUp) {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
      window.scrollTo(0, 0);
    } else {
      document.documentElement.style.removeProperty('--vvh');
    }
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  // keyboard dismissal doesn't always fire a viewport event; focus changes do
  window.addEventListener('focusin', () => setTimeout(sync, 60));
  window.addEventListener('focusout', () => setTimeout(sync, 60));
  document.addEventListener('visibilitychange', sync);
  // clear anything the launch transients left behind once the UI settles
  setTimeout(sync, 400);
  setTimeout(sync, 1500);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDashboard ? <DashboardApp /> : <App />}
  </StrictMode>,
);
