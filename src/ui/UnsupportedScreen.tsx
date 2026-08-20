import { DesktopIcon } from '@radix-ui/react-icons';
import { Trans, useTranslation } from 'react-i18next';
import { APP_NAME } from '../app/config';

export function UnsupportedScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-zinc-950 p-8 text-center">
      <DesktopIcon className="h-14 w-14 text-zinc-500" />
      {/* APP_NAME is a brand: interpolated, never translated. */}
      <h1 className="text-xl font-semibold text-zinc-100">{t('unsupported.title', { app: APP_NAME })}</h1>
      {/* One sentence, one key: the emphasis spans are markup inside the translation,
          so translators keep control of the word order around them. */}
      <p className="max-w-md text-sm leading-relaxed text-zinc-400">
        <Trans
          i18nKey="unsupported.reason"
          values={{ app: APP_NAME }}
          components={{ api: <span className="font-medium text-zinc-300" /> }}
        />
      </p>
      <p className="max-w-md text-sm text-zinc-400">
        <Trans
          i18nKey="unsupported.browsers"
          components={{ name: <span className="text-zinc-300" /> }}
        />
      </p>
    </div>
  );
}

export function isSupported(): boolean {
  return (
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}
