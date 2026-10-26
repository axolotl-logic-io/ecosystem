// TEST-ONLY module hook, loaded with `node --import` into the signal
// driver process: it resolves src/tasks/index.ts to fake-tasks.ts, so the
// signal inbox runs before the tasks lane's module exists. Nothing in src/
// loads it, and it redirects no other module.
import {
  type ResolveFnOutput,
  type ResolveHookContext,
  registerHooks,
} from "node:module";

const TASKS: string = new URL("../../../src/tasks/index.ts", import.meta.url)
  .href;
const FAKE_TASKS: string = new URL("fake-tasks.ts", import.meta.url).href;

registerHooks({
  resolve(
    specifier: string,
    context: ResolveHookContext,
    nextResolve: (
      specifier: string,
      context?: Partial<ResolveHookContext>,
    ) => ResolveFnOutput,
  ): ResolveFnOutput {
    if (
      context.parentURL !== undefined &&
      new URL(specifier, context.parentURL).href === TASKS
    ) {
      return { url: FAKE_TASKS, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
