import type {
  MonitorEntity,
  MonitorEvent,
  TokenUsage,
} from "@ecosystem/db/monitoring-protocol";
import { z } from "zod";

const secretAssignment =
  /(?<key>["']?(?:[\w-]*(?:token|password|secret|api[_-]?key|credential)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/giu;
const bearer = /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/giu;
const githubToken =
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/gu;
const urlPassword = /(?<scheme>\w+:\/\/)[^\s/@:]+:[^\s/@]+@/gu;
const privateKey =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu;
const terminalControl = /\p{Cc}/gu;
const maximumDate = 8.64e15;
const credentialPath =
  /(?:\.env(?:\b|\.)|project-credentials|model-key\.env|credentialsEnvFile)/iu;
const lineLimit = 262_000;
const baseRecord = z.object({
  type: z.string(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  observedAt: z.number().optional(),
});
const textPart = z.object({ type: z.literal("text"), text: z.string() });
const thinkingPart = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});
const toolPart = z.object({
  type: z.literal("toolCall"),
  name: z.string(),
  arguments: z.unknown(),
});
const contentSchema = z.union([z.string(), z.array(z.unknown())]);
const messageSchema = z.object({
  role: z.string(),
  content: contentSchema,
  timestamp: z.number().optional(),
  usage: z.unknown().optional(),
  sections: z.record(z.string(), z.string().nullable()).optional(),
  summary: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  errorMessage: z.string().optional(),
});
const counts = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
});
const envelope = z.object({ message: messageSchema });
const policy = z.object({
  contextWindow: z.int().positive(),
  targetTokens: z.int().positive(),
});
const toolEvent = z.object({
  toolName: z.string(),
  args: z.unknown().optional(),
  result: z.object({ content: contentSchema.optional() }).optional(),
  isError: z.boolean().optional(),
});
const compact = z.object({
  result: z
    .object({
      summary: z.string().optional(),
      usage: z.unknown().optional(),
      tokensBefore: z.number().optional(),
      estimatedTokensAfter: z.number().optional(),
    })
    .optional(),
  aborted: z.boolean().optional(),
  errorMessage: z.string().optional(),
});
const usageEntry = z.object({ usage: counts });

function redact(text: string): string {
  const redacted = text
    .replace(privateKey, "[private key redacted]")
    .replace(bearer, "[authorization redacted]")
    .replace(urlPassword, "$<scheme>redacted@")
    .replace(githubToken, "[token redacted]")
    .replace(secretAssignment, "[redacted]")
    .replace(terminalControl, (character: string): string => {
      if (character === "\n" || character === "\t") {
        return character;
      }
      return "";
    });
  if (redacted.length <= lineLimit) {
    return redacted;
  }
  return `${redacted.slice(0, lineLimit)}\n[Transcript body clipped at 262000 characters]`;
}
function safeBody(text: string): string {
  if (credentialPath.test(text)) {
    return "[Credential-related content withheld]";
  }
  return redact(text);
}
function printable(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}
function textContent(content: z.infer<typeof contentSchema>): {
  text: string;
  reasoning: string | null;
} {
  if (typeof content === "string") {
    return { text: safeBody(content), reasoning: null };
  }
  const texts: string[] = [];
  const thoughts: string[] = [];
  for (const part of content) {
    const text = textPart.safeParse(part);
    const thought = thinkingPart.safeParse(part);
    const tool = toolPart.safeParse(part);
    if (text.success) {
      texts.push(text.data.text);
    }
    if (thought.success) {
      thoughts.push(thought.data.thinking);
    }
    if (tool.success) {
      texts.push(`Tool ${tool.data.name}\n${printable(tool.data.arguments)}`);
    }
  }
  let reasoning: string | null = null;
  if (thoughts.length > 0) {
    reasoning = safeBody(thoughts.join("\n"));
  }
  return { text: safeBody(texts.join("\n")), reasoning };
}
function timestamp(input: unknown): string | null {
  let number = Number.NaN;
  if (typeof input === "number") {
    number = input;
  }
  if (typeof input === "string") {
    number = Date.parse(input);
  }
  if (!Number.isFinite(number) || number < 0 || number > maximumDate) {
    return null;
  }
  return new Date(number).toISOString();
}
function entity(
  input: Pick<MonitorEntity, "id" | "kind" | "title" | "state" | "sourceAt"> &
    Partial<MonitorEntity>,
): MonitorEntity {
  let reason: string | null = null;
  if (input.reason !== undefined && input.reason !== null) {
    reason = safeBody(input.reason);
  }
  return {
    repo: null,
    issue: null,
    parent: null,
    task: null,
    phase: null,
    actor: null,
    model: null,
    window: null,
    startedAt: null,
    endedAt: null,
    activityAt: null,
    ...input,
    title: safeBody(input.title),
    reason,
  };
}
/**
 * A failed provider stream reports all-zero usage. That is a missing
 * measurement, not an empty context, so it is unmeasured.
 */
