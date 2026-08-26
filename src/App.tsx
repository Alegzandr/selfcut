import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, m } from "framer-motion";
import {
  Cross2Icon,
  DownloadIcon,
  LightningBoltIcon,
  LinkBreak1Icon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { useStore } from "./store/store";
import { initPersistence } from "./lib/persistence";
import { saveProjectFile, unbindProjectFile } from "./lib/projectFile";
import { HEALTHY, getSaveHealth, subscribeSaveHealth } from "./lib/saveHealth";
import { openFolderPicker, openMediaPicker } from "./ui/mediaPicker";
import { MenuBar } from "./ui/MenuBar";
import { TopBar } from "./ui/TopBar";
import { Transport } from "./ui/Transport";
import { Toast } from "./ui/Toast";
import { UnsupportedScreen, isSupported } from "./ui/UnsupportedScreen";
import { PreviewCanvas } from "./preview/PreviewCanvas";
import { PreviewToolbar } from "./preview/PreviewToolbar";
import { Scopes } from "./preview/ScopesPanel";
import { ScopesMenu } from "./preview/ScopesMenu";
import { Timeline } from "./timeline/Timeline";
import { Inspector } from "./inspector/Inspector";
import { ExportSheet } from "./export/ExportSheet";
import { useImport } from "./ui/useImport";
import { MediaLibrary } from "./ui/MediaLibrary";
import { MobileBottomBar } from "./ui/MobileBottomBar";
import { ShortcutsHelp } from "./ui/ShortcutsHelp";
import { Preferences } from "./ui/Preferences";
import { About } from "./ui/About";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ProjectLibrary } from "./ui/ProjectLibrary";
import { confirmDiscardProject } from "./ui/projectActions";
import { ContextMenu } from "./ui/menu/ContextMenu";
import { A11yAnnouncer } from "./ui/A11yAnnouncer";
import { useEditorHotkeys } from "./ui/useEditorHotkeys";
import { useFileDragOverlay } from "./ui/useFileDragOverlay";
import { useIsCoarsePointer } from "./lib/device";
import { TrackSettingsSheet } from "./timeline/TrackSettingsSheet";
import { isSoftwareRendering } from "./lib/gpu";
import { PerfOverlay } from "./perf/PerfOverlay";

const PREVIEW_FRAC_KEY = "selfcut.previewFrac";
const DEFAULT_PREVIEW_FRAC = 0.42;

