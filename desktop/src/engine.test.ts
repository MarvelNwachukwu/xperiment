import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildRegistry } from "./engine";

test("registry tracks add/remove/size and killAll calls kill on each", async () => {
  const reg = new ChildRegistry<{ id: number }>();
  const a = { id: 1 }, b = { id: 2 };
  reg.add(a); reg.add(b);
  assert.equal(reg.size(), 2);
  reg.remove(a);
  assert.equal(reg.size(), 1);
  const killed: number[] = [];
  await reg.killAll(async (c) => { killed.push(c.id); });
  assert.deepEqual(killed, [2]);
  assert.equal(reg.size(), 0);
});