function measuredUsage(value: unknown): TokenUsage | null {
  const usage = counts.safeParse(value).data;
  if (
    usage === undefined ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0
  ) {
    return null;
  }
  return usage;
}
// Finalized messages alone contribute turn usage; start/update/end echoes do not.
function projectRecord(
  value: unknown,
  session: string,
  source: string,
  position: number,
): MonitorEvent | null {
  const record = baseRecord.safeParse(value);
  if (!record.success) {
    return null;
  }
  const { type } = record.data;
  const event: MonitorEvent = {
    session,
    source,
    position,
    at: timestamp(record.data.observedAt ?? record.data.timestamp),
    kind: "activity",
    label: type,
    body: "",
    reasoning: null,
    usage: null,
    context: null,
    window: null,
    target: null,
    compacted: false,
  };
  if (type === "message_end" || type === "message") {
    const message = envelope.safeParse(value);
    if (!message.success) {
      return null;
    }
    const data = message.data.message;
    const content = textContent(data.content);
    event.kind = "message";
    event.label = data.role;
    event.body = content.text;
    event.reasoning = content.reasoning;
    event.at = timestamp(data.timestamp) ?? event.at;
    if (data.sections !== undefined) {
      event.body += `\n${safeBody(printable(data.sections))}`;
    }
    if (data.role === "toolResult") {
      event.kind = "tool";
      event.label = `${data.toolName ?? "tool"} result`;
      event.usage = measuredUsage(data.usage);
      if (data.isError === true) {
        event.label += " · failed";
      }
    }
    if (data.role === "assistant") {
      event.usage = measuredUsage(data.usage);
      if (event.usage !== null) {
        event.context =
          event.usage.input + event.usage.cacheRead + event.usage.cacheWrite;
      }
    }
    if (data.errorMessage !== undefined) {
      event.kind = "error";
      event.label += " · failed";
      event.body += `\n${safeBody(data.errorMessage)}`;
    }
    return event;
  }
  if (type === "runtime_policy") {
    const parsed = policy.safeParse(value);
    if (!parsed.success) {
      return null;
    }
    event.kind = "policy";
    event.window = parsed.data.contextWindow;
    event.target = parsed.data.targetTokens;
    return event;
  }
  if (type === "tool_execution_start" || type === "tool_execution_end") {
    const parsed = toolEvent.safeParse(value);
    if (!parsed.success) {
      return null;
    }
    event.kind = "tool";
    event.label = `${parsed.data.toolName} ${type.slice("tool_execution_".length)}`;
    if (parsed.data.isError === true) {
      event.label += " · failed";
    }
    event.body = safeBody(printable(parsed.data.args));
    if (parsed.data.result?.content !== undefined) {
      event.body = textContent(parsed.data.result.content).text;
    }
    return event;
  }
  if (type === "compaction_end") {
    const parsed = compact.safeParse(value);
    if (!parsed.success) {
      return null;
    }
    event.kind = "compaction";
    event.compacted =
      parsed.data.result !== undefined && parsed.data.aborted !== true;
    event.usage = measuredUsage(parsed.data.result?.usage);
    event.body = safeBody(
      printable(parsed.data.result) ||
        parsed.data.errorMessage ||
        "Compaction did not complete",
    );
    return event;
  }
  if (type === "usage") {
    const parsed = usageEntry.safeParse(value);
    if (!parsed.success) {
      return null;
    }
    event.kind = "usage";
    event.usage = parsed.data.usage;
    return event;
  }
  if (
    [
      "agent_start",
      "agent_settled",
      "turn_start",
      "compaction_start",
      "auto_retry_start",
      "auto_retry_end",
    ].includes(type)
  ) {
    return event;
  }
  return null;
}

export { entity, projectRecord, redact, safeBody, timestamp };
