// Comment signatures. The merge identity posts every comment, so each comment
// names who wrote it: the role, the agent definition, the model, and the run
// key (to find its logs).

// What the sweep recorded about a child when it launched it, by launch key.
interface LaunchMeta {
  agent?: string;
  model?: string;
}

type SpecMeta = Readonly<Partial<Record<string, LaunchMeta>>>;

// The parts of a child's result a signature reads.
interface ChildResult {
  key?: string;
  agent?: string;
  runId?: string;
}

interface Signature {
  role: string;
  agent: string | null;
  model: string | null;
  run: string | null;
}

function launchOf(specMeta: SpecMeta, result: ChildResult): LaunchMeta {
  if (result.key === undefined) {
    return {};
  }
  return specMeta[result.key] ?? {};
}

// The text, or null when it is missing or empty.
function present(text: string | undefined): string | null {
  if (text === undefined || text === "") {
    return null;
  }
  return text;
}

// The model's name without its provider: the last segment of its path.
function modelName(model: string | undefined): string | null {
  return present(model)?.split("/").at(-1) ?? null;
}

// The signature of a child's comment: its agent and the model's last path
// segment from its launch, and its run id, or its key when it has none. A
// missing result signs with the role alone.
function by(
  specMeta: SpecMeta,
  result: ChildResult | null | undefined,
  role: string,
): Signature {
  if (result === null || result === undefined) {
    return byStep(role);
  }
  const launch = launchOf(specMeta, result);
  return {
    role,
    agent: present(result.agent) ?? present(launch.agent),
    model: modelName(launch.model),
    run: present(result.runId) ?? present(result.key),
  };
}

// Deterministic steps (checks, CI) sign as themselves with no agent or model.
function byStep(role: string): Signature {
  return { role, agent: null, model: null, run: null };
}

export type { LaunchMeta, Signature, SpecMeta };
export { by, byStep };
