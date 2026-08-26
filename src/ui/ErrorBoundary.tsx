import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, ExclamationTriangleIcon, ResetIcon } from '@radix-ui/react-icons';
import { useStore } from '../store/store';
import { saveProjectFile, SaveCanceledError } from '../lib/projectFile';
import { flushProjectSave } from '../lib/persistence';

/**
 * The last line of defence for the editor tree.
 *
 * Without one, a single throw anywhere in render unmounts the whole React tree
 * and leaves a blank page - with the timeline, the project and the media
 * library still in memory, unreachable and about to be thrown away with the
 * tab. The point of this screen is therefore not the apology, it is the two
 * buttons: get the work out to a file, and get back into a working editor.
 *
 * A class component because that is the only way React exposes the hook.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped by "try again", which remounts the subtree with fresh keys. */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[editor] render crashed:', error, info.componentStack);
    // The debounced project write is very likely still pending, and the tab may
    // not survive this. Getting it to IndexedDB is the difference between
    // losing the last few seconds of work and losing the session.
    try {
      flushProjectSave();
    } catch {
      /* the crash screen must render even if persistence is also broken */
    }
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    if (!this.state.error) return <div key={this.state.attempt}>{this.props.children}</div>;
    return <CrashScreen error={this.state.error} onRetry={this.retry} />;
  }
}

function CrashScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();

  const rescue = (): void => {
    const { project, assets } = useStore.getState();
    void saveProjectFile(project, assets, true).catch((err) => {
      if (err instanceof SaveCanceledError) return;
      console.error('[editor] rescue save failed:', err);
    });
  };

  return (
    <div
      role="alert"
      className="flex h-dvh flex-col items-center justify-center gap-6 bg-zinc-950 px-6 text-zinc-100"
    >
      <ExclamationTriangleIcon className="h-10 w-10 text-amber-400" aria-hidden="true" />
      <div className="flex max-w-md flex-col gap-2 text-center">
        <h1 className="text-lg font-semibold">{t('crash.title')}</h1>
        <p className="text-sm text-zinc-400">{t('crash.body')}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          className="flex items-center gap-2 rounded bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-600"
          onClick={rescue}
        >
          <DownloadIcon className="h-4 w-4" aria-hidden="true" />
          {t('crash.save')}
        </button>
        <button
          className="flex items-center gap-2 rounded bg-zinc-800 px-3.5 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700"
          onClick={onRetry}
        >
          <ResetIcon className="h-4 w-4" aria-hidden="true" />
          {t('crash.retry')}
        </button>
        <button
          className="rounded px-3.5 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          onClick={() => window.location.reload()}
        >
          {t('crash.reload')}
        </button>
      </div>
      <details className="max-w-lg text-xs text-zinc-500">
        <summary className="cursor-pointer select-none">{t('crash.details')}</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-900 p-3 text-[11px] leading-relaxed">
          {error.stack ?? error.message}
        </pre>
      </details>
    </div>
  );
}
