import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { makeState } from "./model-fixtures.ts";
import { runtimeFixture } from "./runtime-test-kit.ts";

const options = { timeout: 5000 };
const twoCollections = 2;
const threeCollections = 3;

test(
  "stop during configuration prevents watchers, collection and publication",
  options,
  async (context) => {
    let reads = 0;
    const { runtime, host, configPath } = await runtimeFixture(context, () => {
      reads += 1;
      return Promise.resolve(makeState());
    });
    const start = runtime.start(host.context, configPath);
    runtime.stop();
    await start;
    assert.equal(runtime.active, false);
    assert.equal(reads, 0);

    assert.deepEqual(host.events, []);
  },
);
test(
  "stop during collection rejects stale publication",
  options,
  async (context) => {
    const gate = new EventEmitter();
    const entered = once(gate, "entered", { signal: context.signal });
    const late = makeState({ installed: "late-fixture-version" });
    const { runtime, host, configPath } = await runtimeFixture(
      context,
      async () => {
        gate.emit("entered");
        await once(gate, "release", { signal: context.signal });
        return late;
      },
    );
    const start = runtime.start(host.context, configPath);
    await entered;
    runtime.stop();
    gate.emit("release");
    await start;
    assert.equal(runtime.active, false);
    assert.notEqual(runtime.state, late);
    assert.equal(runtime.state.installed, "unknown");

    assert.deepEqual(host.events, []);
  },
);
test(
  "concurrent refresh requests await the same collection",
  options,
  async (context) => {
    const gate = new EventEmitter();
    let reads = 0;
    const state = makeState({ installed: "fixture-version" });
    const { runtime, host, configPath } = await runtimeFixture(
      context,
      async () => {
        reads += 1;
        if (reads === twoCollections) {
          gate.emit("entered");
          await once(gate, "release", { signal: context.signal });
        }
        return state;
      },
    );
    await runtime.start(host.context, configPath);
    const entered = once(gate, "entered", { signal: context.signal });
    const first = runtime.refresh();
    const second = runtime.refresh();
    assert.equal(first, second);
    await entered;
    assert.equal(reads, twoCollections);
    gate.emit("release");
    await Promise.all([first, second]);
    assert.equal(runtime.state.installed, state.installed);
    assert.equal(runtime.state.error, undefined);
    assert.equal(reads, twoCollections);
  },
);
test(
  "an old generation cannot publish or clear a restarted generation's collection",
  options,
  async (context) => {
    const gate = new EventEmitter();
    const states = [
      makeState({ installed: "old-fixture-version" }),
      makeState({ installed: "new-fixture-version" }),
    ];
    let reads = 0;
    const { runtime, host, configPath } = await runtimeFixture(
      context,
      async () => {
        const next = states.at(reads);
        if (next === undefined) {
          throw new Error("Unexpected extra collection");
        }
        reads += 1;
        const number = reads;
        gate.emit(`entered-${number}`);
        await once(gate, `release-${number}`, { signal: context.signal });
        return next;
      },
    );
    const enteredOld: Promise<unknown[]> = once(gate, "entered-1", {
      signal: context.signal,
    });
    const oldStart = runtime.start(host.context, configPath);
    await enteredOld;
    runtime.stop();
    const enteredNew: Promise<unknown[]> = once(gate, "entered-2", {
      signal: context.signal,
    });
    const newStart = runtime.start(host.context, configPath);
    await enteredNew;
    gate.emit("release-1");
    await oldStart;
    assert.equal(runtime.state.installed, "unknown");
    const refresh = runtime.refresh();
    assert.equal(reads, twoCollections);
    gate.emit("release-2");
    await Promise.all([newStart, refresh]);
    assert.equal(runtime.state.installed, states[1].installed);
    assert.equal(runtime.state.error, undefined);
    assert.equal(reads, twoCollections);
  },
);
test(
  "a failed collection preserves the last snapshot and permits another refresh",
  options,
  async (context) => {
    let reads = 0;
    const state = makeState({ installed: "kept-fixture-version" });
    const { runtime, host, configPath } = await runtimeFixture(context, () => {
      reads += 1;
      if (reads === twoCollections) {
        return Promise.reject(new Error("fixture read failed"));
      }
      return Promise.resolve(state);
    });
    await runtime.start(host.context, configPath);
    await runtime.refresh();
    assert.equal(runtime.state.installed, state.installed);
    assert.equal(runtime.state.error, "fixture read failed");
    await runtime.refresh();
    assert.equal(runtime.state.installed, state.installed);
    assert.equal(runtime.state.error, undefined);
    assert.equal(reads, threeCollections);
  },
);
