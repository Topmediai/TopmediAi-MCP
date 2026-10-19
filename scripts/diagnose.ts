import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.js';
import type { Environment } from '../src/auth-protocol.js';
import { parsePluginEnvironment, pluginConfiguration } from './setup-plugin.js';
import { TASK_POLL_INTERVAL_SECONDS } from '../src/task-polling.js';
import { sanitizeDiagnostic } from '../src/redaction.js';
import { saveDiagnosticReports } from '../src/diagnostics.js';

const args = process.argv.slice(2);
function option(name: string) { return args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3); }
const generate = args.includes('--generate');
const resumeId = option('request-id');
const budget = Number(option('max-credits'));
const client = new Client({ name: 'topmediai-mcp-diagnostics', version: '1.0.0' });
function selectedEnvironment(): Environment {
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') { flags.push('--env', args[++i] ?? ''); }
    else if (args[i]?.startsWith('--env=')) flags.push(args[i]!);
  }
  return parsePluginEnvironment(flags);
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text;
    let code = 'TOOL_ERROR';
    try { code = JSON.parse(text ?? '{}').error?.code ?? code; } catch { /* Do not echo raw responses. */ }
    throw new Error(`${name}: ${code}`);
  }
  return result.structuredContent as Record<string, any>;
}
async function poll(request_id: string) {
  let task = await call('get_image_task', { request_id });
  const deadline = Date.now() + 5 * 60_000;
  while (['queued', 'running'].includes(task.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, (task.poll_after_seconds ?? TASK_POLL_INTERVAL_SECONDS) * 1000));
    task = await call('get_image_task', { request_id });
    console.log(JSON.stringify(sanitizeDiagnostic({ status: task.status })));
  }
  return task;
}
try {
  const environment = selectedEnvironment();
  // Freeze selected public origins and capability settings without copying credentials or reading .env here.
  const configEnv = pluginConfiguration(environment).mcpServers.topmediai.env;
  if (generate && (!Number.isFinite(budget) || budget < 0 || budget > 10000)) throw new Error('Provide --max-credits=<authorized estimated budget> with --generate.');
  if (generate && resumeId) throw new Error('Use --request-id to query an existing task without --generate.');
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(ROOT, 'dist/src/index.js')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...configEnv },
  });
  await client.connect(transport);
  const report: Record<string, any> = { status: await call('get_service_status'), tools: (await client.listTools()).tools.map(tool => tool.name) };
  if (report.status.environment !== environment) throw new Error('The MCP environment does not match the selected diagnostic environment.');
  if (resumeId) report.task = await poll(resumeId);
  else {
    report.models = await call('list_image_models');
    if (report.status.token_configured) report.balance = await call('get_balance');
    else report.account_setup = `Run npm run login, confirm the account on the official website, then query service status and balance again. The standard MCP reloads saved credentials without restarting.`;
    if (generate) {
      if (!report.status.token_configured) throw new Error(`Sign in locally with --env ${environment} before generating.`);
      const rows: Record<string, any>[] = report.models.models.flatMap((model: any) => model.pricing ?? []);
      const model = rows.find(row => row.model_type === report.models.default_model_type);
      if (!model) throw new Error('The configured default image model has no usable price row. Select an available model explicitly; do not guess a default.');
      report.quote = await call('estimate_image_cost', {
        description: option('prompt') ?? 'A moonlit valley at night in soft blue and purple tones',
        model_type: model.model_type, quality: model.quality, image_quality: model.image_quality,
        number: 1, aspect_ratio: 1,
      });
      const request_id = 'diagnostic-' + randomUUID();
      console.log(JSON.stringify({ status: 'submitting', environment }));
      report.submitted = await call('generate_image', { quote_id: report.quote.quote_id, request_id, max_credits: budget });
      report.task = await poll(request_id);
      report.balance_after = await call('get_balance');
    }
  }
  const summary = await saveDiagnosticReports(report, resolve(ROOT, '.data/diagnostic-runs'), environment, args.includes('--share-report'));
  console.log(JSON.stringify(summary, null, 2));
} catch {
  process.stderr.write('DIAGNOSE_FAILED: Check the input, environment and local login status. No paid request is automatically retried.\n');
  process.exitCode = 1;
} finally { await client.close(); }
