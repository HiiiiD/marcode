import { execFile } from 'node:child_process';

export type ClipboardImage =
  | { kind: 'image'; mediaType: 'image/png'; base64: string }
  | { kind: 'none' }
  | { kind: 'no-tool'; hint: string };

export type RunTool = (cmd: string, args: string[]) => Promise<{ code: number; stdout: Buffer } | undefined>;

interface Reader { cmd: string; args: string[]; output: 'binary' | 'base64' }

const WINDOWS_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; '
  + '$i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){$m=New-Object IO.MemoryStream; '
  + '$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray())}';

const READERS: Partial<Record<NodeJS.Platform, { readers: Reader[]; hint: string }>> = {
  win32: { readers: [{ cmd: 'powershell', args: ['-NoProfile', '-STA', '-Command', WINDOWS_SCRIPT], output: 'base64' }], hint: 'powershell not found' },
  darwin: { readers: [{ cmd: 'pngpaste', args: ['-'], output: 'binary' }], hint: 'install pngpaste (brew install pngpaste)' },
  linux: {
    readers: [
      { cmd: 'wl-paste', args: ['--type', 'image/png'], output: 'binary' },
      { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], output: 'binary' },
    ],
    hint: 'install wl-clipboard or xclip',
  },
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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
    const base64 = reader.output === 'base64' ? out.stdout.toString('utf8').trim() : out.stdout.toString('base64');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      return { kind: 'image', mediaType: 'image/png', base64 };
    }
  }
  return found ? { kind: 'none' } : { kind: 'no-tool', hint: entry.hint };
}
