import { spawn, ChildProcess } from 'child_process';
import os from 'os';
import net from 'net';
import path from 'path';

export interface SyncLogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  runnerId: string;
  platform: string;
}

export interface PendingDischargeStats {
  lastCheckedAt: string | null;
  totalDetected: number;
  addedCount: number;
  skippedDialysisCount: number;
  skippedErCount: number;
  skippedAlreadyDischargedCount: number;
  recentCases: string[];
}

export interface RunnerInfo {
  runnerId: string;
  hostname: string;
  platform: 'mac' | 'windows' | 'linux';
  osLabel: string;
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  onPremReachable: boolean;
  status: 'running' | 'syncing' | 'paused' | 'idle-off-prem' | 'standby-pool-full' | 'restarting' | 'error';
  childPid: number | null;
  restartCount: number;
  lastCycleStartedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunEta: string | null;
  pendingDischarge: PendingDischargeStats;
}

export interface SyncControlState {
  paused: boolean;
  desiredState: 'running' | 'paused';
  maxRunners: number;
  runNowRequestId: number;
  restartRequestId: number;
  lastUserOpenedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

const MAX_SYNC_RUNNERS_DEFAULT = Number(process.env.MAX_SYNC_RUNNERS || 2);
const HEARTBEAT_INTERVAL_MS = 12_000;
const CONTROL_POLL_INTERVAL_MS = 4_000;
const STALE_RUNNER_MS = 45_000;
const MAX_LOG_LINES = 300;

function detectPlatform(): { platform: 'mac' | 'windows' | 'linux'; osLabel: string } {
  const p = os.platform();
  if (p === 'darwin') return { platform: 'mac', osLabel: `macOS (${os.release()})` };
  if (p === 'win32') return { platform: 'windows', osLabel: `Windows (${os.release()})` };
  return { platform: 'linux', osLabel: `Linux (${os.release()})` };
}

function checkTcpHost(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export async function checkOnPremReachable(): Promise<boolean> {
  if (process.env.VERCEL) return false;
  const [hmisOk, pbiOk] = await Promise.all([
    checkTcpHost('10.12.0.10', 80, 2500),
    checkTcpHost('10.12.0.11', 80, 2500),
  ]);
  return hmisOk || pbiOk;
}

function redactSecrets(line: string): string {
  let out = line;
  const secrets = [
    process.env.ELITE_PASS,
    process.env.POWERBI_PASS,
    process.env.FORTINET_PASS,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_KEY,
  ].filter((s): s is string => Boolean(s && s.length > 3));
  for (const sec of secrets) {
    out = out.split(sec).join('***');
  }
  return out;
}

export class SyncSupervisor {
  private supabaseAdmin: any;
  private runnerInfo: RunnerInfo;
  private logs: SyncLogEntry[] = [];
  private logSeq = 1;
  private child: ChildProcess | null = null;
  private forceOneOffChild: ChildProcess | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private controlTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastSeenRunNowId = 0;
  private lastSeenRestartId = 0;
  private started = false;
  private shuttingDown = false;
  private controlState: SyncControlState = {
    paused: false,
    desiredState: 'running',
    maxRunners: MAX_SYNC_RUNNERS_DEFAULT,
    runNowRequestId: 0,
    restartRequestId: 0,
    lastUserOpenedAt: null,
    updatedBy: null,
    updatedAt: new Date().toISOString(),
  };

  constructor(supabaseAdmin: any) {
    this.supabaseAdmin = supabaseAdmin;
    const { platform, osLabel } = detectPlatform();
    const host = os.hostname() || 'host';
    this.runnerInfo = {
      runnerId: `${platform}-${host}-${process.pid}`,
      hostname: host,
      platform,
      osLabel,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      onPremReachable: false,
      status: 'idle-off-prem',
      childPid: null,
      restartCount: 0,
      lastCycleStartedAt: null,
      lastSuccessAt: null,
      lastError: null,
      nextRunEta: null,
      pendingDischarge: {
        lastCheckedAt: null,
        totalDetected: 0,
        addedCount: 0,
        skippedDialysisCount: 0,
        skippedErCount: 0,
        skippedAlreadyDischargedCount: 0,
        recentCases: [],
      },
    };
  }

  private pushLog(level: 'info' | 'warning' | 'error', rawMsg: string) {
    const clean = redactSecrets(rawMsg).trim();
    if (!clean) return;
    // Ignore carriage-return countdown noise
    if (clean.startsWith('Next sync in:') || clean.includes('Next sync in:')) return;

    this.logs.push({
      id: this.logSeq++,
      timestamp: new Date().toISOString(),
      level,
      message: clean,
      runnerId: this.runnerInfo.runnerId,
      platform: this.runnerInfo.platform,
    });
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }

    // Parse domain events from sync_powerbi_relational.py
    if (clean.includes('=== STARTING SYNC JOB CYCLE ===')) {
      this.runnerInfo.status = 'syncing';
      this.runnerInfo.lastCycleStartedAt = new Date().toISOString();
      this.runnerInfo.pendingDischarge = {
        lastCheckedAt: new Date().toISOString(),
        totalDetected: 0,
        addedCount: 0,
        skippedDialysisCount: 0,
        skippedErCount: 0,
        skippedAlreadyDischargedCount: 0,
        recentCases: [],
      };
    } else if (clean.includes('successfully committed:')) {
      const now = new Date();
      this.runnerInfo.status = 'running';
      this.runnerInfo.lastSuccessAt = now.toISOString();
      this.runnerInfo.lastError = null;
      this.runnerInfo.nextRunEta = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    } else if (clean.includes('[Sync Dedup]')) {
      const now = new Date();
      this.runnerInfo.status = 'running';
      this.runnerInfo.nextRunEta = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    } else if (clean.includes('Sync error encountered:') || clean.includes('Max retry attempts')) {
      this.runnerInfo.lastError = clean;
      if (this.runnerInfo.status === 'syncing') {
        this.runnerInfo.status = 'error';
      }
    } else if (clean.includes('[HMIS Pending]')) {
      this.runnerInfo.pendingDischarge.lastCheckedAt = new Date().toISOString();
      const countMatch = clean.match(/\[HMIS Pending\]\s+(\d+)\s+case\(s\)\s+currently/i);
      if (countMatch) {
        this.runnerInfo.pendingDischarge.totalDetected = Number(countMatch[1]);
      } else if (clean.includes('Skipped dialysis case:')) {
        this.runnerInfo.pendingDischarge.skippedDialysisCount += 1;
      } else if (clean.includes('Skipped ER case:')) {
        this.runnerInfo.pendingDischarge.skippedErCount += 1;
      } else if (clean.includes('Already discharged') || clean.includes('Already in cumulative discharged')) {
        this.runnerInfo.pendingDischarge.skippedAlreadyDischargedCount += 1;
      } else if (clean.includes('Added to cumulative discharged:') || clean.includes('Would add to cumulative discharged:')) {
        this.runnerInfo.pendingDischarge.addedCount += 1;
        const label = clean.split('discharged:')[1]?.trim();
        if (label && !this.runnerInfo.pendingDischarge.recentCases.includes(label)) {
          this.runnerInfo.pendingDischarge.recentCases.unshift(label);
          this.runnerInfo.pendingDischarge.recentCases = this.runnerInfo.pendingDischarge.recentCases.slice(0, 10);
        }
      }
    }
  }

  private resolvePythonCommand(): string {
    if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
    return os.platform() === 'win32' ? 'python' : 'python3';
  }

  private spawnSyncProcess() {
    if (this.child || this.shuttingDown || process.env.VERCEL) return;

    const pyCmd = this.resolvePythonCommand();
    const scriptPath = path.join(process.cwd(), 'sync_powerbi_relational.py');
    this.pushLog('info', `[Supervisor] Launching ${pyCmd} sync_powerbi_relational.py on ${this.runnerInfo.osLabel}...`);

    try {
      const child = spawn(pyCmd, ['-u', scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.child = child;
      this.runnerInfo.childPid = child.pid || null;
      this.runnerInfo.status = 'running';

      const handleChunk = (chunk: Buffer, defaultLevel: 'info' | 'error') => {
        const text = chunk.toString('utf-8');
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          let lvl: 'info' | 'warning' | 'error' = defaultLevel;
          if (line.includes('[ERROR]')) lvl = 'error';
          else if (line.includes('[WARNING]')) lvl = 'warning';
          else if (line.includes('[INFO]')) lvl = 'info';
          this.pushLog(lvl, line);
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => handleChunk(chunk, 'info'));
      child.stderr?.on('data', (chunk: Buffer) => handleChunk(chunk, 'error'));

      child.on('error', (err) => {
        this.pushLog('error', `[Supervisor] Failed to launch Python process (${pyCmd}): ${err.message}`);
        this.runnerInfo.status = 'error';
        this.runnerInfo.lastError = `Python spawn error: ${err.message}`;
        this.child = null;
        this.runnerInfo.childPid = null;
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        this.runnerInfo.childPid = null;
        if (this.shuttingDown || this.controlState.paused) {
          this.runnerInfo.status = this.controlState.paused ? 'paused' : 'idle-off-prem';
          this.pushLog('info', `[Supervisor] Sync script stopped (code=${code}, signal=${signal}).`);
          return;
        }
        this.runnerInfo.restartCount += 1;
        this.runnerInfo.status = 'restarting';
        const delayMs = Math.min(60_000, 5_000 * Math.pow(2, Math.min(3, this.runnerInfo.restartCount - 1)));
        this.pushLog('warning', `[Supervisor] Sync script exited (code=${code}). Auto-restarting in ${Math.round(delayMs / 1000)}s...`);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.reconcileRunnerState().catch(() => {});
        }, delayMs);
      });
    } catch (err: any) {
      this.pushLog('error', `[Supervisor] Exception spawning sync script: ${err?.message || String(err)}`);
      this.runnerInfo.status = 'error';
      this.runnerInfo.lastError = err?.message || String(err);
    }
  }

  private stopSyncProcess(reason: string) {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.pushLog('info', `[Supervisor] Stopping sync process (${reason})...`);
      try {
        this.child.kill('SIGTERM');
      } catch (_) {}
      this.child = null;
      this.runnerInfo.childPid = null;
    }
  }

