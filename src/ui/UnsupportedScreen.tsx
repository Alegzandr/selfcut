import { MonitorX } from 'lucide-react';
import { APP_NAME } from '../app/config';

export function UnsupportedScreen() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-zinc-950 p-8 text-center">
      <MonitorX className="h-14 w-14 text-zinc-500" />
      <h1 className="text-xl font-semibold text-zinc-100">
        {APP_NAME} can't run in this browser
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-zinc-400">
        {APP_NAME} relies on <span className="font-medium text-zinc-300">WebCodecs</span> to decode
        and encode video entirely on your device — no upload, no server. This browser doesn't
        expose that API.
      </p>
      <p className="max-w-md text-sm text-zinc-400">
        Try a recent version of <span className="text-zinc-300">Chrome</span>,{' '}
        <span className="text-zinc-300">Edge</span> or <span className="text-zinc-300">Safari 16.4+</span>,
        over HTTPS.
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
