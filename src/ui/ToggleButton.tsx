import React from 'react';

export function ToggleButton({
  active,
  onClick,
  className = '',
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`touch-hit rounded-md px-2 py-1 pointer-coarse:px-3 pointer-coarse:py-1.5 ${active ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'} ${className}`}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}
