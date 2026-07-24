import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, FilePlus2, Pencil, Trash2, X } from 'lucide-react';
import { useStore } from '../store/store';
import {
  createNewProject,
  deleteProject,
  openProjectById,
  refreshProjects,
  renameProject,
} from './projectLibraryActions';

/**
 * Project browser: the shelf that makes SelfCut multi-project. Lists every
 * project in local storage (newest first), and creates, opens, renames or
 * deletes them. Opened from File ▸ Projects.
 *
 * Everything here is local: projects live in IndexedDB, and deleting one drops
 * its media too, so an abandoned project never keeps taking up storage.
 */
export function ProjectLibrary() {
  const { t } = useTranslation();
  const open = useStore((s) => s.projectLibraryOpen);
  const projects = useStore((s) => s.projects);
  const currentId = useStore((s) => s.currentProjectId);
  const { setProjectLibraryOpen, requestConfirm } = useStore.getState();
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) {
        setEditing(null);
        return;
      }
      e.stopPropagation();
      setProjectLibraryOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, editing, setProjectLibraryOpen]);

  const close = () => setProjectLibraryOpen(false);

  const commitRename = () => {
    if (!editing) return;
    void renameProject(editing.id, editing.value);
    setEditing(null);
  };

  const askDelete = async (id: string, name: string) => {
    const ok = await requestConfirm({
      title: t('projects.deleteConfirm.title'),
      message: t('projects.deleteConfirm', { name: name || t('projects.untitled') }),
      confirmLabel: t('projects.delete'),
      danger: true,
    });
    if (ok) void deleteProject(id);
  };

  const fmtDate = (ms: number | undefined): string =>
    ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={close}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            role="dialog"
            aria-modal="true"
            aria-label={t('projects.title')}
            className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
              <h2 className="text-sm font-semibold text-zinc-100">{t('projects.title')}</h2>
              <button
                className="touch-hit rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={close}
                aria-label={t('projects.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {projects.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-zinc-500">{t('projects.empty')}</p>
              ) : (
                <ul className="space-y-1">
                  {projects.map((p) => {
                    const isCurrent = p.id === currentId;
                    const name = p.name || t('projects.untitled');
                    return (
                      <li
                        key={p.id}
                        className={`group flex items-center gap-2 rounded-lg px-3 py-2 ${
                          isCurrent ? 'bg-sky-500/10' : 'hover:bg-zinc-800/70'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          {editing?.id === p.id ? (
                            <input
                              autoFocus
                              value={editing.value}
                              onChange={(e) => setEditing({ id: p.id, value: e.target.value })}
                              onBlur={commitRename}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename();
                              }}
                              className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500"
                            />
                          ) : (
                            <button
                              className="block w-full truncate text-left text-xs font-medium text-zinc-200"
                              title={name}
                              onClick={() => void openProjectById(p.id)}
                            >
                              {name}
                            </button>
                          )}
                          <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-zinc-500">
                            {isCurrent && (
                              <span className="inline-flex items-center gap-0.5 text-sky-400">
                                <Check className="h-3 w-3" />
                                {t('projects.currentBadge')}
                              </span>
                            )}
                            <span className="tabular-nums">{fmtDate(p.updatedAt)}</span>
                          </div>
                        </div>

                        <button
                          className="touch-hit rounded p-1 text-zinc-500 opacity-0 hover:bg-zinc-700/60 hover:text-zinc-200 focus:opacity-100 group-hover:opacity-100"
                          title={t('projects.rename')}
                          aria-label={t('projects.rename')}
                          onClick={() => setEditing({ id: p.id, value: p.name ?? '' })}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="touch-hit rounded p-1 text-zinc-500 opacity-0 hover:bg-red-500/20 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
                          title={t('projects.delete')}
                          aria-label={t('projects.delete')}
                          onClick={() => void askDelete(p.id, name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="border-t border-zinc-800 p-2">
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-900 hover:bg-white"
                onClick={() => {
                  void createNewProject().then(() => refreshProjects());
                }}
              >
                <FilePlus2 className="h-4 w-4" />
                {t('projects.new')}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
