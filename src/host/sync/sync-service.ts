import * as os from 'node:os';
import type {
  HostToWebview, SyncDeviceView, SyncField, SyncPanel, SyncStatus, WebviewToHost,
} from '../../protocol/messages';
import { readCredentials, removeCredentials, writeCredentials, type SyncCredentials } from '../../sync/credentials';
import { REVOKED_ERROR } from '../../sync/http';
import { SyncClient, type Result, type SyncClientOptions } from '../../sync/sync-client';
import { loadConfig, patchConfig } from '../config-file';
import type { ProjectOverride } from '../host-config';
import type { ProjectRef } from '../project/project-resolver';
import { applyProjectChoice, projectRows } from './project-rows';

export type SyncMessage = Extract<WebviewToHost, { t: `sync-${string}` }>;
type Paired = Extract<SyncPanel, { state: 'paired' }>;

export interface SyncServiceDeps {
  home: string;
  configFile: string;
  roots: () => string[];
  overrides: ProjectOverride[];
  resolve: (cwd: string) => Promise<ProjectRef | undefined>;
  broadcast: (msg: HostToWebview) => void;
  hostname?: () => string;
  healthMs?: number;
  clientOptions?: SyncClientOptions;
}

const HEALTH_MS = 300_000;

function fieldOf(error: string): SyncField | undefined {
  if (/code/i.test(error)) { return 'code'; }
  if (/reach|url|http/i.test(error)) { return 'server'; }
  return undefined;
}

const unwrap = <T>(result: Result<T>): T | undefined => (result.ok ? result.value : undefined);

