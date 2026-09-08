/**
 * The library asset a drag is currently carrying.
 *
 * A DataTransfer's payload is unreadable during `dragover` - the spec exposes
 * only its `types` until the drop - so the timeline cannot ask the event which
 * asset is coming, and therefore how long the clip it would create is. The
 * dragged id is stashed here on `dragstart` instead, which is the only moment
 * the source and the payload are both in hand.
 *
 * Module state rather than store state: nothing renders off it directly (the
 * drop preview it feeds does), so a store commit per drag start would buy
 * nothing.
 */
let draggedId: string | null = null;

export function setDraggedAssetId(id: string | null): void {
  draggedId = id;
}

export function draggedAssetId(): string | null {
  return draggedId;
}

/**
 * The composition a drag is currently carrying, and how long it runs.
 *
 * Same reason as `draggedAssetId`: a DataTransfer's payload is unreadable during
 * `dragover`, so the timeline cannot ask the event which composition is coming -
 * and therefore how wide the clip it would create is. The length rides along
 * because, unlike an asset, a composition's duration is not a field the drop
 * target could look up without walking its lanes.
 */
let draggedCompId: string | null = null;
let draggedCompMs = 0;

export function setDraggedComp(id: string | null, durationMs: number): void {
  draggedCompId = id;
  draggedCompMs = durationMs;
}

export function draggedComp(): { id: string; durationMs: number } | null {
  return draggedCompId ? { id: draggedCompId, durationMs: draggedCompMs } : null;
}
