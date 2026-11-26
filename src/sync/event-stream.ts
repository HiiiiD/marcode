/** Reads a `text/event-stream` body, calling `onFrame` per event (comment frames are skipped) and `onActivity` per chunk. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string, data: string) => void,
  onActivity: () => void = () => {},
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) { return; }
    onActivity();
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) { event = line.slice(6).trim(); }
        else if (line.startsWith('data:')) { data.push(line.slice(5).trim()); }
      }
      if (data.length > 0 || event !== 'message') { onFrame(event, data.join('\n')); }
    }
  }
}
