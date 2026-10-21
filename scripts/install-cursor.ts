import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Environment } from '../src/auth-protocol.js';
import { ROOT } from '../src/config.js';
import { DEFAULT_ENVIRONMENT, parseEnvironmentArguments } from '../src/environment.js';
import { checkPluginServer } from '../src/install-check.js';
import { TopMediaiError } from '../src/types.js';
import { cursorConfiguration } from './setup-cursor.js';

export function parseCursorArguments(args: string[]) {
  const environmentArgs: string[] = [];
  let project: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--project' || arg.startsWith('--project=')) {
      const value = arg === '--project' ? args[++index] : arg.slice('--project='.length);
      if (project !== undefined || !value?.trim() || value.startsWith('--')) {
        throw new TopMediaiError('INVALID_CONFIG', 'Use --project <directory> once, or omit it for a global Cursor installation.');
      }
      project = resolve(value);
    } else if (arg === '--env') {
      environmentArgs.push(arg, args[++index] ?? '');
    } else {
      environmentArgs.push(arg);
    }
  }
  const environment = parseEnvironmentArguments(environmentArgs);
  return { environment, cursorDirectory: resolve(project ?? homedir(), '.cursor') };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfiguration(original: string | null, config: ReturnType<typeof cursorConfiguration>) {
  let existing: unknown = {};
  try { if (original !== null) existing = JSON.parse(original.replace(/^\uFEFF/, '')); }
  catch {
    throw new TopMediaiError('INVALID_CURSOR_CONFIG', 'Cursor mcp.json must be valid JSON without comments or trailing commas. Repair it before installing; existing files were not changed.');
  }
  if (!isObject(existing) || (existing.mcpServers !== undefined && !isObject(existing.mcpServers))) {
    throw new TopMediaiError('INVALID_CURSOR_CONFIG', 'Cursor mcp.json and its mcpServers field must be JSON objects. Existing files were not changed.');
  }
  return JSON.stringify({ ...existing, mcpServers: { ...existing.mcpServers as Record<string, unknown> | undefined, ...config.mcpServers } }, null, 2) + '\n';
}

async function readExisting(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new TopMediaiError('CURSOR_INSTALL_FAILED', 'The Cursor configuration or skill is not a regular file. Resolve that path before installing.');
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export interface CursorInstallOptions {
  environment?: Environment;
  env?: NodeJS.ProcessEnv;
  /** Directory containing mcp.json and skills/, not the project or user home itself. */
  cursorDirectory?: string;
}

/** Install only TopMediai's server entry and skill; do not rewrite Codex's generated config. */
export async function installCursor(options: CursorInstallOptions = {}) {
  const environment = options.environment ?? DEFAULT_ENVIRONMENT;
  const config = cursorConfiguration(environment, options.env ?? process.env);
  const directory = resolve(options.cursorDirectory ?? resolve(homedir(), '.cursor'));
  const configPath = resolve(directory, 'mcp.json');
  const skillPath = resolve(directory, 'skills/topmediai-mcp/SKILL.md');
  const originalConfig = await readExisting(configPath);
  const originalSkill = await readExisting(skillPath);
  // Validate and load all inputs before changing any user files.
  const configText = mergeConfiguration(originalConfig, config);
  const skillText = await readFile(resolve(ROOT, 'plugin/skills/topmediai-mcp/SKILL.md'), 'utf8');
  const files = [
    { path: skillPath, text: skillText, original: originalSkill, backupName: 'SKILL.md' },
    { path: configPath, text: configText, original: originalConfig, backupName: 'mcp.json' },
  ].filter(file => file.text !== file.original);
  const backupDirectory = resolve(directory, 'backups/topmediai-mcp', randomUUID());
  const backups: string[] = [];
  for (const file of files) {
    if (await readExisting(file.path) !== file.original) {
      throw new TopMediaiError('CURSOR_CONFIG_CHANGED', 'Cursor configuration changed during installation. Run the installer again after saving your changes.');
    }
    await mkdir(dirname(file.path), { recursive: true });
    if (file.original !== null) {
      await mkdir(backupDirectory, { recursive: true });
      const backupPath = resolve(backupDirectory, file.backupName);
      await writeFile(backupPath, file.original, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      backups.push(backupPath);
    }
    await atomicWrite(file.path, file.text);
  }
  return { environment, configPath, skillPath, backups, changed: files.length > 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseCursorArguments(process.argv.slice(2));
    const launch = cursorConfiguration(options.environment).mcpServers.topmediai;
    const check = await checkPluginServer({ ...launch, env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...launch.env,
    } });
    const installed = await installCursor(options);
    console.log(`Installed TopMediAi-MCP for Cursor (${installed.environment}). No account token was copied into the configuration.`);
    console.log(`MCP configuration: ${installed.configPath}`);
    console.log(`Shared skill: ${installed.skillPath}`);
    for (const backup of installed.backups) console.log(`Previous file backup: ${backup}`);
    console.log(`Local MCP check: version=${check.server_version}, environment=${check.environment}, tools=${check.tool_count}, credential_configured=${check.token_configured}, credential_refresh=${check.credential_refresh_enabled}. This checks a separate process, not tools in the current Cursor chat or backend login validity.`);
    console.log('In Cursor, enable topmediai under MCP settings and call get_service_status in an Agent chat. If tools are missing, refresh/reconnect the server and try a new chat. A project .cursor/mcp.json entry with the same server name can override the global entry.');
    console.log('If login is needed, call start_login and keep waiting with wait_for_login; after saved, call get_service_status/get_balance and continue the original request. Login does not require restarting Cursor or MCP.');
    console.log('Use the shared TopMediai skill for model selection, quotes, confirmation preferences and media previews. If this Cursor version does not discover skills, attach the installed SKILL.md to the chat. Media links remain available when MCP Apps UI is unsupported.');
  } catch (error) {
    console.error(error instanceof TopMediaiError ? `${error.code}: ${error.message}` : 'CURSOR_INSTALL_FAILED: Cursor installation could not be completed. Check file permissions; retain any previous file backups.');
    process.exitCode = 1;
  }
}
