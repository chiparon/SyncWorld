import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import packageJson from '../../package.json' with { type: 'json' };
import { createServer } from '../../src/postoffice/server.ts';
import type {
  AgentSummary,
  PostOffice,
  SendMessageOutput,
  SpawnAgentInput,
  SpawnAgentOutput,
  WaitOutput,
} from '../../src/schema/types.ts';

const spawned: SpawnAgentOutput = {
  name: 'engineer-1',
  branch: 'syncw/engineer-1',
  worktree: join(process.cwd(), 'fixture.worktrees', 'engineer-1'),
  status: 'queued',
};
const delivered: SendMessageOutput = { delivery: 'queued' };
const waited: WaitOutput = {
  finished: [{
    agent: spawned.name,
    turn: 1,
    result: {
      status: 'done',
      summary: 'Implemented the task.\nReady for review.',
      details: 'Tests passed.',
      files_changed: ['src/example.ts'],
      open_questions: [],
    },
    facts: {
      turn: 1,
      started_at: '2026-10-13T00:00:00.000Z',
      finished_at: '2026-10-13T00:00:01.000Z',
      duration_ms: 1000,
      exit_code: 0,
      files_touched: ['src/example.ts'],
      timed_out: false,
      cancelled: false,
    },
  }],
  pending: ['engineer-2'],
};
const agents: AgentSummary[] = [{
  ...spawned,
  role: 'engineer',
  turns: 1,
  queued_messages: 2,
  last_summary: 'Implemented the task.',
}];

interface RecordedCall {
  method: keyof PostOffice;
  args: unknown[];
}

function stubPostOffice() {
  const calls: RecordedCall[] = [];
  const po: PostOffice = {
    async spawnAgent(input) {
      calls.push({ method: 'spawnAgent', args: [input] });
      return spawned;
    },
    async sendMessage(input) {
      calls.push({ method: 'sendMessage', args: [input] });
      return delivered;
    },
    async wait(input) {
      calls.push({ method: 'wait', args: [input] });
      return waited;
    },
    listAgents() {
      calls.push({ method: 'listAgents', args: [] });
      return agents;
    },
    async cancelAgent(name) {
      calls.push({ method: 'cancelAgent', args: [name] });
    },
    async closeAgent(name, opts) {
      calls.push({ method: 'closeAgent', args: [name, opts] });
    },
  };
  return { po, calls };
}

