import type { ParseKeys } from 'i18next';

/**
 * The application menus, as ids into the shared command map (`'---'` is a
 * separator).
 *
 * One list, two surfaces: the desktop menu bar renders it as dropdowns, and the
 * touch menu sheet renders the same sections as a scrolling column. That is the
 * point of keeping it here rather than inside `MenuBar` - a command added to a
 * menu has to reach a phone too, and it used to be that everything living only
 * in this list was simply unreachable on touch.
 */
export type AppMenu = { titleKey: ParseKeys; items: readonly string[] };

export const MENUS: readonly AppMenu[] = [
  {
    titleKey: 'menu.file',
    items: [
      'file.new',
      'file.open',
      'file.projects',
      '---',
      'file.save',
      'file.saveAs',
      '---',
      'file.import',
      'file.importSubtitles',
      'file.exportSubtitles',
      'file.importPreset',
      'file.savePreset',
      '---',
      'file.export',
    ],
  },
  {
    titleKey: 'menu.edit',
    items: ['edit.undo', 'edit.redo', '---', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteInsert', '---', 'edit.closeGap', '---', 'edit.selectAll', 'edit.selectForward', '---', 'edit.preferences'],
  },
  {
    titleKey: 'menu.insert',
    items: ['insert.text', 'insert.color', 'insert.gradient', '---', 'insert.videoTrack', 'insert.audioTrack', '---', 'insert.marker'],
  },
  {
    titleKey: 'menu.clip',
    items: ['clip.split', 'clip.duplicate', '---', 'clip.punchIn', 'clip.stream', 'clip.blurRegion', 'clip.captions', 'clip.link', 'clip.unlink', '---', 'clip.delete', 'clip.rippleDelete'],
  },
  {
    titleKey: 'menu.view',
    // The shortcuts panel lives under Help alone: it was in both menus, the
    // same command listed twice under the same label.
    items: [
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomFit',
      '---',
      'view.guides.off',
      'view.guides.safe',
      'view.guides.thirds',
      'view.guides.social',
      '---',
      'view.media',
      'view.effects',
      'view.transitions',
      '---',
      'view.subtitles',
      '---',
      'view.snap',
    ],
  },
  {
    titleKey: 'menu.playback',
    items: ['playback.playPause', 'playback.start', '---', 'playback.loop', 'playback.regionIn', 'playback.regionOut', '---', 'playback.nextMarker', 'playback.prevMarker'],
  },
  { titleKey: 'menu.help', items: ['help.shortcuts', '---', 'help.about'] },
];
