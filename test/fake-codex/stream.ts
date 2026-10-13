/** Deliberately fragmented JSONL exercises byte preservation and tolerant event parsing. */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

process.stdin.resume();
await new Promise<void>((resolve) => { process.stdin.on('end', resolve); });
const output = process.argv[process.argv.indexOf('-o') + 1]!;
const inside = path.join(process.cwd(), 'nested', '你好.txt');
const outside = path.join(`${process.cwd()}-sibling`, 'external.txt');
const result = {
  status: 'done', summary: '', details: '', files_changed: [], open_questions: [], extra: 'allowed',
};
await writeFile(output, JSON.stringify(result));
const lines = [
  'not JSON',
  'null',
  '[]',
  JSON.stringify({ type: 'thread.started', thread_id: 'stream-session' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [
    { path: inside, kind: 'add' }, { path: inside, kind: 'update' }, { path: outside, kind: 'delete' }, null,
  ] } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 1, extra: 9 } }),
  JSON.stringify({ type: 'error', message: 'old error' }),
  JSON.stringify({ type: 'turn.failed', error: { message: 'middle error' } }),
  JSON.stringify({ type: 'error', message: 'last error' }),
];
const bytes = Buffer.from(lines.join('\r\n'));
await writeFile(path.join(process.cwd(), 'expected-stdout.bin'), bytes);
// Split within a multi-byte character, and leave the final event without a newline.
const split = bytes.indexOf(Buffer.from('你')) + 1;
process.stdout.write(bytes.subarray(0, split));
await sleep(20);
process.stdout.write(bytes.subarray(split));
process.stderr.write('raw stderr 你好\r\nlast line');
