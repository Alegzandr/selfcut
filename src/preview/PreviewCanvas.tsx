import { useEffect, useRef } from 'react';
import { PlaybackEngine } from './PlaybackEngine';

export function PreviewCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const engine = new PlaybackEngine(canvasRef.current!);
    return () => engine.dispose();
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-zinc-950">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full rounded-lg shadow-lg shadow-black/50"
      />
    </div>
  );
}
