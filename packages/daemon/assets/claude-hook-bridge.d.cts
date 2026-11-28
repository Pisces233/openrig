// The declarations TypeScript callers use (the conversation key, recorded by the CLI and the MCP server; the plugin's `rig`
// lookup, which `rig doctor` checks a login shell with); the script itself is plain CommonJS so the openrig plugin can ship
// and run a copy of it.
export const CONVERSATION_KEY_TAG_PREFIX: string;
export function conversationKey(opts?: { pid?: number; env?: NodeJS.ProcessEnv; read?: (pid: number) => { pid: number; ppid: number; start: string; names: string[] } | null }): string | null;
export function conversationKeyTag(key: string): string;
export function findRig(opts?: { env?: NodeJS.ProcessEnv; projectDir?: string }): string | null;
export function loginShellPath(opts?: {
  env?: NodeJS.ProcessEnv;
  spawnSync?: (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number; stdio: unknown }) =>
    { error?: unknown; status: number | null; stdout?: string | null };
}): string | null;
