import { z } from "zod";

const ADOPTION = z.object({
  evidence: z.string().min(1),
  digest: z.string().min(1),
  repo: z.string().min(1),
  restart: z.enum(["author", "stopped"]),
  // Closed work needs explicit validated reopen; merged work lacks current
  // completion authority and cannot enter a model stage through adoption.
  blocked: z.boolean(),
});

export { ADOPTION };
