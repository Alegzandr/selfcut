import { useStore } from '../store/store';
import { createEmptyProject } from '../store/projectOps';
import {
  deleteProjectFromDb,
  flushProjectSave,
  listProjectMetas,
  loadProjectById,
  renameProjectInDb,
  restoreTranscodedTracks,
  saveWholeProject,
} from '../lib/persistence';
import { ensureAssetVisuals } from '../media/probe';
import { t } from '../i18n';

/**
 * Project browser orchestration: create, open, rename and delete whole projects.
 * These sit above the store and the persistence layer because each one is a
 * multi-step dance (flush the outgoing save, load from IndexedDB, hydrate,
 * persist the incoming one) that neither layer should own alone.
 */

/** Reload the browser's rows from the database. */
export async function refreshProjects(): Promise<void> {
  useStore.getState().setProjects(await listProjectMetas());
}

/** Create a fresh empty project, switch to it, and persist it. Keeps the old one. */
export async function createNewProject(): Promise<void> {
  flushProjectSave();
  const project = createEmptyProject();
  useStore.getState().hydrate(project, []); // sets currentProjectId, clears state
  await saveWholeProject();
  await refreshProjects();
}

/** Open an existing project by id (no-op if it is already the open one). */
export async function openProjectById(id: string): Promise<void> {
  const st = useStore.getState();
  if (id === st.currentProjectId) {
    st.setProjectLibraryOpen(false);
    return;
  }
  flushProjectSave();
  const loaded = await loadProjectById(id);
  if (!loaded) {
    st.setError(t('errors.project.invalidFile'));
    await refreshProjects();
    return;
  }
  st.hydrate(loaded.project, loaded.assets);
  st.setProjectLibraryOpen(false);
  for (const asset of loaded.assets) {
    if (!asset.disconnected) ensureAssetVisuals(asset, useStore.getState());
  }
  void restoreTranscodedTracks(loaded.assets);
}

/** Rename a project — the open one through the store, others in the database. */
export async function renameProject(id: string, name: string): Promise<void> {
  const st = useStore.getState();
  const trimmed = name.trim();
  if (!trimmed) return;
  if (id === st.currentProjectId) st.renameCurrentProject(trimmed);
  else await renameProjectInDb(id, trimmed);
  await refreshProjects();
}

/**
 * Delete a project and its media. Deleting the open project falls back to the
 * most recent remaining one, or a fresh empty project when none is left — with
 * no save flush, so the just-deleted project is not written back.
 */
export async function deleteProject(id: string): Promise<void> {
  const st = useStore.getState();
  const wasOpen = id === st.currentProjectId;
  await deleteProjectFromDb(id);
  if (wasOpen) {
    const metas = (await listProjectMetas()).filter((m) => m.id !== id);
    const loaded = metas.length ? await loadProjectById(metas[0]!.id) : null;
    if (loaded) {
      st.hydrate(loaded.project, loaded.assets);
      for (const asset of loaded.assets) {
        if (!asset.disconnected) ensureAssetVisuals(asset, useStore.getState());
      }
      void restoreTranscodedTracks(loaded.assets);
    } else {
      st.hydrate(createEmptyProject(), []);
      await saveWholeProject();
    }
  }
  await refreshProjects();
}
