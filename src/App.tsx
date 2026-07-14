import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { UploadCloud } from 'lucide-react';
import { useStore } from './store/store';
import { initPersistence } from './lib/persistence';
import { MenuBar } from './ui/MenuBar';
import { TopBar } from './ui/TopBar';
import { Transport } from './ui/Transport';
import { Toast } from './ui/Toast';
import { UnsupportedScreen, isSupported } from './ui/UnsupportedScreen';
import { PreviewCanvas } from './preview/PreviewCanvas';
import { Timeline } from './timeline/Timeline';
import { Inspector } from './inspector/Inspector';
import { ExportSheet } from './export/ExportSheet';
import { useImport } from './ui/useImport';
import { MediaLibrary } from './ui/MediaLibrary';
import { MobileBottomBar } from './ui/MobileBottomBar';
import { ShortcutsHelp } from './ui/ShortcutsHelp';
import { Preferences } from './ui/Preferences';
import { useEditorHotkeys } from './ui/useEditorHotkeys';
import { useIsCoarsePointer } from './lib/device';

const PREVIEW_FRAC_KEY = 'selfcut.previewFrac';
const DEFAULT_PREVIEW_FRAC = 0.42;

/** Draggable horizontal divider: resize the preview/timeline split (desktop). */
function SplitHandle({ onFrac }: { onFrac: (frac: number) => void }) {
  const { t } = useTranslation();
  const dragging = useRef(false);
  return (
    <div
      className="group relative z-10 -my-1 h-2 flex-none cursor-row-resize touch-none"
      title={t('app.split.handle')}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        // TopBar is 48px tall; the fraction is over the full viewport height.
        onFrac((e.clientY - 48) / window.innerHeight);
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onDoubleClick={() => onFrac(DEFAULT_PREVIEW_FRAC)}
    >
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-800 transition-colors group-hover:h-1 group-hover:bg-sky-500/60" />
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [supported] = useState(isSupported);
  const importFiles = useImport();
  const [dragging, setDragging] = useState(false);
  const coarse = useIsCoarsePointer();
  const [previewFrac, setPreviewFrac] = useState(() => {
    const stored = Number(localStorage.getItem(PREVIEW_FRAC_KEY));
    return stored >= 0.2 && stored <= 0.65 ? stored : DEFAULT_PREVIEW_FRAC;
  });
  const applyPreviewFrac = (frac: number) => {
    const clamped = Math.min(0.65, Math.max(0.2, frac));
    setPreviewFrac(clamped);
    localStorage.setItem(PREVIEW_FRAC_KEY, String(clamped));
  };

  useEditorHotkeys();

  // Restore the last session from IndexedDB and keep it saved from then on.
  useEffect(() => {
    void initPersistence();
  }, []);

  if (!supported) return <UnsupportedScreen />;

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-100"
      onDragOver={(e) => {
        e.preventDefault();
        // Internal asset drags (media library → timeline) must not trigger the import overlay.
        if (e.dataTransfer.types.includes('Files')) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      {!coarse && <MenuBar />}
      <TopBar />
      <div
        className="flex flex-none border-b border-zinc-800"
        style={{ height: coarse ? '34dvh' : `${previewFrac * 100}dvh` }}
      >
        <MediaLibrary />
        <div className="relative min-w-0 flex-1">
          <PreviewCanvas />
          <ImportingBadge />
        </div>
        {!coarse && <Inspector />}
      </div>
      {!coarse && <SplitHandle onFrac={applyPreviewFrac} />}
      <Transport />
      <Timeline />
      {coarse && <MobileBottomBar />}

      {coarse && <Inspector />}
      <ExportSheet />
      <ShortcutsHelp />
      <Preferences />
      <Toast />

      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 border-4 border-dashed border-sky-500 bg-sky-500/10 backdrop-blur-sm"
          >
            <UploadCloud className="h-12 w-12 text-sky-400" />
            <p className="text-sm font-medium text-sky-200">{t('app.drop.title')}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ImportingBadge() {
  const { t } = useTranslation();
  const importing = useStore((s) => s.importing);
  return (
    <AnimatePresence>
      {importing && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-200 shadow-lg"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
          {t('app.importing')}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
