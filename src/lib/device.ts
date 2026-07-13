import { useEffect, useState } from 'react';

const QUERY = '(pointer: coarse)';

/** True on touch-first devices (phones/tablets) — drives the CapCut-style timeline mode. */
export function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return coarse;
}
