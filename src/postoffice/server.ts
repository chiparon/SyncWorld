import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import packageJson from '../../package.json' with { type: 'json' };
import type { PostOffice } from '../schema/types.ts';

/** Keep post office failures inside the tool response so the scheduler can recover. */
async function toolResult(call: () => unknown): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await call()) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export function createServer(po: PostOffice, opts?: { instructions?: string }): McpServer {
  const server = new McpServer(
    { name: 'syncw', version: packageJson.version },
    { instructions: opts?.instructions },
  );

  // Validate wire types here; the post office owns defaults and role/brief validation.
  server.registerTool('spawn_agent', {
    description: 'Hire a Codex worker in its own branch and worktree for a new task. Supply at least '
      + 'one of role or brief. Returns immediately with the agent name and status; use wait for results.',
    inputSchema: {
      task: z.object({
        goal: z.string(),
        acceptance: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        context: z.array(z.string()).optional(),
      }),
      role: z.string().optional(),
      brief: z.string().optional(),
      repo: z.string().optional(),
      base: z.string().optional(),
    },
  }, (input) => toolResult(() => po.spawnAgent(input)));

  server.registerTool('send_message', {
    description: 'Send follow-up instructions to an existing agent, resuming its session when idle. '
      + 'Use this to request revisions or provide context. Messages to a running agent are queued '
      + 'for its next turn.',
    inputSchema: { to: z.string(), text: z.string() },
  }, (input) => toolResult(() => po.sendMessage(input)));

  server.registerTool('wait', {
    description: 'Collect finished turns and see which agents are still pending. Each completed turn '
      + 'is reported only once. Omit agents to include everyone; timeout_s defaults to 600, '
      + 'and 0 checks without waiting.',
    inputSchema: {
      agents: z.array(z.string()).optional(),
      timeout_s: z.number().optional(),
    },
  }, (input) => toolResult(() => po.wait(input)));

  server.registerTool('list_agents', {
    description: 'Inspect the team before assigning or following up on work: names, roles, statuses, '
      + 'branches, timing, and latest summaries. These are status snapshots; use wait to collect '
      + 'completed turn results.',
    inputSchema: {},
  }, () => toolResult(() => po.listAgents()));

  server.registerTool('cancel_agent', {
    description: 'Stop a queued or running agent when its current work should end. Its worktree and '
      + 'session remain available, and send_message can resume it. Use close_agent to remove the worktree.',
    inputSchema: { name: z.string() },
  }, ({ name }) => toolResult(async () => {
    await po.cancelAgent(name);
    return { ok: true };
  }));

  server.registerTool('close_agent', {
    description: 'Remove an agent worktree after merging its work or deciding to abandon it. '
      + 'Set delete_branch to also delete its branch. Closing is final; the agent cannot be resumed.',
    inputSchema: { name: z.string(), delete_branch: z.boolean().optional() },
  }, ({ name, delete_branch }) => toolResult(async () => {
    await po.closeAgent(name, { delete_branch });
    return { ok: true };
  }));

  return server;
}
