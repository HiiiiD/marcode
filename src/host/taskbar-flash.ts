import { spawn } from 'node:child_process';
import * as path from 'node:path';

// FLASHW_ALL | FLASHW_TIMERNOFG: flash caption and taskbar until the window is foregrounded.
const SCRIPT = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class MarFlash {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO f);
  struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  public static void Run(uint[] pids, string hint) {
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      var title = sb.ToString();
      if (title.Length == 0 || (hint.Length > 0 && title.IndexOf(hint, StringComparison.OrdinalIgnoreCase) < 0)) return true;
      var f = new FLASHWINFO { cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)), hwnd = h, dwFlags = 15, uCount = uint.MaxValue, dwTimeout = 0 };
      FlashWindowEx(ref f);
      return true;
    }, IntPtr.Zero);
  }
}
"@
$pids = [uint32[]]@(Get-Process -Name $env:MARCODE_FLASH_EXE -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
[MarFlash]::Run($pids, [string]$env:MARCODE_FLASH_TITLE)
`;

export interface FlashCommand { file: string; args: string[]; env: Record<string, string> }

/** Title and exe travel as env vars so neither needs escaping into the script. */
export function buildFlashCommand(execPath: string, titleHint: string): FlashCommand {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    env: { MARCODE_FLASH_EXE: path.basename(execPath, '.exe'), MARCODE_FLASH_TITLE: titleHint },
  };
}

export function flashTaskbar(titleHint: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') { return; }
  const cmd = buildFlashCommand(process.execPath, titleHint);
  try {
    const child = spawn(cmd.file, cmd.args, {
      env: { ...process.env, ...cmd.env }, windowsHide: true, stdio: 'ignore',
    });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* attention is best-effort */ }
}
