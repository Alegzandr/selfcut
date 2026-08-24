import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence } from "framer-motion";
import { ChevronDownIcon, LapTimerIcon } from "@radix-ui/react-icons";
import { useStore } from "../store/store";
import {
  PREVIEW_RESOLUTION_SCALE,
  type PreviewResolutionMode,
} from "../app/config";
import { Tooltip } from "../ui/Tooltip";
import { MenuList, type MenuEntry } from "../ui/menu/MenuList";
import { MenuPanel, useDismissOnOutside } from "../ui/menu/MenuPanel";

const OPTIONS: readonly PreviewResolutionMode[] = [
  "full",
  "half",
  "quarter",
  "eighth",
];

/** Short rung label from a render scale: "Full", "1/2", "1/4", "1/8". */
function rungLabel(mode: PreviewResolutionMode, fullLabel: string): string {
  const scale = PREVIEW_RESOLUTION_SCALE[mode];
  return scale >= 1 ? fullLabel : `1/${Math.round(1 / scale)}`;
}

/**
 * Playback-resolution picker, at the right end of the transport next to the
 * zoom readout: the two monitor settings read as one cluster. A lower rung
 * composites a smaller frame (cheaper) that the browser upscales to fill the
 * monitor; when even that can't keep up the engine drops frames rather than
 * change sharpness mid-playback.
 */
export function PreviewQualityMenu() {
  const { t } = useTranslation();
  const mode = useStore((s) => s.previewResolution);
  const { setPreviewResolution } = useStore.getState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, () => setOpen(false), rootRef);

  const fullLabel = t("preview.quality.full");

  const entries: MenuEntry[] = OPTIONS.map((opt) => ({
    id: `previewQuality.${opt}`,
    labelKey: "preview.quality.title" as const,
    label: rungLabel(opt, fullLabel),
    checked: mode === opt,
    onClick: () => setPreviewResolution(opt),
  }));

  return (
    <div ref={rootRef} className="relative flex-none">
      <Tooltip
        label={`${t("preview.quality.title")} · ${t("preview.quality.hint")}`}
        disabled={open}
      >
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("preview.quality.title")}
          className={`touch-hit flex items-center gap-0.5 rounded-lg px-1 py-1 font-mono text-2xs tabular-nums hover:bg-zinc-800/70 active:bg-zinc-800 ${
            open ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
          }`}
          onClick={() => setOpen((v) => !v)}
        >
          <LapTimerIcon className="h-3.5 w-3.5" />
          {/* Reserved width so the cluster does not shuffle between "1/8" and
              "Full", centred so the slack splits evenly on both sides. */}
          <span className="min-w-[26px] text-center">
            {rungLabel(mode, fullLabel)}
          </span>
          <ChevronDownIcon className="h-3 w-3" />
        </button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <MenuPanel
            from="bottom"
            className="bottom-full right-0 mb-1 min-w-32"
          >
            <MenuList items={entries} onRun={() => setOpen(false)} />
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  );
}
