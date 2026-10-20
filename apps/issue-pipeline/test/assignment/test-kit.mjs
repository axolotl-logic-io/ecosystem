// @ts-check
import { sweep } from "../../src/assignment/worker.ts";

/** @import { fakeGithub } from './fake-github.mjs' */
const SECOND = 1000;
/** @param {ReturnType<typeof fakeGithub>} fake @param {number} [number] */
async function ready(fake, number = 1) {
  fake.issue(number);
  await sweep(fake.cfg, "build", fake.deps());
  fake.world.now += SECOND;
  await sweep(fake.cfg, "build", fake.deps());
  const state = fake.states.get(number);
  if (state === undefined || state.pr === null) {
    throw new Error("fixture failed to create its source checkpoint and PR");
  }
  return state;
}

export { ready };
