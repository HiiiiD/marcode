/** Base64 for a clipboard or dropped File, without the data-URL prefix. */
export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(reader.error ?? new Error('unreadable')); };
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** `text/uri-list`: newline-separated, with `#` comment lines ignored. */
export function urisOf(dataTransfer: DataTransfer): string[] {
  return dataTransfer.getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
