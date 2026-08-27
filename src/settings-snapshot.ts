import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type SettingsLoadScope = "global" | "project";

export interface SettingsLoadIssue {
  scope: SettingsLoadScope;
}

/**
 * One worker-owned storage instance. Pi reads, migrates, merges, and updates
 * the two documents through its public SettingsManager surface; writes never
 * leave this object.
 */
class SnapshotSettingsStorage {
  private documents: Record<SettingsLoadScope, string | undefined>;

  constructor(globalSettings: unknown, projectSettings: unknown) {
    this.documents = {
      global: JSON.stringify(globalSettings),
      project: JSON.stringify(projectSettings),
    };
  }

  withLock(
    scope: SettingsLoadScope,
    fn: (current: string | undefined) => string | undefined,
  ): void {
    const next = fn(this.documents[scope]);
    if (next !== undefined) this.documents[scope] = next;
  }
}

/**
 * Immutable-at-extension-start public settings snapshot. Each call creates a
 * distinct no-file-I/O manager so AgentSession setters remain worker-local.
 */
export class WorkerSettingsSnapshot {
  private constructor(
    private readonly globalSettings: ReturnType<PiCodingAgent.SettingsManager["getGlobalSettings"]>,
    private readonly projectSettings: ReturnType<PiCodingAgent.SettingsManager["getProjectSettings"]>,
    private readonly projectTrusted: boolean,
    private readonly issues: readonly SettingsLoadIssue[],
  ) {}

  static capture(cwd: string, agentDir: string, projectTrusted: boolean): WorkerSettingsSnapshot {
    const source = PiCodingAgent.SettingsManager.create(cwd, agentDir, { projectTrusted });
    const issues = source.drainErrors().map(({ scope }) => ({ scope }));
    return new WorkerSettingsSnapshot(
      source.getGlobalSettings(),
      source.getProjectSettings(),
      projectTrusted,
      issues,
    );
  }

  get loadIssues(): SettingsLoadIssue[] {
    return this.issues.map((issue) => ({ ...issue }));
  }

  createManager(_effort: ThinkingLevel): PiCodingAgent.SettingsManager {
    const stripResourceSources = <T>(source: T): T => {
      const copy = structuredClone(source) as Record<string, unknown>;
      for (const key of ["packages", "extensions", "skills", "prompts", "themes"]) copy[key] = [];
      return copy as T;
    };
    // DefaultResourceLoader.reload always invokes PackageManager.resolve in Pi
    // 0.84.2. Remove every package/resource source from the immutable worker
    // storage before its first reload; no trusted-project write API is needed.
    const storage = new SnapshotSettingsStorage(
      stripResourceSources(this.globalSettings),
      stripResourceSources(this.projectSettings),
    );
    return PiCodingAgent.SettingsManager.fromStorage(storage, { projectTrusted: this.projectTrusted });
  }
}
