import { useTranslation } from 'react-i18next';
import type { FFmpegProgress } from '../media/ffmpeg';

/**
 * A running ffmpeg job: which phase it is in, how far along, and a way out.
 * Shared by every on-demand job, since they all report the same phases.
 *
 * Lives on its own because two surfaces show the same job: the asset card, where
 * it has to survive in a 150 px column, and the track picker, which has room for
 * readable text. `dense` is that difference and nothing else.
 */
export function JobProgress({
  progress,
  name,
  dense = true,
  onCancel,
}: {
  progress: FFmpegProgress;
  name: string;
  dense?: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const percent = progress.ratio == null ? null : Math.round(progress.ratio * 100);
  const phase = t(`library.job.phase.${progress.phase}`);
  const text = dense ? 'text-4xs' : 'text-xs';
  return (
    <div>
      <div className="flex items-center gap-1">
        <span className={`min-w-0 flex-1 truncate ${text} text-sky-300/90`} title={name}>
          {dense ? phase : `${name} · ${phase}`}
          {percent != null && ` · ${percent} %`}
        </span>
        <button
          className={`touch-hit flex-none rounded px-1 py-0.5 ${text} text-zinc-400 hover:bg-zinc-800 active:bg-zinc-800 pointer-coarse:p-2`}
          onClick={onCancel}
        >
          {t('library.job.cancel')}
        </button>
      </div>
      {/* An unmeasurable phase (decoding) gets a full dim bar rather than an
          empty one: the job is nearly done, not stalled. A queued job is the
          opposite - nothing has happened yet - so its bar stays empty. */}
      <div
        className={`mt-0.5 w-full overflow-hidden rounded-full bg-zinc-800 ${
          dense ? 'h-0.5' : 'h-1'
        }`}
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={phase}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            progress.phase === 'queued'
              ? 'w-0'
              : percent == null
                ? 'w-full bg-sky-500/40'
                : 'bg-sky-400'
          }`}
          style={percent == null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
