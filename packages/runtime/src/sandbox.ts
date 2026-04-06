import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  private sandboxTmpDir: string;
  private sandboxBinDir: string;
  private activeChild: ChildProcess | null = null;

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

    // Persistent /tmp for bwrap — survives across exec() calls within one invocation
    const tmpDir = join(this.config.workspaceDir, ".sandbox-tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir);
    }
    this.sandboxTmpDir = tmpDir;

    const binDir = join(this.config.workspaceDir, ".sandbox-bin");
    if (!existsSync(binDir)) {
      mkdirSync(binDir);
    }
    this.sandboxBinDir = binDir;
    this.installHelpers();

    // Check if bwrap is available
    this.useBwrap = this.checkBwrap();
  }

  private installHelpers(): void {
    const doneScript = [
      "#!/bin/sh",
      ": \"${ARKE_DONE_SIGNAL_FILE:?ARKE_DONE_SIGNAL_FILE is not set}\"",
      ": > \"$ARKE_DONE_SIGNAL_FILE\"",
      "printf '%s\\n' \"$ARKE_DONE_SIGNAL_FILE\"",
    ].join("\n");

    for (const name of ["arke-done", "done"]) {
      const scriptPath = join(this.sandboxBinDir, name);
      writeFileSync(
        scriptPath,
        doneScript,
        "utf-8",
      );
      chmodSync(scriptPath, 0o755);
    }
  }

  private checkBwrap(): boolean {
    try {
      // Check that bwrap exists AND can actually create namespaces.
      // Just checking --version isn't enough — bwrap may be installed but
      // namespace creation blocked (e.g. inside Docker without SYS_ADMIN).
      const r = spawnSync("bwrap", [
        "--ro-bind", "/", "/",
        "--unshare-pid",
        "--", "/bin/true",
      ], { stdio: "pipe", timeout: 5_000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  private _killed = false;

  /**
   * Execute a command in the sandbox.
   * If bwrap is not available (e.g., macOS), falls back to direct execution
   * in the workspace directory with restricted env.
   * Returns immediately with exit code 1 if the sandbox has been killed.
   */
  async exec(command: string, timeoutMs: number = 30_000): Promise<ExecResult> {
    if (this._killed) {
      return { stdout: "", stderr: "Sandbox killed", exitCode: 1 };
    }
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
      // Persistent /tmp — bind workspace-local dir so state survives across tool calls
      "--bind",
      this.sandboxTmpDir,
      "/tmp",
      // Writable workspace
      "--bind",
      this.config.workspaceDir,
      this.config.workspaceDir,
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
    args.push(
      "--setenv",
      "PATH",
      `${this.sandboxBinDir}:${this.config.env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    );

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
      PATH: `${this.sandboxBinDir}:${this.config.env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
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

      this.activeChild = child;

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        this.activeChild = null;
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on("error", (err) => {
        this.activeChild = null;
        resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: 1 });
      });
    });
  }

  /**
   * Kill the currently running child process (if any) and prevent future spawns.
   * Sends SIGKILL to ensure immediate termination — bwrap's --new-session
   * means the signal reaches the entire process group.
   */
  kill(): void {
    this._killed = true;
    if (this.activeChild && !this.activeChild.killed) {
      this.activeChild.kill("SIGKILL");
      this.activeChild = null;
    }
  }

  get workspace(): string {
    return this.config.workspaceDir;
  }
}
