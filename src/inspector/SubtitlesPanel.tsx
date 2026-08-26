import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cross2Icon,
  DownloadIcon,
  FilePlusIcon,
  MagicWandIcon,
  TextIcon,
  TrashIcon,
} from '@radix-ui/react-icons';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { openSubtitlePicker } from '../ui/mediaPicker';
import { useImport } from '../ui/useImport';
import { useAutoGrow } from '../ui/useAutoGrow';
import { exportSubtitles } from '../ui/subtitleActions';
import {
  audioTrackForClip,
  clipEndMs,
  isTextClip,
  supersededCueIds,
} from '../model';
import {
  generateCaptionsForClips,
  type CaptionProgress,
} from '../media/captions';
import {
  cancelCaptionJob,
  isCaptionJobRunning,
  startCaptionJob,
  useCaptionJob,
} from '../media/captionJob';
import {
  captionCapabilities,
  bestDefaultModel,
} from '../media/captionsCapabilities';
import {
  AUTO_LANGUAGE,
  CAPTION_LANGUAGES,
  DEFAULT_CAPTION_MODEL,
  languageName,
  setStoredCaptionEnhance,
  setStoredCaptionLanguage,
  storedCaptionModel,
  whisperLanguage,
} from '../media/captionsPrefs';
import {
  useCaptionEnhancePref,
  useCaptionLanguagePref,
  useCaptionModelPref,
} from '../media/useCaptionPrefs';
import { useIsCoarsePointer } from '../lib/device';
import { formatTime } from '../lib/time';
import {
  isTrackPlayable,
  type Clip,
  type MediaAsset,
  type TextClip,
} from '../types';

/**
 * Cue list: every text clip in the project, in timeline order, editable as
 * plain rows, with the auto-caption generator sitting above it.
 *
 * A caption track is dozens of one-line clips, and retiming or fixing a typo by
 * hunting each one down on the timeline does not scale. This is the same data
 * seen as a document instead of as a strip - selecting a row selects the clip,
 * so the preview, the inspector and the timeline all follow along.
 *
 * Text clips of every origin show up here, not only imported ones: a title card
 * IS a cue as far as this list is concerned, and hiding it would make the list
 * lie about what the project renders.
 */

/** A clip the generator can listen to, paired with the source it comes from. */
interface CaptionTarget {
  clip: Clip;
  asset: MediaAsset;
}

