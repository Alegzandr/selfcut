import React from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import App from './App';
import { registerCoopWorker } from './app/coop';
import './i18n';
import './index.css';

// Fire-and-forget: buys the multi-threaded ffmpeg core from the next visit on,
// and costs nothing when it fails.
registerCoopWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* `reducedMotion="user"` honours the OS setting for every motion component
        at once: with a dozen panels, sheets and menus animating, per-component
        `useReducedMotion()` calls were only ever going to cover some of them.
        Transform and layout animations are the ones dropped - the sliding and
        scaling that provoke motion sickness - while opacity keeps animating, so
        panels still fade in and out rather than snapping. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
