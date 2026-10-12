import assert from 'node:assert/strict';
import test from 'node:test';
import { aiConfigSchema, resolveMemoryRecallBudget } from '../dist/index.js';

test('recall budget inherits the account default unless the chat overrides it', () => {
  assert.equal(resolveMemoryRecallBudget(undefined, undefined), 1000);
  assert.equal(resolveMemoryRecallBudget(undefined, 4096), 4096);
  assert.equal(resolveMemoryRecallBudget(2000, 4096), 2000);
  assert.equal(resolveMemoryRecallBudget(null, 4096), 4096);
  for (const invalid of [0, -1, 100001, 1.5, '4096', Infinity]) assert.equal(resolveMemoryRecallBudget(invalid, 4096), 4096);
  assert.equal(resolveMemoryRecallBudget(undefined, -1), 1000);
});
test('account context settings accept a partial update or default reset and reject invalid budgets', () => {
  assert.equal(aiConfigSchema.safeParse({ maxContext: 123456, memoryBudgetTokens: 4096 }).success, true);
  assert.equal(aiConfigSchema.safeParse({ memoryBudgetTokens: null }).success, true);
  for (const memoryBudgetTokens of [0, -1, 100001, 1.5, '4096']) assert.equal(aiConfigSchema.safeParse({ memoryBudgetTokens }).success, false);
});
