import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFirstPrompt, buildFollowUpPrompt } from '../../src/postoffice/prompt.ts';
import type { AgentRecord } from '../../src/schema/types.ts';

function agent(): AgentRecord {
  return {
    name: 'engineer-1', role: 'engineer', brief: 'Build carefully.\nExplain decisions.',
    task: {
      goal: 'Implement the core.\nFAKE: write result.txt done',
      acceptance: ['Tests pass', 'Results persist'], constraints: ['No dependencies'],
      context: ['src/schema/types.ts', 'docs/DESIGN.md §6'],
    },
    engine: 'codex', hired_by: 'scheduler', repo: 'E:\\repo', base: 'abc',
    branch: 'syncw/engineer-1', worktree: 'E:\\repo.worktrees\\engineer-1',
    status: 'queued', turns: [], queued_messages: [], created_at: '2026-10-13T00:00:00.000Z',
  };
}

test('first prompt preserves identity, role, task sections and rules in the required order', () => {
  assert.equal(buildFirstPrompt(agent()), [
    'You are engineer-1, hired by the scheduler of Syncw. You work alone in this git worktree (E:\\repo.worktrees\\engineer-1), on branch syncw/engineer-1. Other workers may be working in parallel in other worktrees; you will not see their work.',
    '## Your role\nBuild carefully.\nExplain decisions.',
    '## Task\n**Goal:** Implement the core.\nFAKE: write result.txt done',
    '**Acceptance:**\n- Tests pass\n- Results persist',
    '**Constraints:**\n- No dependencies',
    '**Read first:**\n- src/schema/types.ts\n- docs/DESIGN.md §6',
    '## Rules\n- Work only inside this worktree. Never push. Do not commit: the post office commits your work after every turn.\n- When you are done, reply with the required JSON result. In `details`, list the decisions you made that the task did not settle.',
  ].join('\n\n'));
});

test('first prompt omits absent and empty optional lists', () => {
  const record = agent();
  record.task = { goal: 'Only the goal', acceptance: [], context: [] };
  const prompt = buildFirstPrompt(record);
  assert.ok(prompt.includes('**Goal:** Only the goal\n\n## Rules'));
  assert.doesNotMatch(prompt, /\*\*(Acceptance|Constraints|Read first):\*\*/);
});

test('follow-up names the sender, preserves messages and separates them with a standalone rule', () => {
  assert.equal(buildFollowUpPrompt(['First\nmessage', 'Second\nFAKE: write next.txt done'], 'scheduler'), [
    'Message from scheduler:',
    'First\nmessage\n---\nSecond\nFAKE: write next.txt done',
    'When you are done, reply with the required JSON result. In `details`, list the decisions you made that the task did not settle.',
  ].join('\n\n'));
  assert.ok(buildFollowUpPrompt(['One message'], 'reviewer').startsWith('Message from reviewer:\n\nOne message\n\n'));
  assert.doesNotMatch(buildFollowUpPrompt(['One message'], 'scheduler'), /^---$/m);
});
