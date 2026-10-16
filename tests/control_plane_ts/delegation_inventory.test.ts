import test from "node:test";
import assert from "node:assert/strict";
import {delegationInventoryPage} from "../../loopx/control_plane/collaboration/delegation.ts";
import type {JsonObject} from "../../loopx/control_plane/effect_program.ts";

function inventoryPageFixture() {
  const record_ids = ["a", "b", "c"].map(key => key.repeat(64));
  const observations = record_ids.slice(0, 2).map((record_id, index) => ({
    record: {record_id, operation_id: `review-${index}`},
    observation: {operation_id: `review-${index}`, request_id: `request-${index}`,
      agent_id: "reviewer", todo_id: "todo_review", status: "prepared",
      worker_active: false, recovery_required: true},
  }));
  return {query: {limit: 2, cursor: null}, record_ids, observations};
}

test("inventory page uses an unread lookahead without skipping or inventing results", () => {
  const request = inventoryPageFixture();
  for (const [count, more] of [[0, false], [1, false], [2, false], [3, true]] as const) {
    const page = delegationInventoryPage({...request, record_ids: request.record_ids.slice(0, count),
      observations: request.observations.slice(0, Math.min(count, 2))});
    assert.deepEqual((page.items as JsonObject[]).map(row => row.record_id), request.record_ids.slice(0, Math.min(count, 2)));
    assert.equal(page.has_more, more);
    assert.equal(page.next_cursor, more ? request.record_ids[1] : null);
    assert.equal(page.page_readback_complete, true);
  }
});

test("malformed observations stay unavailable without hiding a healthy sibling or the next page", () => {
  const request = inventoryPageFixture();
  const invalid: (JsonObject | null)[] = [null,
    {...request.observations[0]!.observation, operation_id: "other"},
    {...request.observations[0]!.observation, status: "not-an-observation"},
    {...request.observations[0]!.observation, worker_active: null},
    {...request.observations[0]!.observation, status: "accepted", artifacts: []},
  ];
  for (const observation of invalid) {
    const page = delegationInventoryPage({...request, observations: [
      {...request.observations[0]!, observation}, request.observations[1]!,
    ]});
    const rows = page.items as JsonObject[];
    assert.equal(rows[0]!.status, "unavailable");
    assert.equal(rows[0]!.operation_id, "review-0");
    assert.equal(rows[0]!.recovery_required, null);
    assert.equal(rows[0]!.artifacts, undefined);
    assert.equal(rows[1]!.status, "prepared");
    assert.equal(page.page_readback_complete, false);
    assert.equal(page.has_more, true);
    assert.equal(page.next_cursor, request.record_ids[1]);
  }
});

test("inventory page refuses incomplete, reordered or out-of-cursor framing", () => {
  const request = inventoryPageFixture();
  for (const patch of [
    {record_ids: ["invalid"]},
    {record_ids: [request.record_ids[0]!, request.record_ids[0]!] },
    {record_ids: [...request.record_ids].reverse()},
    {record_ids: [...request.record_ids, "d".repeat(64)]},
    {query: {limit: 2, cursor: request.record_ids[0]!}},
    {observations: request.observations.slice(0, 1)},
    {observations: [...request.observations].reverse()},
    {observations: [{...request.observations[0]!,
      record: {...request.observations[0]!.record, operation_id: "../other"}}, request.observations[1]!] },
  ]) assert.throws(() => delegationInventoryPage({...request, ...patch}));
});
