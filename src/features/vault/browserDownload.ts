export const OBJECT_URL_REVOCATION_DELAY_MS = 1_000;

/**
 * WebKit requires the clicked download anchor to be attached, and may not
 * consume a blob URL before the click stack unwinds. Keep the URL alive for a
 * short bounded interval while removing the temporary DOM node immediately.
 */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOCATION_DELAY_MS);
  }
}
