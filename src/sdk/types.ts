// upstream: Continuo@11c5eb49d656d5c16d2a8e77e1639f4fdd7b00d6
// src: /Users/RiGang/Desktop/Continuo/src/plugins/types.ts
// upstream-additions: Continuo@fb18eb1 (editor namespace)
// upstream-additions: Continuo@7d3d670 (topic-31 dock + notifications)
// 严格类型；严禁 `: any`（topic-05 lesson）

import type { ReactNode } from 'react';

export interface Disposable {
  dispose(): void;
}

export interface PluginManifest {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly main?: string;
  readonly description?: string;
  readonly author?: string;
  readonly authorUrl?: string;
  readonly minLMVersion?: string;
  readonly isDesktopOnly?: boolean;
  readonly permissions?: readonly string[];
}

export interface PanelVisibilityEvent {
  readonly isVisible: boolean;
}

export interface PanelApi {
  readonly id: string;
  readonly isVisible: boolean;
  onDidVisibilityChange(cb: (event: PanelVisibilityEvent) => void): Disposable;
}

export interface PanelFactoryProps {
  readonly api: PanelApi;
}

export interface PanelSpec {
  readonly type: string;
  readonly factory: (props: PanelFactoryProps) => ReactNode;
  readonly title: string;
  readonly titleKey?: string;
}

export interface CommandSpec {
  readonly id: string;
  readonly title: string;
  readonly titleKey?: string;
  readonly hotkey?: string;
  readonly category?: string;
  readonly categoryKey?: string;
  readonly fn: () => void | Promise<void>;
}

export interface RibbonActionSpec {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly onClick: () => void | Promise<void>;
  readonly priority?: number;
}

export interface SettingTabSpec {
  readonly id: string;
  readonly title: string;
  readonly render: () => ReactNode;
  readonly titleKey?: string;
  readonly icon?: ReactNode;
  readonly priority?: number;
}

export interface CoWorkspaceApi {
  getRoot(): Promise<string | null>;
}

export interface EditorOpenOptions {
  readonly line?: number;
}

export type EditorOpenSuccessReason =
  | 'no-line-arg'
  | 'milkdown-engine'
  | 'line-out-of-range'
  | 'tab-not-mounted';

export type EditorOpenFailureCode =
  | 'INVALID_PATH'
  | 'PERMISSION_DENIED'
  | 'FS_NOT_FOUND'
  | 'FS_NOT_FILE'
  | 'FS_DENIED'
  | 'FS_IO'
  | 'EXCEPTION';

export type EditorOpenResult =
  | {
      readonly ok: true;
      readonly lineApplied: boolean;
      readonly reason?: EditorOpenSuccessReason;
    }
  | {
      readonly ok: false;
      readonly code: EditorOpenFailureCode;
      readonly message: string;
    };

export interface CoEditorApi {
  openFile(
    path: string,
    opts?: EditorOpenOptions,
  ): Promise<EditorOpenResult>;
}

export interface CoDockApi {
  openPanel(panelId: string): void;
}

// Mirror upstream NotificationLevel; drift-guarded by sdk-shim tests.
export type NotificationKind = 'info' | 'warning' | 'error' | 'success';

export interface CoNotificationsShowOpts {
  readonly kind: NotificationKind;
  readonly message: string;
  readonly code?: string;
}

export interface CoNotificationsApi {
  show(opts: CoNotificationsShowOpts): void;
}

export interface PluginDataStore {
  read(pluginId: string): Promise<unknown | null>;
  write(pluginId: string, data: unknown): Promise<void>;
}

export interface PluginShellExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly input?: string;
  readonly maxOutputBytes?: number;
}

export interface PluginShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface PluginShellApi {
  exec(
    cmd: string,
    args: readonly string[],
    opts?: PluginShellExecOptions,
  ): Promise<PluginShellExecResult>;
  execStream(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ): {
    chunks: AsyncIterable<{
      stream: 'stdout' | 'stderr';
      chunk: Uint8Array;
    }>;
    done: Promise<{ exitCode: number; signal: string | null }>;
  };
}

export interface PathScope {
  readonly path: string;
  readonly mode: 'r' | 'rw';
}

export interface FileEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

export interface FsStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

export interface PluginFsApi {
  userHome(): Promise<string>;
  requestScope(scopes: PathScope[]): Promise<'grant' | 'deny'>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<readonly FileEntry[]>;
  stat(path: string): Promise<FsStat>;
  lstat(path: string): Promise<FsStat>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cp(src: string, dst: string, opts?: { recursive?: boolean }): Promise<void>;
  readGitBlob(repoDir: string, sha: string): Promise<Uint8Array>;
  atomicReplaceWithinScope(
    staging: string,
    final: string,
    opts?: { overwrite?: boolean },
  ): Promise<void>;
}

export interface PluginNetworkApi {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface PluginClipboardApi {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface PluginPermissionApi {
  check(perm: string): Promise<boolean>;
  granted(): Promise<readonly string[]>;
}

export interface CoApp {
  readonly version: string;
  readonly panels: {
    register(spec: PanelSpec): Disposable;
  };
  readonly commands: {
    register(spec: CommandSpec): Disposable;
    getAll(): readonly CommandSpec[];
    execute(id: string): Promise<void>;
    subscribe(listener: () => void): () => void;
  };
  readonly ribbon: {
    register(spec: RibbonActionSpec): Disposable;
  };
  dataStore: PluginDataStore;
  readonly settingTabs: {
    register(spec: SettingTabSpec): Disposable;
  };
  readonly workspace: CoWorkspaceApi;
  readonly editor: CoEditorApi;
  /** Optional for defensive feature detection; manifest minLMVersion requires 0.2.4. */
  readonly dock?: CoDockApi;
  /** Optional for defensive feature detection; manifest minLMVersion requires 0.2.4. */
  readonly notifications?: CoNotificationsApi;
}

export interface CoPluginApp extends CoApp {
  readonly fs: PluginFsApi;
  readonly network: PluginNetworkApi;
  readonly shell: PluginShellApi;
  readonly clipboard: PluginClipboardApi;
  readonly permission: PluginPermissionApi;
}

declare class PluginBase {
  readonly app: CoPluginApp;
  readonly manifest: PluginManifest;
  constructor(app: CoPluginApp, manifest: PluginManifest);
  onload(): void | Promise<void>;
  onunload?(): void | Promise<void>;
}

export interface CoReactRuntime {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): ReactNode;
}

export interface CoSdkGlobal {
  Plugin: typeof PluginBase;
  React: CoReactRuntime;
  PermissionError: new (permission: string, message?: string) => Error;
  z: unknown;
}

declare global {
  var co: CoSdkGlobal | undefined;
}

export const co: CoSdkGlobal = new Proxy({} as CoSdkGlobal, {
  get(_target, prop: string | symbol): unknown {
    const real = globalThis.co;
    if (!real) {
      throw new Error(
        `sdk-shim: globalThis.co not initialized when accessing co.${String(prop)}`,
      );
    }
    return real[prop as keyof CoSdkGlobal];
  },
}) as CoSdkGlobal;
