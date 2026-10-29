// TEST-ONLY stand-in for src/tasks/index.ts, which the tasks lane owns and
// hasn't delivered to this worktree. fake-tasks-hook.ts redirects the
// signal inbox's import of src/tasks/index.ts here, in the driver process
// only. It answers the task-lane functions the inbox consumes from the
// same world file as the fake gh, so the tests exercise the signal module's
// real gh, provenance and journal paths against canned task answers. It
// proves component transport, not integration with the real task lane.
import process from "node:process";
import type {
  ActionCause,
  Binding,
  QualifiedSignal,
  TaskView,
} from "../../../src/domain.ts";
import { readWorld, type TaskAnswers } from "./fake-github-world.ts";

function answersFor(number: number): TaskAnswers {
  const { FAKE_GH_WORLD: file = "" } = process.env;
  const found = readWorld(file).tasks.find((item) => item.number === number);
  if (found === undefined) {
    throw new Error(`fake tasks: no answers for #${number}`);
  }
  if (found.failure !== null) {
    throw new Error(found.failure);
  }
  return found;
}

function readTaskView(_cfg: unknown, number: number): Promise<TaskView> {
  return Promise.resolve(answersFor(number).view);
}

function actionCauses(
  _cfg: unknown,
  number: number,
): Promise<readonly { binding: Binding; cause: ActionCause }[]> {
  return Promise.resolve(answersFor(number).causes);
}

function previousAction(
  _cfg: unknown,
  binding: Binding,
): Promise<string | null> {
  return Promise.resolve(answersFor(binding.workItem.number).previous);
}

function machineSignals(
  _cfg: unknown,
  number: number,
): Promise<readonly QualifiedSignal[]> {
  return Promise.resolve(answersFor(number).machine);
}

export { actionCauses, machineSignals, previousAction, readTaskView };