async function connect(t: TestContext, po: PostOffice, opts?: { instructions?: string }) {
  const server = createServer(po, opts);
  const client = new Client({ name: 'test-scheduler', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('advertises exactly the six tools with contract field types and required fields', async (t) => {
  const { po } = stubPostOffice();
  const client = await connect(t, po);
  const { tools } = await client.listTools();
  const string = { type: 'string' };
  const strings = { type: 'array', items: string };
  const expected = {
    spawn_agent: {
      required: ['task'],
      properties: {
        task: {
          type: 'object',
          properties: { goal: string, acceptance: strings, constraints: strings, context: strings },
          required: ['goal'],
        },
        role: string,
        brief: string,
        repo: string,
        base: string,
      },
    },
    send_message: { required: ['to', 'text'], properties: { to: string, text: string } },
    wait: { required: [], properties: { agents: strings, timeout_s: { type: 'number' } } },
    list_agents: { required: [], properties: {} },
    cancel_agent: { required: ['name'], properties: { name: string } },
    close_agent: {
      required: ['name'],
      properties: { name: string, delete_branch: { type: 'boolean' } },
    },
  };

  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(expected).sort());
  for (const [name, schema] of Object.entries(expected)) {
    const tool = tools.find((item) => item.name === name)!;
    assert.equal(tool.inputSchema.type, 'object', name);
    assert.deepEqual(tool.inputSchema.required ?? [], schema.required, name);
    assert.deepEqual(tool.inputSchema.properties, schema.properties, name);
    assert.ok(tool.description, name);
    assert.ok(tool.description.split(/\s+/).length < 60, name);
  }
});

const spawnInput: SpawnAgentInput = {
  task: {
    goal: 'Implement a feature',
    acceptance: ['All tests pass'],
    constraints: ['Only change the assigned files'],
    context: ['docs/DESIGN.md §5'],
  },
  role: 'engineer',
  brief: 'Focus on correctness.',
  repo: join(process.cwd(), 'fixture repo'),
  base: 'feature/start',
};

const cases = [
  { name: 'spawn_agent', input: { ...spawnInput }, method: 'spawnAgent', args: [spawnInput], output: spawned },
  {
    name: 'send_message', input: { to: spawned.name, text: 'Please revise the result.' },
    method: 'sendMessage', args: [{ to: spawned.name, text: 'Please revise the result.' }], output: delivered,
  },
  {
    name: 'wait', input: { agents: [spawned.name], timeout_s: 0.5 },
    method: 'wait', args: [{ agents: [spawned.name], timeout_s: 0.5 }], output: waited,
  },
  { name: 'list_agents', input: {}, method: 'listAgents', args: [], output: agents },
  { name: 'cancel_agent', input: { name: spawned.name }, method: 'cancelAgent', args: [spawned.name], output: { ok: true } },
  {
    name: 'close_agent', input: { name: spawned.name, delete_branch: true },
    method: 'closeAgent', args: [spawned.name, { delete_branch: true }], output: { ok: true },
  },
] satisfies {
  name: string;
  input: Record<string, unknown>;
  method: keyof PostOffice;
  args: unknown[];
  output: unknown;
}[];

for (const item of cases) {
  test(`${item.name} forwards exactly one call and returns one compact JSON text item`, async (t) => {
    const { po, calls } = stubPostOffice();
    const client = await connect(t, po);
    const result = await client.callTool({ name: item.name, arguments: item.input });
    assert.deepEqual(result, { content: [{ type: 'text', text: JSON.stringify(item.output) }] });
    assert.deepEqual(calls, [{ method: item.method, args: item.args }]);
  });

  test(`${item.name} returns post office errors without breaking the connection`, async (t) => {
    const { po } = stubPostOffice();
    const message = `${item.method} failed: retry after fixing the agent.`;
    // listAgents throws synchronously; the remaining methods reject asynchronously.
    if (item.method === 'listAgents') {
      po.listAgents = () => { throw new Error(message); };
    } else {
      po[item.method] = async () => { throw new Error(message); };
    }
    const client = await connect(t, po);
    assert.deepEqual(await client.callTool({ name: item.name, arguments: item.input }), {
      isError: true,
      content: [{ type: 'text', text: message }],
    });
    assert.equal((await client.listTools()).tools.length, 6);
  });
}

test('optional fields remain omitted and explicit zero and false survive forwarding', async (t) => {
  const { po, calls } = stubPostOffice();
  const client = await connect(t, po);
  const roleOnly = { task: { goal: 'Use a role template' }, role: 'engineer' };
  const briefOnly = { task: { goal: 'Use a custom role' }, brief: 'Careful engineer' };
  await client.callTool({ name: 'spawn_agent', arguments: roleOnly });
  await client.callTool({ name: 'spawn_agent', arguments: briefOnly });
  await client.callTool({ name: 'wait' });
  await client.callTool({ name: 'wait', arguments: { agents: [], timeout_s: 0 } });
  await client.callTool({ name: 'list_agents' });
  await client.callTool({ name: 'close_agent', arguments: { name: spawned.name } });
  await client.callTool({ name: 'close_agent', arguments: { name: spawned.name, delete_branch: false } });
  assert.deepEqual(calls, [
    { method: 'spawnAgent', args: [roleOnly] },
    { method: 'spawnAgent', args: [briefOnly] },
    { method: 'wait', args: [{}] },
    { method: 'wait', args: [{ agents: [], timeout_s: 0 }] },
    { method: 'listAgents', args: [] },
    { method: 'closeAgent', args: [spawned.name, { delete_branch: undefined }] },
    { method: 'closeAgent', args: [spawned.name, { delete_branch: false }] },
  ]);
});

test('invalid field types and missing required fields never reach the post office', async (t) => {
  const { po, calls } = stubPostOffice();
  const client = await connect(t, po);
  const invalid = [
    { name: 'spawn_agent', arguments: { role: 'engineer' } },
    { name: 'spawn_agent', arguments: { role: 'engineer', task: 'Do the task' } },
    { name: 'spawn_agent', arguments: { role: 'engineer', task: {} } },
    ...['acceptance', 'constraints', 'context'].map((field) => ({
      name: 'spawn_agent', arguments: { role: 'engineer', task: { goal: 'Test', [field]: [1] } },
    })),
    { name: 'send_message', arguments: { text: 'Missing recipient' } },
    { name: 'send_message', arguments: { to: spawned.name } },
    { name: 'wait', arguments: { agents: spawned.name } },
    { name: 'wait', arguments: { timeout_s: '600' } },
    { name: 'cancel_agent', arguments: {} },
    { name: 'close_agent', arguments: {} },
    { name: 'close_agent', arguments: { name: spawned.name, delete_branch: 'true' } },
  ];
  for (const input of invalid) {
    assert.equal((await client.callTool(input)).isError, true, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('non-Error throws are returned as text tool errors', async (t) => {
  const { po } = stubPostOffice();
  po.listAgents = () => { throw 'Registry unavailable'; };
  const client = await connect(t, po);
  assert.deepEqual(await client.callTool({ name: 'list_agents' }), {
    isError: true,
    content: [{ type: 'text', text: 'Registry unavailable' }],
  });
});

test('initialization exposes the package version and scheduler instructions', async (t) => {
  for (const instructions of [undefined, '', 'Use isolated worktrees.\nReview results before merging.']) {
    const { po } = stubPostOffice();
    const client = await connect(t, po, instructions === undefined ? undefined : { instructions });
    assert.deepEqual(client.getServerVersion(), { name: 'syncw', version: packageJson.version });
    // The SDK omits empty instructions from its initialization response.
    assert.equal(client.getInstructions(), instructions || undefined);
  }
});