/** The host side of the Sync dialog: credentials, `config.json`, and the health check behind the status chip. */
export class SyncService {
  private overrides: ProjectOverride[];
  private pairing: Paired['pairing'];
  private lastDevices: SyncDeviceView[] = [];
  private current: SyncStatus = 'off';
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Map<string, Promise<SyncPanel>>();
  private lastPaired: Paired | undefined;
  private projectWrites: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SyncServiceDeps) {
    this.overrides = [...deps.overrides];
  }

  status(): SyncStatus { return this.current; }

  start(): void {
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, this.deps.healthMs ?? HEALTH_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); }
  }

  /**
   * Never rejects; a request already running for the same key is joined rather than repeated. A
   * busy interim is sent at once from the last panel, so it can never arrive after the final one.
   */
  handle(msg: SyncMessage, interim: (panel: SyncPanel) => void): Promise<SyncPanel> {
    if (msg.t === 'sync-project') {
      const write = this.projectWrites.then(() => this.run(msg, interim))
        .catch((err: unknown) => this.panel({ message: err instanceof Error ? err.message : String(err) }));
      this.projectWrites = write;
      return write;
    }
    const busyKind = msg.t === 'sync-pair' ? 'pair' : msg.t === 'sync-revoke' ? 'revoke' : msg.t === 'sync-leave' ? 'leave' : undefined;
    if (busyKind && this.lastPaired && !this.inflight.size) { interim({ ...this.lastPaired, busy: busyKind }); }
    const key = msg.t === 'sync-revoke' ? `${msg.t}:${msg.deviceId}` : msg.t;
    const running = this.inflight.get(key);
    if (running) { return running; }
    const work = this.run(msg, interim)
      .catch((err: unknown) => this.panel({ message: err instanceof Error ? err.message : String(err) }))
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, work);
    return work;
  }

  private setStatus(next: SyncStatus): void {
    if (next === this.current) { return; }
    this.current = next;
    this.deps.broadcast({ t: 'sync-status', status: next });
  }

  private async check(): Promise<void> {
    const creds = await readCredentials(this.deps.home);
    if (!creds) { this.setStatus('off'); return; }
    const devices = await this.client(creds).devices();
    this.setStatus(devices.ok ? 'ok' : devices.error === REVOKED_ERROR ? 'revoked' : 'offline');
  }

  private client(creds: SyncCredentials): SyncClient {
    return new SyncClient(creds, this.deps.clientOptions);
  }

  private defaultName(): string {
    return (this.deps.hostname ?? os.hostname)();
  }

  private async run(msg: SyncMessage, interim: (panel: SyncPanel) => void): Promise<SyncPanel> {
    const creds = await readCredentials(this.deps.home);
    switch (msg.t) {
      case 'sync-open':
      case 'sync-refresh':
        return this.panel();
      case 'sync-setup':
      case 'sync-join': {
        if (creds) { return this.panel({ message: 'This machine is already paired. Leave sync first to pair it again.' }); }
        const name = msg.name.trim() || this.defaultName();
        interim({ state: 'unpaired', defaultName: this.defaultName(), busy: true });
        const result = msg.t === 'sync-setup'
          ? await SyncClient.enroll(msg.server, msg.code.trim(), name, this.deps.clientOptions)
          : await SyncClient.join(msg.server, msg.code.trim(), name, this.deps.clientOptions);
        if (!result.ok) {
          const field = fieldOf(result.error);
          return { state: 'unpaired', defaultName: this.defaultName(), error: { ...(field ? { field } : {}), message: result.error } };
        }
        await writeCredentials(this.deps.home, result.value);
        await this.patchSync({ server: result.value.server, deviceName: result.value.deviceName });
        this.setStatus('ok');
        return this.panel();
      }
      case 'sync-forget':
        await removeCredentials(this.deps.home);
        this.pairing = undefined;
        this.lastPaired = undefined;
        this.setStatus('off');
        return this.panel();
      case 'sync-project': {
        await this.writeProjectChoice(msg.path, msg.choice);
        return this.panel();
      }
      default:
        break;
    }
    if (!creds) { return this.panel(); }
    const client = this.client(creds);
    switch (msg.t) {
      case 'sync-pair': {
        const result = await client.createPairing();
        if (!result.ok) { return this.panel({ message: result.error }); }
        await writeCredentials(this.deps.home, client.credentials);
        this.pairing = { ...result.value, joinCommand: `marcode sync join ${creds.server} ${result.value.code}` };
        return this.panel();
      }
      case 'sync-revoke': {
        const device = unwrap(await client.devices())?.find((d) => d.deviceId === msg.deviceId);
        const result = device?.revokedAt !== undefined ? await client.rotateKey() : await client.revoke(msg.deviceId);
        if (!result.ok) { return this.panel({ message: result.error }); }
        await writeCredentials(this.deps.home, result.value);
        return this.panel();
      }
      case 'sync-leave': {
        const result = await client.leave();
        await removeCredentials(this.deps.home);
        await this.patchSync({});
        this.pairing = undefined;
        this.lastPaired = undefined;
        this.setStatus('off');
        return result.ok ? this.panel() : { state: 'unpaired', defaultName: this.defaultName(), error: { message: `This device's sync data was removed, but the server could not be told: ${result.error}` } };
      }
      default:
        return this.panel();
    }
  }

  private async panel(error?: { message: string }): Promise<SyncPanel> {
    const creds = await readCredentials(this.deps.home);
    if (!creds) {
      return { state: 'unpaired', defaultName: this.defaultName(), ...(error ? { error } : {}) };
    }
    const client = this.client(creds);
    const [devices, unfinished, projects] = await Promise.all([
      client.devices(), client.unfinishedRevokes(), projectRows(this.deps.roots(), this.overrides, this.deps.resolve),
    ]);
    const connection = devices.ok ? 'connected' : devices.error === REVOKED_ERROR ? 'revoked' : 'unreachable';
    this.setStatus(connection === 'connected' ? 'ok' : connection === 'revoked' ? 'revoked' : 'offline');
    if (devices.ok) {
      const stale = new Set(unwrap(unfinished) ?? []);
      this.lastDevices = devices.value.map((d) => ({
        deviceId: d.deviceId, name: d.name, lastSeenAt: d.lastSeenAt, self: d.deviceId === creds.deviceId,
        revoked: d.revokedAt !== undefined, ...(stale.has(d.deviceId) ? { unfinishedRevoke: true as const } : {}),
      }));
    }
    if (this.pairing && this.pairing.expiresAt <= Date.now()) { this.pairing = undefined; }
    const panel: Paired = {
      state: 'paired', server: creds.server, deviceName: creds.deviceName, connection, devices: this.lastDevices, projects,
      ...(this.pairing ? { pairing: this.pairing } : {}),
    };
    this.lastPaired = panel;
    return error ? { ...panel, error } : panel;
  }

  private async rawConfig(): Promise<Record<string, unknown>> {
    try { return ((await loadConfig(this.deps.configFile)).raw ?? {}) as Record<string, unknown>; } catch { return {}; }
  }

  private async patchSync(sync: Record<string, unknown>): Promise<void> {
    await patchConfig(this.deps.configFile, { sync });
  }

  /** Applied to the overrides on disk at write time, so another window's or a hand edit since startup survives. */
  private async writeProjectChoice(root: string, choice: 'shared' | 'own' | { link: string }): Promise<void> {
    const raw = await this.rawConfig();
    const projects = typeof raw.projects === 'object' && raw.projects !== null ? raw.projects as Record<string, unknown> : {};
    const onDisk = Array.isArray(projects.overrides)
      ? (projects.overrides as unknown[]).filter((o): o is ProjectOverride =>
        typeof o === 'object' && o !== null && typeof (o as ProjectOverride).path === 'string' && typeof (o as ProjectOverride).project === 'string')
      : [];
    const next = applyProjectChoice(onDisk, root, choice);
    await patchConfig(this.deps.configFile, { projects: { ...projects, overrides: next } });
    this.overrides = next;
  }
}
