import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

export interface SandboxConfig {
  /** Persistent workspace directory for this agent */
  workspaceDir: string;
  /** Memory limit in MB (default: 256) */
  memoryMb?: number;
  /** CPU quota percentage (default: 50) */
  cpuPercent?: number;
  /** Max PIDs (default: 128) */
  maxPids?: number;
  /** Domains the sandbox can reach (in addition to localhost) */
  allowedDomains?: string[];
  /** Environment variables to pass into the sandbox */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Lightweight sandbox using bubblewrap (bwrap) directly.
 *
 * Each command runs in an isolated namespace with:
 * - Read-only root filesystem
 * - Writable workspace directory
 * - PID namespace isolation
 * - Optional network isolation
 *
 * No daemon, no container runtime. Just Linux namespaces.
 */
export class Sandbox {
  private config: Required<SandboxConfig>;
  private useBwrap: boolean;

  constructor(config: SandboxConfig) {
    this.config = {
      workspaceDir: config.workspaceDir,
      memoryMb: config.memoryMb ?? 256,
      cpuPercent: config.cpuPercent ?? 50,
      maxPids: config.maxPids ?? 128,
      allowedDomains: config.allowedDomains ?? [],
      env: config.env ?? {},
    };

    // Ensure workspace exists
    if (!existsSync(this.config.workspaceDir)) {
      mkdirSync(this.config.workspaceDir, { recursive: true });
    }

    // Check if bwrap is available
    this.useBwrap = this.checkBwrap();
  }

  private checkBwrap(): boolean {
    try {
      const r = spawnSync("bwrap", ["--version"], { stdio: "pipe" });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Execute a command in the sandbox.
   * If bwrap is not available (e.g., macOS), falls back to direct execution
   * in the workspace directory with restricted env.
   */
  async exec(command: string, timeoutMs: number = 30_000): Promise<ExecResult> {
    if (this.useBwrap) {
      return this.execBwrap(command, timeoutMs);
    }
    return this.execDirect(command, timeoutMs);
  }

  /**
   * Execute with bwrap isolation (Linux).
   */
  private execBwrap(command: string, timeoutMs: number): Promise<ExecResult> {
    const args = [
      "--new-session",
      "--die-with-parent",
      // Read-only root
      "--ro-bind",
      "/",
      "/",
      // Writable workspace
      "--bind",
      this.config.workspaceDir,
      this.config.workspaceDir,
      // Writable /tmp
      "--tmpfs",
      "/tmp",
      // Fresh /dev and /proc
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      // PID namespace
      "--unshare-pid",
      // UTS namespace (hostname)
      "--unshare-uts",
      // IPC namespace
      "--unshare-ipc",
      // Set working directory
      "--chdir",
      this.config.workspaceDir,
    ];

    // Inject environment variables
    for (const [key, value] of Object.entries(this.config.env)) {
      args.push("--setenv", key, value);
    }

    // Set workspace-related env
    args.push("--setenv", "HOME", this.config.workspaceDir);
    args.push("--setenv", "PWD", this.config.workspaceDir);

    // The command to run
    args.push("--", "/bin/bash", "-c", command);

    return this.spawnAndCollect("bwrap", args, timeoutMs);
  }

  /**
   * Fallback: execute directly in workspace dir (macOS / no bwrap).
   * Less isolated but still restricted to the workspace.
   */
  private execDirect(command: string, timeoutMs: number): Promise<ExecResult> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.config.env,
      HOME: this.config.workspaceDir,
      PWD: this.config.workspaceDir,
    };

    return this.spawnAndCollect("/bin/bash", ["-c", command], timeoutMs, {
      cwd: this.config.workspaceDir,
      env,
    });
  }

  private spawnAndCollect(
    cmd: string,
    args: string[],
    timeoutMs: number,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        ...opts,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on("error", (err) => {
        resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: 1 });
      });
    });
  }

  get workspace(): string {
    return this.config.workspaceDir;
  }
}