/** Draggable horizontal divider: resize the preview/timeline split (desktop). */
function SplitHandle({ onFrac }: { onFrac: (frac: number) => void }) {
  const { t } = useTranslation();
  const dragging = useRef(false);
  return (
    <div
      className="group relative z-10 -my-1 h-2 flex-none cursor-row-resize touch-none"
      title={t("app.split.handle")}
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
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-800 transition-colors group-hover:h-1 group-hover:bg-brand-500/60" />
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [supported] = useState(isSupported);
  const importFiles = useImport();
  const dragging = useFileDragOverlay();
  // While the timeline is showing where the files would land, the full-screen
  // overlay would only bury that preview under a wash of blue.
  const droppingOnTimeline = useStore((s) => s.dropPreview !== null);
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

  // The editor ships its own right-click menu, so the native one is suppressed
  // everywhere except text fields, where copy/paste/spellcheck stays useful.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (!supported) return <UnsupportedScreen />;

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-100"
      onDragOver={(e) => {
        // Accepting the drag everywhere is what keeps the browser from taking
        // the file over and navigating away from the editor. The overlay's own
        // state is tracked on the window, by `useFileDragOverlay`.
        e.preventDefault();
      }}
      onDrop={(e) => {
        // The timeline claims the file drops that land on it - it places them
        // at the exact spot they were let go. A prevented default is how it
        // says so; the event still reaches here, so the files are not imported
        // twice.
        if (e.isDefaultPrevented()) return;
        e.preventDefault();
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      {!coarse && <MenuBar />}
      <TopBar />
      <SoftwareRenderingBanner />
      <SaveFailureBanner />
      <DisconnectedBanner />
      <div
        className="flex flex-none border-b border-zinc-800"
        style={{ height: coarse ? "34dvh" : `${previewFrac * 100}dvh` }}
      >
        <MediaLibrary />
        <div className="relative min-w-0 flex-1">
          <PreviewCanvas />
          <PreviewToolbar />
          <ImportingBadge />
          <Scopes />
          <ScopesMenu />
          <PerfOverlay />
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
      <About />
      <ProjectLibrary />
      <ConfirmDialog />
      <TrackSettingsSheet />
      {/* Mounted on touch too: the track header's "…" button opens this same
          menu, and while it was desktop-only that button did nothing - track
          hide, expand, lock and per-track captions were unreachable on a
          phone. Nothing opens it by itself on touch (long-press keeps the
          native menu), so mounting it costs a null render. */}
      <ContextMenu />
      <Toast />
      <A11yAnnouncer />

      <AnimatePresence>
        {dragging && !droppingOnTimeline && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 border-4 border-dashed border-brand-500 bg-brand-500/10 backdrop-blur-sm"
          >
            <UploadIcon className="h-12 w-12 text-blue-400" />
            <p className="text-sm font-medium text-blue-200">
              {t("app.drop.title")}
            </p>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const GPU_WARNING_KEY = "selfcut.gpuWarningDismissed";

/**
 * Performance warning: shown when the browser is compositing in software.
 * Everything still works, so the banner is advisory and dismissible for good -
 * the user has to change a browser setting to fix it, and nagging every launch
 * would not help.
 */
function SoftwareRenderingBanner() {
  const { t } = useTranslation();
  // Probed once per session: the renderer cannot change while the page lives.
  const [software] = useState(() => {
    if (localStorage.getItem(GPU_WARNING_KEY) === "1") return false;
    return isSoftwareRendering();
  });
  const [dismissed, setDismissed] = useState(false);
  if (!software || dismissed) return null;

  return (
    <div className="flex flex-none items-center gap-x-3 gap-y-1.5 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
      <LightningBoltIcon className="h-4 w-4 flex-none text-amber-300" />
      <span className="min-w-0 flex-1">{t("gpu.softwareRendering")}</span>
      <button
        className="touch-hit flex-none rounded p-1 text-amber-200/80 hover:bg-amber-400/10 hover:text-amber-100"
        title={t("gpu.dismiss")}
        aria-label={t("gpu.dismiss")}
        onClick={() => {
          localStorage.setItem(GPU_WARNING_KEY, "1");
          setDismissed(true);
        }}
      >
        <Cross2Icon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Persistence warning: shown for as long as local saving is failing.
 *
 * A toast would be wrong here. Storage that is full or blocked stays full or
 * blocked, and the consequence - work that is not being saved - lasts as long
 * as the session does. So the warning lasts too, and it carries the one action
 * that actually rescues the work: writing the project out to a real file.
 */
function SaveFailureBanner() {
  const { t } = useTranslation();
  const health = useSyncExternalStore(
    subscribeSaveHealth,
    getSaveHealth,
    () => HEALTHY,
  );
  if (!health.failing) return null;

  return (
    <div
      role="status"
      className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100"
    >
      <DownloadIcon
        className="h-4 w-4 flex-none text-rose-300"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">{t("save.failing.message")}</span>
      <button
        className="flex-none rounded bg-rose-400/20 px-2.5 py-1 font-medium text-rose-100 hover:bg-rose-400/30"
        onClick={() => {
          const { project, assets } = useStore.getState();
          void saveProjectFile(project, assets, true).catch(() => {
            /* the picker was dismissed, or the write failed: the banner stays */
          });
        }}
      >
        {t("save.failing.action")}
      </button>
    </div>
  );
}

/**
 * Restore warning: shown when a reopened session has assets whose source file
 * can no longer be read. Offers to reconnect the files in bulk (matched by
 * name) or to start a fresh project.
 */
function DisconnectedBanner() {
  const { t } = useTranslation();
  // Select the stable assets reference and derive in render: returning a fresh
  // array straight from the selector would make Zustand loop (new ref each run).
  const assets = useStore((s) => s.assets);
  const disconnected = Object.values(assets).filter((a) => a.disconnected);
  if (disconnected.length === 0) return null;

  const reconnectFrom = (open: typeof openMediaPicker) => () => {
    open((files) => {
      const { reconnectAsset } = useStore.getState();
      // Match each picked file back to a disconnected asset by file name.
      const byName = new Map(disconnected.map((a) => [a.file.name, a.id]));
      for (const file of files) {
        const id = byName.get(file.name);
        if (id) {
          void reconnectAsset(id, file);
          byName.delete(file.name);
        }
      }
    });
  };

  return (
    <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
      <LinkBreak1Icon className="h-4 w-4 flex-none text-amber-300" />
      <span className="min-w-0 flex-1">
        {t("restore.disconnected", { count: disconnected.length })}
      </span>
      <button
        className="flex-none rounded bg-amber-400/20 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-400/30"
        onClick={reconnectFrom(openMediaPicker)}
      >
        {t("restore.reconnect")}
      </button>
      <button
        className="flex-none rounded bg-amber-400/20 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-400/30"
        onClick={reconnectFrom(openFolderPicker)}
        title={t("restore.reconnectFolderHint")}
      >
        {t("restore.reconnectFolder")}
      </button>
      <button
        className="flex-none rounded px-2.5 py-1 font-medium text-amber-200/80 hover:bg-amber-400/10 hover:text-amber-100"
        onClick={() => {
          void confirmDiscardProject().then((ok) => {
            if (!ok) return;
            useStore.getState().resetProject();
            // As in File ▸ New: unbind so a later save cannot overwrite the file
            // the discarded project came from.
            unbindProjectFile();
          });
        }}
      >
        {t("restore.startNew")}
      </button>
    </div>
  );
}

function ImportingBadge() {
  const { t } = useTranslation();
  const importing = useStore((s) => s.importing);
  // The detailed line (remuxing a container) takes over the badge while it lasts;
  // the rest of an import is quick enough for the generic label.
  const importStatus = useStore((s) => s.importStatus);
  return (
    <AnimatePresence>
      {importing && (
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-200 shadow-lg"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
          {importStatus ?? t("app.importing")}
        </m.div>
      )}
    </AnimatePresence>
  );
}
