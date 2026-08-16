import React from 'react';
import ReactDOM from 'react-dom/client';
import { LazyMotion, MotionConfig } from 'framer-motion';
import App from './App';
import { registerCoopWorker } from './app/coop';
import { warmMediabunny } from './media/mediabunnyModule';
import { installGlobalErrorHandlers } from './app/globalErrors';
import { ErrorBoundary } from './ui/ErrorBoundary';
import i18n, { ensureLocale } from './i18n';
import './index.css';

// Before anything else mounts: a throw during boot is exactly the kind of
// failure that used to end at a blank page and a console nobody reads.
installGlobalErrorHandlers();

// Fire-and-forget: buys the multi-threaded ffmpeg core from the next visit on,
// and costs nothing when it fails.
registerCoopWorker();

// The media stack is not on the path to the first frame of UI, so it is not in
// the initial chunk. Warming it here means it is nonetheless already resident
// by the time anyone drags a file in.
warmMediabunny();

/** The DOM animation feature set: animations, variants and AnimatePresence exits. */
const loadMotionFeatures = () => import('framer-motion').then((mod) => mod.domAnimation);

function mount(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* `reducedMotion="user"` honours the OS setting for every motion component
        at once: with a dozen panels, sheets and menus animating, per-component
        `useReducedMotion()` calls were only ever going to cover some of them.
        Transform and layout animations are the ones dropped - the sliding and
        scaling that provoke motion sickness - while opacity keeps animating, so
        panels still fade in and out rather than snapping. */}
    {/* `LazyMotion` keeps the animation engine out of the initial chunk: the
        editor's motion is opacity and offset fades behind AnimatePresence, all
        of which lives in `domAnimation`, while the layout projection and drag
        engines it does not use stay unloaded. The components below are `m.*`
        rather than `motion.*` for the same reason - `motion.div` statically
        pulls in every feature. */}
    <LazyMotion features={loadMotionFeatures} strict>
    <MotionConfig reducedMotion="user">
      {/* Inside MotionConfig, outside App: the boundary must survive whatever
          App does, and the crash screen still wants the motion settings. */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </MotionConfig>
    </LazyMotion>
  </React.StrictMode>,
  );
}

// Only English is bundled; the visitor's own dictionary is a separate chunk.
// Awaited before the first render so the editor never paints in the wrong
// language, and never blocking for long: it is a few kilobytes fetched in
// parallel with everything else the page is already loading.
void ensureLocale(i18n.resolvedLanguage).finally(mount);
