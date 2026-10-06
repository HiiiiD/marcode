import { execFile } from 'node:child_process';

export type ClipboardImage =
  | { kind: 'image'; mediaType: 'image/png'; base64: string }
  | { kind: 'none' }
  | { kind: 'no-tool'; hint: string };

export type RunTool = (cmd: string, args: string[]) => Promise<{ code: number; stdout: Buffer } | undefined>;

interface Reader { cmd: string; args: string[]; output: 'binary' | 'base64' | 'applescript' }

const WINDOWS_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; '
  + '$i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){$m=New-Object IO.MemoryStream; '
  + '$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray())}';

const READERS: Partial<Record<NodeJS.Platform, { readers: Reader[]; hint: string }>> = {
  win32: { readers: [{ cmd: 'powershell', args: ['-NoProfile', '-STA', '-Command', WINDOWS_SCRIPT], output: 'base64' }], hint: 'powershell not found' },
  darwin: { readers: [{ cmd: 'osascript', args: ['-e', 'the clipboard as «class PNGf»'], output: 'applescript' }], hint: 'osascript not found' },
  linux: {
    readers: [
      { cmd: 'wl-paste', args: ['--type', 'image/png'], output: 'binary' },
      { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], output: 'binary' },
    ],
    hint: 'install wl-clipboard or xclip',
  },
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// osascript prints the clipboard as «data PNGf<hex>», not as raw bytes.
function encode(output: Reader['output'], stdout: Buffer): string | undefined {
  if (output === 'binary') { return stdout.toString('base64'); }
  const text = stdout.toString('utf8').trim();
  if (output === 'base64') { return text; }
  const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(text)?.[1];
  return hex ? Buffer.from(hex, 'hex').toString('base64') : undefined;
}

export const runTool: RunTool = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 10_000 }, (err, stdout) => {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { resolve(undefined); return; }
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
    resolve({ code, stdout });
  });
});

export async function readClipboardImage(run: RunTool = runTool, platform: NodeJS.Platform = process.platform): Promise<ClipboardImage> {
  const entry = READERS[platform];
  if (!entry) { return { kind: 'no-tool', hint: `unsupported platform ${platform}` }; }
  let found = false;
  for (const reader of entry.readers) {
    const out = await run(reader.cmd, reader.args);
    if (!out) { continue; }
    found = true;
    if (out.code !== 0) { continue; }
    const base64 = encode(reader.output, out.stdout);
    if (!base64) { continue; }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      return { kind: 'image', mediaType: 'image/png', base64 };
    }
  }
  return found ? { kind: 'none' } : { kind: 'no-tool', hint: entry.hint };
}
