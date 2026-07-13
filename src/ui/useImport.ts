import { useCallback } from 'react';
import { useStore } from '../store/store';
import { probeFile } from '../media/probe';

/** Import a batch of files: probe metadata, register assets in the media library. */
export function useImport(): (files: Iterable<File>) => Promise<void> {
  return useCallback(async (files: Iterable<File>) => {
    const { setImporting, setError, addAsset } = useStore.getState();
    setImporting(true);
    try {
      for (const file of files) {
        try {
          const asset = await probeFile(file);
          addAsset(asset);
        } catch (err) {
          setError(err instanceof Error ? err.message : `Could not import ${file.name}`);
        }
      }
    } finally {
      setImporting(false);
    }
  }, []);
}