/** Progress bar with a cancel button, shown in place of the generate button. */
function CaptionProgressBar({
  progress,
  onCancel,
}: {
  progress: CaptionProgress;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // Whisper reports where in the audio it is, so the bar is a real percentage
  // rather than a pulse - except on a run it cannot place, which keeps the
  // indeterminate look instead of pretending to a number it does not have.
  const pct = progress.value == null ? null : Math.round(progress.value * 100);
  const label =
    progress.stage === 'model'
      ? t('subtitles.downloadingModel', { pct })
      : progress.clip
        ? pct == null
          ? t('subtitles.transcribingClip', {
              index: progress.clip.index,
              total: progress.clip.total,
            })
          : t('subtitles.transcribingClipPct', {
              index: progress.clip.index,
              total: progress.clip.total,
              pct,
            })
        : pct == null
          ? t('subtitles.transcribing')
          : t('subtitles.transcribingPct', { pct });
  return (
    <div className="flex w-full items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full bg-brand-500 ${pct == null ? 'w-full animate-pulse' : 'transition-[width]'}`}
          style={pct == null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-2xs text-zinc-400">{label}</span>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('confirm.cancel')}
        className="touch-hit rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <Cross2Icon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** One labelled select, the shape both generator dropdowns take. */
function Field({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-2xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <select
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-600 focus:border-brand-500 focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

/**
 * The auto-caption generator: what gets transcribed, in which language, with
 * which model.
 *
 * It sits at the top of the panel in both the empty and the populated state.
 * Captions are the reason most people open this pane, and an affordance that
 * only exists while the project has no subtitles is one nobody finds twice.
 */
function CaptionGenerator({ targets }: { targets: CaptionTarget[] }) {
  const { t, i18n } = useTranslation();
  // Model, language and voice focus are machine preferences, shared with the
  // Preferences dialog: read through the prefs hooks so a change made there
  // shows up here (and vice versa) without a reload.
  const storedModel = useCaptionModelPref();
  const language = useCaptionLanguagePref();
  const enhance = useCaptionEnhancePref();
  const [probedModel, setProbedModel] = useState(DEFAULT_CAPTION_MODEL);
  const model = storedModel ?? probedModel;
  const [pickedTrack, setPickedTrack] = useState<string | null>(null);
  // The run outlives this component: switching to the clip tab unmounts the
  // panel, and the transcription must neither disappear nor be startable twice.
  const progress = useCaptionJob();

  // Nothing stored yet: preselect what this machine can actually run well,
  // rather than leaving everyone on the smallest model by inertia.
  useEffect(() => {
    if (storedCaptionModel()) return;
    let live = true;
    void captionCapabilities().then((caps) => {
      if (live) setProbedModel(bestDefaultModel(caps));
    });
    return () => {
      live = false;
    };
  }, []);

  // The source's other audio tracks are only offerable while the whole
  // selection comes from one source: two clips from two files have no shared
  // track numbering to pick from.
  const sharedAsset =
    targets.length > 0 &&
    targets.every((x) => x.asset.id === targets[0]!.asset.id)
      ? targets[0]!.asset
      : null;
  const pickableTracks = (sharedAsset?.audioTracks ?? []).filter(
    isTrackPlayable,
  );
  const showTrackPicker = pickableTracks.length > 1;

  // The clips already say which track they play - a clip dropped from the
  // library's second audio stream is pinned to it, and the timeline draws that
  // stream's waveform. So the picker opens on that track instead of on a
  // generic "the clip's own", which read as "not the one you pointed at" when
  // the pane was opened by right-clicking exactly that lane.
  const clipTrack = useMemo(() => {
    if (!sharedAsset) return null;
    const indices = new Set(
      targets.map((x) => audioTrackForClip(sharedAsset, x.clip)?.index),
    );
    const [only] = [...indices];
    // Only a track the picker actually lists: a clip pinned to an undecodable
    // stream must not leave the select showing an option that is not there.
    return indices.size === 1 &&
      only != null &&
      pickableTracks.some((track) => track.index === only)
      ? String(only)
      : null;
  }, [sharedAsset, targets, pickableTracks]);
  // A choice made by hand survives until the selection points somewhere else.
  useEffect(() => setPickedTrack(null), [clipTrack]);
  const audioTrack = pickedTrack ?? clipTrack ?? 'clip';

  const run = () => {
    if (targets.length === 0 || isCaptionJobRunning()) return;
    const st = useStore.getState();
    void (async () => {
      const from = Math.min(...targets.map((x) => x.clip.timelineStartMs));
      const to = Math.max(...targets.map((x) => clipEndMs(x.clip)));
      const superseded = supersededCueIds(st.project, from, to);
      if (superseded.length > 0) {
        const ok = await st.requestConfirm({
          title: t('subtitles.replace.title'),
          message: t('subtitles.replace.message', { count: superseded.length }),
          confirmLabel: t('subtitles.replace.confirm'),
          danger: true,
        });
        if (!ok) return;
      }
      startCaptionJob(async (report, signal) => {
        try {
          const cues = await generateCaptionsForClips(
            targets,
            {
              model,
              language: whisperLanguage(language),
              enhanceVoice: enhance,
              ...(audioTrack === 'clip'
                ? {}
                : { audioTrackIndex: Number(audioTrack) }),
            },
            report,
            signal,
          );
          if (signal.aborted) return;
          if (cues && cues.length > 0) {
            // The anchor is the source the captions belong to, so the new lane
            // lands right above its footage - only meaningful for one source.
            st.addSubtitleClips(cues, sharedAsset?.id, superseded);
          } else if (cues) {
            st.setNotice(t('subtitles.noSpeech'));
          }
        } catch (err) {
          console.warn('[captions] failed:', err);
          st.setError(t('errors.captions.failed'));
        }
      });
    })();
  };

  const scope =
    targets.length === 0
      ? t('subtitles.generate.needsAudio')
      : targets.length === 1
        ? t('subtitles.scope.one')
        : t('subtitles.scope.many', { count: targets.length });

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-center gap-2">
        <MagicWandIcon className="h-3.5 w-3.5 flex-none text-brand-400" />
        <span className="flex-1 text-xs font-medium text-zinc-100">
          {t('subtitles.auto')}
        </span>
      </div>

      <div className="mt-2 flex gap-2">
        <Field
          label={t('subtitles.language')}
          value={language}
          onChange={setStoredCaptionLanguage}
        >
          <option value={AUTO_LANGUAGE}>{t('subtitles.language.auto')}</option>
          {CAPTION_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {languageName(code, i18n.language)}
            </option>
          ))}
        </Field>
        {showTrackPicker && (
          <Field
            label={t('subtitles.audioTrack')}
            value={audioTrack}
            onChange={setPickedTrack}
          >
            <option value="clip">{t('subtitles.audioTrack.clip')}</option>
            {pickableTracks.map((track) => (
              <option key={track.index} value={String(track.index)}>
                {track.label ?? track.language ?? `#${track.index + 1}`}
              </option>
            ))}
          </Field>
        )}
      </div>

      {/* The one control that changes what Whisper hears rather than what it is
          asked for, so it sits with the run button and not behind the models. */}
      <Tooltip label={t('subtitles.enhance.hint')}>
        <label className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-2xs text-zinc-400 hover:text-zinc-200">
          <input
            type="checkbox"
            className="h-3 w-3 accent-brand-500"
            checked={enhance}
            onChange={(e) => setStoredCaptionEnhance(e.target.checked)}
          />
          {t('subtitles.enhance')}
        </label>
      </Tooltip>

      <div className="mt-2.5">
        {progress ? (
          <CaptionProgressBar progress={progress} onCancel={cancelCaptionJob} />
        ) : (
          <button
            type="button"
            onClick={run}
            disabled={targets.length === 0}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-40"
          >
            <MagicWandIcon className="h-3.5 w-3.5" />
            {t('subtitles.generate')}
          </button>
        )}
      </div>
      {!progress && (
        <p className="mt-1.5 text-center text-2xs text-zinc-500">{scope}</p>
      )}
    </div>
  );
}

export function SubtitlesPanel() {
  const { t } = useTranslation();
  const project = useStore((s) => s.project);
  const selectedClipId = useStore((s) => s.selectedClipId);
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const assets = useStore((s) => s.assets);
  const importFiles = useImport();
  const coarse = useIsCoarsePointer();

  // Whisper is a desktop-only tool: it needs a capable machine (WebGPU, or a
  // slower wasm fallback) and a model download that is not worth pushing onto a
  // phone. Mobile keeps manual entry and SRT import.
  const captionsAvailable = !coarse;

  // Derived in a memo, not in the selector: a selector runs on every set(), and
  // the playback engine writes the current time 60 times a second.
  const cues = useMemo(
    () =>
      project.tracks
        .flatMap((track) => track.clips)
        .filter(isTextClip)
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs),
    [project],
  );

  /** Every selected clip that actually carries sound, in timeline order. */
  const targets = useMemo(() => {
    const ids = new Set(selectedClipIds);
    return project.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => ids.has(clip.id) && clip.kind === 'media')
      .map((clip) => ({ clip, asset: assets[clip.assetId] }))
      .filter((x): x is CaptionTarget => !!x.asset?.hasAudio)
      .sort((a, b) => a.clip.timelineStartMs - b.clip.timelineStartMs);
  }, [project, selectedClipIds, assets]);

  const importSubtitles = () =>
    openSubtitlePicker((files) => void importFiles(files));

  const importButton = (
    <button
      className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800/70"
      onClick={importSubtitles}
    >
      <FilePlusIcon className="h-3.5 w-3.5" />
      {t('subtitles.import')}
    </button>
  );

  if (cues.length === 0) {
    return (
      <div className="space-y-3">
        {captionsAvailable && <CaptionGenerator targets={targets} />}
        <div className="flex flex-col items-center gap-3 px-2 py-4 text-center">
          <TextIcon className="h-7 w-7 text-zinc-600" />
          <p className="text-xs leading-relaxed text-zinc-400">
            {t('subtitles.empty')}
          </p>
          {importButton}
          <p className="text-2xs text-zinc-500">
            {t('subtitles.empty.formats')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {captionsAvailable && <CaptionGenerator targets={targets} />}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-zinc-400">
          {t('subtitles.count', { count: cues.length })}
        </span>
        <Tooltip label={t('subtitles.import')}>
          <button
            className="touch-hit rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={importSubtitles}
          >
            <FilePlusIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        {/* The cues on the timeline are the working copy: whatever file they
            came from is stale as soon as one is retimed or rewritten. */}
        <Tooltip label={t('subtitles.export')}>
          <button
            className="touch-hit rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={exportSubtitles}
          >
            <DownloadIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <ul className="space-y-1">
        {cues.map((clip) => (
          <CueRow
            key={clip.id}
            clip={clip}
            selected={clip.id === selectedClipId}
          />
        ))}
      </ul>
    </div>
  );
}

function CueRow({ clip, selected }: { clip: TextClip; selected: boolean }) {
  const { t } = useTranslation();
  const {
    updateClip,
    deleteClips,
    selectClip,
    seek,
    beginGesture,
    endGesture,
  } = useStore.getState();
  const textRef = useAutoGrow<HTMLTextAreaElement>(clip.text.content);

  /**
   * Selecting also parks the playhead on the cue: the point of clicking a row is
   * to look at that moment, and a selection with the preview still elsewhere
   * shows the wrong frame behind the text being edited.
   */
  const focusCue = () => {
    selectClip(clip.id);
    seek(clip.timelineStartMs);
  };

  return (
    <li
      className={`group rounded-md border px-2.5 py-2 ${
        selected
          ? 'border-blue-600/80 bg-blue-700/25'
          : 'border-zinc-800 bg-zinc-900/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          className="text-2xs tabular-nums text-zinc-500 hover:text-blue-400"
          title={t('subtitles.goto')}
          onClick={focusCue}
        >
          {/* Tenths, not whole seconds: cues are timed to fractions of one, and
              rounding would show a cue starting at 0.5 s as "0:00". */}
          {formatTime(clip.timelineStartMs)} · {formatTime(clipEndMs(clip))}
        </button>
        <span className="flex-1" />
        {/* Quiet until the row is under the pointer or holds focus: one delete
            per cue, lit up all at once down a long list, competed with the text
            that is the actual content here. Coarse pointers have no hover, so
            there it stays out. */}
        <Tooltip label={t('subtitles.delete')}>
          <button
            className="touch-hit rounded p-1 text-zinc-500 opacity-0 transition-opacity duration-150 hover:bg-zinc-800 hover:text-red-400 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            onClick={() => deleteClips([clip.id], false)}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
      <textarea
        ref={textRef}
        value={clip.text.content}
        rows={1}
        aria-label={t('a11y.subtitles.cue')}
        // resize-none + auto-grow: the field is already the size of its cue, so
        // the native grip had nothing left to do but crowd the row's corner.
        className="mt-1 block w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-0.5 text-xs leading-relaxed text-zinc-100 outline-none hover:border-zinc-700 focus:border-brand-500 focus:bg-zinc-800"
        // The gesture snapshots the text as it was on entry, so a whole retype
        // undoes in one step instead of one entry per keystroke.
        onFocus={() => {
          focusCue();
          beginGesture();
        }}
        onChange={(e) =>
          updateClip(clip.id, {
            text: { ...clip.text, content: e.target.value },
          })
        }
        onBlur={endGesture}
      />
    </li>
  );
}
