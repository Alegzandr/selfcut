import { useEffect, useState } from 'react';
import {
  captionCapabilities,
  captionsSupported,
  type CaptionCapabilities,
} from './captionsCapabilities';

/**
 * The capability probe as React state.
 *
 * The probe itself is async (it asks for a GPU adapter) and memoized for the
 * session, so every surface that needs it - the model picker, the captions card,
 * the Preferences tab - can call this without a second adapter request.
 */
export function useCaptionCapabilities(): CaptionCapabilities | null {
  const [caps, setCaps] = useState<CaptionCapabilities | null>(null);
  useEffect(() => {
    let live = true;
    void captionCapabilities().then((c) => {
      if (live) setCaps(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return caps;
}

/**
 * Whether this machine is offered auto-captions. `false` while the probe is in
 * flight: a card that appears and then vanishes is worse than one that arrives
 * a frame late.
 */
export function useCaptionsSupported(): boolean {
  const caps = useCaptionCapabilities();
  return caps != null && captionsSupported(caps);
}
