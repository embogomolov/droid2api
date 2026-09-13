import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';

// Process-local profile: no edits to the user's ordinary Claude credentials/settings.
const root = fileURLToPath(new URL('.', import.meta.url));
const local = parse(readFileSync(join(root, '.env')));
const config = JSON.parse(readFileSync(join(root, 'data', 'config.json')));
const key = local.API_ACCESS_KEY || process.env.API_ACCESS_KEY;
if (!key) throw new Error('Set API_ACCESS_KEY in droid2api/.env first.');
const env = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith('CLAUDE_CODE_USE_') || name === 'ANTHROPIC_CUSTOM_HEADERS') delete env[name];
Object.assign(env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${Number(local.PORT || config.port || 3000)}`,
  ANTHROPIC_AUTH_TOKEN: key,
  ANTHROPIC_API_KEY: key,
  ANTHROPIC_MODEL: 'claude-fable-5.1',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
});
const args = process.argv.slice(2);
if (args[0] === '--check') {
  console.log(JSON.stringify({ baseURL: env.ANTHROPIC_BASE_URL, model: env.ANTHROPIC_MODEL,
    credential: 'loaded from local configuration (not displayed)', config: 'process-local',
    models: ['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL'].map(k => {
      if (!config.models.some(m => m.id === env[k] && m.type === 'anthropic' && m.reasoning === 'auto')) throw new Error(`Model must be configured with anthropic/auto: ${env[k]}`);
      return env[k];
    }) }, null, 2));
} else {
  let cwd = process.cwd();
  if (args[0] && existsSync(args[0]) && statSync(args[0]).isDirectory()) cwd = args.shift();
  const executable = join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe');
  const child = spawn(existsSync(executable) ? executable : 'claude', args, { cwd, env, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