  private triggerImmediateOneOffSync() {
    if (process.env.VERCEL || !this.runnerInfo.onPremReachable) return;
    if (this.forceOneOffChild) {
      this.pushLog('info', '[Supervisor] Run-Now already in progress on this runner.');
      return;
    }
    const pyCmd = this.resolvePythonCommand();
    const scriptPath = path.join(process.cwd(), 'sync_powerbi_relational.py');
    this.pushLog('info', '[Supervisor] Executing immediate Run-Now sync cycle (--once --force)...');
    this.runnerInfo.status = 'syncing';

    try {
      const child = spawn(pyCmd, ['-u', scriptPath, '--once', '--force'], {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_SYNC_NOW: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.forceOneOffChild = child;
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
          if (line.trim()) this.pushLog('info', line);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
          if (line.trim()) this.pushLog('error', line);
        }
      });
      child.on('exit', (code) => {
        this.forceOneOffChild = null;
        this.pushLog('info', `[Supervisor] Immediate Run-Now cycle finished (exit code=${code}).`);
        this.runnerInfo.status = this.controlState.paused ? 'paused' : (this.child ? 'running' : 'idle-off-prem');
        this.publishHeartbeat().catch(() => {});
      });
    } catch (err: any) {
      this.forceOneOffChild = null;
      this.pushLog('error', `[Supervisor] Run-Now failed: ${err?.message || String(err)}`);
    }
  }

  public async loadControlState(): Promise<SyncControlState> {
    if (!this.supabaseAdmin) return this.controlState;
    try {
      const { data } = await this.supabaseAdmin
        .from('rtdb_nodes')
        .select('data')
        .eq('path', 'settings/sync_control')
        .maybeSingle();
      if (data?.data && typeof data.data === 'object') {
        this.controlState = {
          ...this.controlState,
          ...data.data,
          maxRunners: Number(data.data.maxRunners || MAX_SYNC_RUNNERS_DEFAULT),
        };
      }
    } catch (_) {}
    return this.controlState;
  }

  public async saveControlState(partial: Partial<SyncControlState>): Promise<SyncControlState> {
    await this.loadControlState();
    this.controlState = {
      ...this.controlState,
      ...partial,
      updatedAt: new Date().toISOString(),
    };
    if (this.supabaseAdmin) {
      try {
        await this.supabaseAdmin.from('rtdb_nodes').upsert({
          path: 'settings/sync_control',
          data: this.controlState,
          updated_at: new Date().toISOString(),
        });
      } catch (_) {}
    }
    return this.controlState;
  }

  private async reconcileRunnerState() {
    if (process.env.VERCEL || this.shuttingDown) return;

    await this.loadControlState();
    const reachable = await checkOnPremReachable();
    this.runnerInfo.onPremReachable = reachable;

    // Handle remote Run-Now command
    if (this.controlState.runNowRequestId > this.lastSeenRunNowId) {
      this.lastSeenRunNowId = this.controlState.runNowRequestId;
      if (reachable) {
        this.triggerImmediateOneOffSync();
      }
    }

    // Handle remote Restart command
    if (this.controlState.restartRequestId > this.lastSeenRestartId) {
      this.lastSeenRestartId = this.controlState.restartRequestId;
      if (reachable && !this.controlState.paused) {
        this.stopSyncProcess('Admin Restart Command');
      }
    }

    if (this.controlState.paused) {
      if (this.child) this.stopSyncProcess('Paused by Admin');
      this.runnerInfo.status = 'paused';
      await this.publishHeartbeat();
      return;
    }

    if (!reachable) {
      if (this.child) this.stopSyncProcess('Off-Prem Network');
      this.runnerInfo.status = 'idle-off-prem';
      await this.publishHeartbeat();
      return;
    }

    // Check runner pool capacity (max 2: 1 Mac + 1 Windows, or up to maxRunners)
    const activeRunners = await this.getActiveRunnersFromSupabase();
    const otherActive = activeRunners.filter(
      (r) => r.runnerId !== this.runnerInfo.runnerId && r.onPremReachable && r.status !== 'idle-off-prem'
    );
    const maxRunners = this.controlState.maxRunners || MAX_SYNC_RUNNERS_DEFAULT;

    if (otherActive.length >= maxRunners) {
      if (this.child) this.stopSyncProcess(`Pool full (${maxRunners}/${maxRunners})`);
      this.runnerInfo.status = 'standby-pool-full';
      await this.publishHeartbeat();
      return;
    }

    if (!this.child) {
      this.spawnSyncProcess();
    }
    await this.publishHeartbeat();
  }

  public async getActiveRunnersFromSupabase(): Promise<RunnerInfo[]> {
    if (!this.supabaseAdmin) return process.env.VERCEL ? [] : [this.runnerInfo];
    try {
      const { data } = await this.supabaseAdmin
        .from('rtdb_nodes')
        .select('data')
        .eq('path', 'settings/sync_runners')
        .maybeSingle();
      const rawRunners: RunnerInfo[] = Array.isArray(data?.data?.runners) ? data.data.runners : [];
      const now = Date.now();
      return rawRunners.filter((r) => {
        const hb = new Date(r.lastHeartbeatAt || 0).getTime();
        return !isNaN(hb) && now - hb < STALE_RUNNER_MS;
      });
    } catch (_) {
      return process.env.VERCEL ? [] : [this.runnerInfo];
    }
  }

  public async publishHeartbeat() {
    if (process.env.VERCEL || !this.supabaseAdmin) return;
    this.runnerInfo.lastHeartbeatAt = new Date().toISOString();
    try {
      const { data } = await this.supabaseAdmin
        .from('rtdb_nodes')
        .select('data')
        .eq('path', 'settings/sync_runners')
        .maybeSingle();

      const now = Date.now();
      const existingRunners: RunnerInfo[] = Array.isArray(data?.data?.runners) ? data.data.runners : [];
      const existingLogs: SyncLogEntry[] = Array.isArray(data?.data?.logs) ? data.data.logs : [];

      const freshOthers = existingRunners.filter((r) => {
        if (!r || r.runnerId === this.runnerInfo.runnerId) return false;
        const hb = new Date(r.lastHeartbeatAt || 0).getTime();
        return !isNaN(hb) && now - hb < STALE_RUNNER_MS;
      });

      const mergedRunners = [this.runnerInfo, ...freshOthers].slice(0, 10);

      // Merge recent logs across runners
      const otherLogs = existingLogs.filter((l) => l && l.runnerId !== this.runnerInfo.runnerId);
      const mergedLogs = [...otherLogs, ...this.logs]
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-MAX_LOG_LINES);

      await this.supabaseAdmin.from('rtdb_nodes').upsert({
        path: 'settings/sync_runners',
        data: {
          runners: mergedRunners,
          logs: mergedLogs,
          updatedAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      });
    } catch (_) {}
  }

  public async start() {
    if (this.started || process.env.VERCEL) return;
    this.started = true;

    const control = await this.loadControlState();
    this.lastSeenRunNowId = control.runNowRequestId || 0;
    this.lastSeenRestartId = control.restartRequestId || 0;

    await this.reconcileRunnerState();

    this.controlTimer = setInterval(() => {
      this.reconcileRunnerState().catch(() => {});
    }, CONTROL_POLL_INTERVAL_MS);

    this.heartbeatTimer = setInterval(() => {
      this.publishHeartbeat().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    const cleanExit = () => {
      this.shuttingDown = true;
      if (this.controlTimer) clearInterval(this.controlTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.stopSyncProcess('Server shutting down');
    };
    process.once('SIGINT', cleanExit);
    process.once('SIGTERM', cleanExit);
  }

  public async ensureRunning(userEmail?: string) {
    const control = await this.loadControlState();
    await this.saveControlState({
      lastUserOpenedAt: new Date().toISOString(),
      desiredState: control.paused ? 'paused' : 'running',
      updatedBy: userEmail || control.updatedBy,
    });
    if (!process.env.VERCEL) {
      await this.reconcileRunnerState();
    }
    return this.getFullStatus();
  }

  public async getFullStatus() {
    const [control, runnersData, metaNode] = await Promise.all([
      this.loadControlState(),
      this.supabaseAdmin
        ? this.supabaseAdmin.from('rtdb_nodes').select('data,updated_at').eq('path', 'settings/sync_runners').maybeSingle()
        : Promise.resolve({ data: null }),
      this.supabaseAdmin
        ? this.supabaseAdmin.from('rtdb_nodes').select('data,updated_at').eq('path', 'state/metadata').maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const now = Date.now();
    const rawRunners: RunnerInfo[] = Array.isArray(runnersData?.data?.data?.runners)
      ? runnersData.data.data.runners
      : (!process.env.VERCEL ? [this.runnerInfo] : []);

    const activeRunners = rawRunners.filter((r) => {
      const hb = new Date(r.lastHeartbeatAt || 0).getTime();
      return !isNaN(hb) && now - hb < STALE_RUNNER_MS;
    });

    const logs: SyncLogEntry[] = Array.isArray(runnersData?.data?.data?.logs)
      ? runnersData.data.data.logs
      : this.logs;

    const lastDbUpdatedAt =
      metaNode?.data?.data?.lastDatabaseUpdatedAt ||
      metaNode?.data?.updated_at ||
      null;

    return {
      control,
      maxRunners: control.maxRunners || MAX_SYNC_RUNNERS_DEFAULT,
      activeRunnersCount: activeRunners.filter((r) => r.onPremReachable).length,
      runners: activeRunners,
      lastDatabaseUpdatedAt: lastDbUpdatedAt,
      metadataCounts: metaNode?.data?.data?.counts || null,
      logs: logs.slice(-200),
      serverMode: process.env.VERCEL ? 'cloud-vercel' : 'local-node',
    };
  }
}
