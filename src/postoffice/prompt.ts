import type { AgentRecord } from '../schema/types.ts';

const resultReminder = 'When you are done, reply with the required JSON result. In `details`, list the decisions you made that the task did not settle.';

export function buildFirstPrompt(agent: AgentRecord): string {
  const parts = [
    `You are ${agent.name}, hired by the ${agent.hired_by} of Syncw. You work alone in this git worktree (${agent.worktree}), on branch ${agent.branch}. Other workers may be working in parallel in other worktrees; you will not see their work.`,
    `## Your role\n${agent.brief}`,
    `## Task\n**Goal:** ${agent.task.goal}`,
  ];
  for (const [label, items] of [
    ['Acceptance', agent.task.acceptance],
    ['Constraints', agent.task.constraints],
    ['Read first', agent.task.context],
  ] as const) {
    if (items?.length) parts.push(`**${label}:**\n${items.map((item) => `- ${item}`).join('\n')}`);
  }
  parts.push(`## Rules\n- Work only inside this worktree. Never push. Do not commit: the post office commits your work after every turn.\n- ${resultReminder}`);
  return parts.join('\n\n');
}

export function buildFollowUpPrompt(messages: string[], from: string): string {
  return [`Message from ${from}:`, messages.join('\n---\n'), resultReminder].join('\n\n');
}
