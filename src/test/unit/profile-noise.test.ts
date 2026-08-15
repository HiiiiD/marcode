import * as assert from 'assert';
import { profileNoiseIn } from '../../host/profile-noise';

const ESC = '\u001b';

/**
 * Verbatim from a codex-cli 0.147.0 turn on Windows, 2026-08-15: Codex wraps
 * every command as `pwsh.exe -Command "…"` WITHOUT `-NoProfile`, so the user's
 * profile loads, PSReadLine fails against the redirected console, and the
 * resulting error frames land in the command's own output.
 *
 * The message text is Italian ("Handle non valido") because PowerShell
 * localizes it — which is exactly why the detector must key off the
 * `<Cmdlet>: <profile path>:<line>` frame and never off message wording.
 * Colour codes are interleaved mid-token, as the terminal delivered them.
 */
const REAL_NOISE = [
  `${ESC}[31;1mSet-PSReadLineOption: ${ESC}[0mC:\\Users\\Marco\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1:23${ESC}[0m`,
  `${ESC}[31;1m${ESC}[0m${ESC}[36;1mLine |${ESC}[0m`,
  `${ESC}[36;1m  23 | ${ESC}[0m ${ESC}[36;1mSet-PSReadLineOption -PredictionViewStyle ListView${ESC}[0m`,
  `${ESC}[36;1m     | ${ESC}[31;1m ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~${ESC}[0m`,
  `${ESC}[36;1m     | ${ESC}[31;1mHandle non valido.${ESC}[0m`,
  '',
].join('\n');

/** The same failure from Windows PowerShell 5.1, whose profile lives elsewhere. */
const WPS_NOISE = 'Set-PSReadLineOption : '
  + 'C:\\Users\\Marco\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1:23\n'
  + 'Handle is invalid.\n';

/** An AllHosts profile, which is named `profile.ps1` with no host prefix. */
const ALL_HOSTS_NOISE = 'Import-Module: /home/dev/.config/powershell/profile.ps1:4\n'
  + 'The specified module was not loaded.\n';

suite('profileNoiseIn', () => {
  test('finds the profile a real PSReadLine failure names, colour codes and all', () => {
    assert.strictEqual(
      profileNoiseIn(REAL_NOISE),
      'C:\\Users\\Marco\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    );
  });

  test('reads the 5.1 frame, whose cmdlet is followed by a space before the colon', () => {
    assert.strictEqual(
      profileNoiseIn(WPS_NOISE),
      'C:\\Users\\Marco\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1',
    );
  });

  test('reads an AllHosts profile.ps1 frame', () => {
    assert.strictEqual(
      profileNoiseIn(ALL_HOSTS_NOISE),
      '/home/dev/.config/powershell/profile.ps1',
    );
  });

  test('ordinary command output is not noise', () => {
    assert.strictEqual(profileNoiseIn('total 4\ndrwxr-xr-x 1 dev dev 0 src\n'), undefined);
    assert.strictEqual(profileNoiseIn(''), undefined);
    assert.strictEqual(profileNoiseIn(undefined), undefined);
  });

  test('an agent READING a profile is not a profile that failed', () => {
    // `Get-Content …\Microsoft.PowerShell_profile.ps1` echoes the very lines
    // that appear inside a real error frame — the offending cmdlet call among
    // them. Matching on those would fire the warning at a user whose profile
    // is fine, every time an agent inspects one.
    const listing = 'Import-Module posh-git\n'
      + 'Set-PSReadLineOption -PredictionSource HistoryAndPlugin\n'
      + 'Set-PSReadLineOption -PredictionViewStyle ListView\n';
    assert.strictEqual(profileNoiseIn(listing), undefined);
  });

  test('a path mentioned without an error frame is not noise', () => {
    // The command line itself is echoed into output by some shells.
    const echoed = 'pwsh -NoProfile -Command "Get-Content '
      + 'C:\\Users\\Marco\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1"\n';
    assert.strictEqual(profileNoiseIn(echoed), undefined);
  });

  test('an error frame in a script that merely lives next to a profile is not noise', () => {
    // Only a file that IS a profile counts: `…\Microsoft.PowerShell_profile.ps1`
    // or a bare `profile.ps1`. A user script erroring is the agent's business,
    // not ours.
    const other = 'Set-PSReadLineOption: C:\\repo\\tools\\bootstrap.ps1:12\nHandle is invalid.\n';
    assert.strictEqual(profileNoiseIn(other), undefined);
  });
});
