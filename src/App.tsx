import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { UploadCloud } from 'lucide-react';
import { useStore } from './store/store';
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
import { ClipActionBar } from './ui/ClipActionBar';
import { ShortcutsHelp } from './ui/ShortcutsHelp';
import { useEditorHotkeys } from './ui/useEditorHotkeys';

export default function App() {
  const [supported] = useState(isSupported);
  const importFiles = useImport();
  const [dragging, setDragging] = useState(false);

  useEditorHotkeys();

  if (!supported) return <UnsupportedScreen />;

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-100"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
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
      <TopBar />
      <div className="flex h-[34dvh] flex-none border-b border-zinc-800 md:h-[42dvh]">
        <MediaLibrary />
        <div className="relative min-w-0 flex-1">
          <PreviewCanvas />
          <ImportingBadge />
        </div>
      </div>
      <Transport />
      <Timeline />

      <ClipActionBar />
      <Inspector />
      <ExportSheet />
      <ShortcutsHelp />
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
            <p className="text-sm font-medium text-sky-200">Drop your media files</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ImportingBadge() {
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
          Importing media…
        </motion.div>
      )}
    </AnimatePresence>
  );
}
