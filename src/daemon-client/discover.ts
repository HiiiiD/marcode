import { readDaemonInfo, type DaemonInfo } from '../daemon/daemon-info';
import { defaultLeaseDeps } from '../host/lease';

export async function discover(
  dir: string,
  pidAlive: (pid: number) => boolean = defaultLeaseDeps.pidAlive,
): Promise<DaemonInfo | undefined> {
  const info = await readDaemonInfo(dir);
  return info && pidAlive(info.pid) ? info : undefined;
}
