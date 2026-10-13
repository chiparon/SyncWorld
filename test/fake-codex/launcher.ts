/** Two launcher layers let tests detect whether cancellation strands grandchildren. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const depth = Number(process.env.FAKE_CODEX_LAUNCH_DEPTH ?? '0');
const script = fileURLToPath(new URL(depth === 0 ? './launcher.ts' : './codex.ts', import.meta.url));
const child = spawn(process.execPath, [script, ...process.argv.slice(2)], {
  env: { ...process.env, FAKE_CODEX_LAUNCH_DEPTH: String(depth + 1) },
  windowsHide: true,
  shell: false,
  stdio: 'inherit',
});
process.stderr.write(`${JSON.stringify({ launcher_pid: process.pid, child_pid: child.pid })}\n`);
child.on('error', (error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
