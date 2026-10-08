import { useTranslation } from 'react-i18next';
import { CheckCircledIcon, ExclamationTriangleIcon, CrossCircledIcon } from '@radix-ui/react-icons';
import type { ReviewIssue } from './review';
import { formatTime } from '../lib/time';

/**
 * The last look before publishing, as a short list in the export sheet.
 *
 * One line per finding, in the viewer's words, and one button that either
 * fixes it (in one undo step) or takes the user to it. A clean cut gets one
 * reassuring line rather than an empty box: "nothing found" is information.
 */

export interface ReviewActions {
  /** Apply the automatic fix of a finding that has one. */
  fix: (issue: ReviewIssue) => void;
  /** Close the sheet and put the user in front of the finding. */
  show: (issue: ReviewIssue) => void;
}

function Line({
  issue,
  actions,
  text,
  fixLabel,
  showLabel,
  blocking = false,
}: {
  issue: ReviewIssue;
  actions: ReviewActions;
  text: string;
  fixLabel?: string;
  showLabel?: string;
  blocking?: boolean;
}) {
  const Icon = blocking ? CrossCircledIcon : ExclamationTriangleIcon;
  return (
    <li className="flex items-start gap-2 py-1.5" data-review-issue={issue.id}>
      <Icon aria-hidden className={`mt-0.5 h-3.5 w-3.5 flex-none ${blocking ? 'text-red-400' : 'text-amber-400'}`} />
      <span className="min-w-0 flex-1 text-xs leading-snug text-zinc-300">{text}</span>
      {fixLabel && (
        <button
          type="button"
          onClick={() => actions.fix(issue)}
          className="touch-hit flex-none rounded-md bg-zinc-800 px-2 py-1 text-2xs font-medium text-zinc-100 hover:bg-zinc-700/70 active:bg-zinc-700"
        >
          {fixLabel}
        </button>
      )}
      {showLabel && (
        <button
          type="button"
          onClick={() => actions.show(issue)}
          className="touch-hit flex-none rounded-md px-2 py-1 text-2xs text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200 active:bg-zinc-800"
        >
          {showLabel}
        </button>
      )}
    </li>
  );
}

export function ExportReview({ issues, actions }: { issues: ReviewIssue[]; actions: ReviewActions }) {
  const { t } = useTranslation();
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-2 text-xs text-emerald-200">
        <CheckCircledIcon aria-hidden className="h-3.5 w-3.5 flex-none text-emerald-400" />
        {t('review.allGood')}
      </p>
    );
  }
  return (
    <section
      aria-label={t('review.title')}
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5"
    >
      <h3 className="py-1 text-2xs font-semibold uppercase tracking-wide text-amber-200/90">
        {t('review.title')}
      </h3>
      <ul className="divide-y divide-zinc-800/80">
        {issues.map((issue) => {
          switch (issue.id) {
            case 'disconnected':
              return (
                <Line
                  key={issue.id}
                  issue={issue}
                  actions={actions}
                  blocking
                  text={t('review.disconnected', { names: issue.names.join(', ') })}
                  showLabel={t('review.action.reconnect')}
                />
              );
            case 'blackGaps':
              return (
                <Line
                  key={issue.id}
                  issue={issue}
                  actions={actions}
                  text={t('review.blackGaps', { count: issue.gaps.length, at: formatTime(issue.gaps[0]!.startMs) })}
                  showLabel={t('review.action.goTo')}
                />
              );
            case 'uiZone':
              return (
                <Line
                  key={issue.id}
                  issue={issue}
                  actions={actions}
                  text={t('review.uiZone', { count: issue.clipIds.length })}
                  fixLabel={issue.fixes.length ? t('review.action.moveText') : undefined}
                  showLabel={issue.fixes.length < issue.clipIds.length ? t('review.action.show') : undefined}
                />
              );
            case 'letterbox':
              return (
                <Line
                  key={issue.id}
                  issue={issue}
                  actions={actions}
                  text={t('review.letterbox', { count: issue.clipIds.length })}
                  fixLabel={t('review.action.fill')}
                />
              );
            case 'noCaptions':
              return (
                <Line
                  key={issue.id}
                  issue={issue}
                  actions={actions}
                  text={t('review.noCaptions')}
                  showLabel={t('review.action.captions')}
                />
              );
            case 'loudness':
              return (
                <Line
                  key={issue.id}
                  issue={issue}
                  actions={actions}
                  text={t('review.loudness')}
                  fixLabel={t('review.action.loudness')}
                />
              );
          }
        })}
      </ul>
    </section>
  );
}
