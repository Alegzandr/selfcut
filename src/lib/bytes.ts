/**
 * Byte counts, in the units a person reads.
 *
 * Binary units (1024) rather than decimal, because every number this formats
 * comes from a browser storage API that reports the same way, and a caption
 * model shown as "466 MB" here and "489 MB" in the OS storage panel reads as a
 * bug. One decimal above a gigabyte, none below: nobody needs a model's size to
 * the megabyte, and "0.4 GB" is harder to weigh than "466 MB".
 */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
