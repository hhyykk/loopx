import assert from 'node:assert/strict';
import test from 'node:test';
import {projectGoalSourceLinks} from '../../loopx/control_plane/presentation/goal_source_links.ts';

const link = () => ({goal_id: 'original-solver', parent_goal_id: 'research-parent',
  label: 'Original experiment', namespace: 'a'.repeat(64)});

test('an existing source Goal keeps its native id under the local parent', () => {
  const result = projectGoalSourceLinks({local_goal_ids: ['research-parent'], links: [link()]});
  assert.deepEqual(result.goals, [{id: 'original-solver', parent_goal_id: 'research-parent',
    display_name: 'Original experiment', registry_member: true, activation_state: 'active',
    source_access: {label: 'Original experiment', namespace: 'a'.repeat(64), read_only: true}}]);
});

test('ambiguous original ids and invalid namespaces are refused', () => {
  for (const input of [
    {local_goal_ids: ['research-parent'], links: [link(), {...link(), namespace: 'b'.repeat(64)}]},
    {local_goal_ids: ['research-parent'], links: [{...link(), namespace: 'unverified'}]},
  ]) assert.throws(() => projectGoalSourceLinks(input));
});

test('source namespaces retain the existing bare lowercase digest format', () => {
  for (const namespace of ['0'.repeat(64), '0123456789abcdef'.repeat(4)]) {
    const result = projectGoalSourceLinks({local_goal_ids: ['research-parent'], links: [{...link(), namespace}]});
    assert.equal((result.goals as {source_access: {namespace: string}}[])[0].source_access.namespace, namespace);
  }
  for (const namespace of ['A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65),
    'sha256:' + 'a'.repeat(64)]) {
    assert.throws(() => projectGoalSourceLinks({local_goal_ids: ['research-parent'], links: [{...link(), namespace}]}));
  }
});

test('a removed parent hides only its retained reference', () => {
  const other = {...link(), goal_id: 'other-solver', parent_goal_id: 'other-parent', namespace: 'b'.repeat(64)};
  assert.deepEqual(projectGoalSourceLinks({local_goal_ids: ['other-parent'], links: [link(), other]}).goals,
    projectGoalSourceLinks({local_goal_ids: ['other-parent'], links: [other]}).goals);
});

test('a native local Goal takes precedence over a retained source reference', () => {
  assert.deepEqual(projectGoalSourceLinks({local_goal_ids: ['research-parent', 'original-solver'],
    links: [link()]}), {goals: []});
});

test('the empty catalog preserves the local-only directory', () => {
  assert.deepEqual(projectGoalSourceLinks({local_goal_ids: ['research-parent'], links: []}), {goals: []});
});
