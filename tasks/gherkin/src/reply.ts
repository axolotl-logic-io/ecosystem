import { z } from "zod";

// Most questions a session may ask instead of writing Gherkin.
const MOST_QUESTIONS = 5;

// The session's reply: the behaviour as Gherkin with the calls the session
// made, or the questions only the issue's author can answer.
const gherkinReply = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("gherkin"),
    gherkin: z.string().min(1),
    assumptions: z.array(z.string().min(1)),
  }),
  z.strictObject({
    outcome: z.literal("needs-info"),
    questions: z.array(z.string().min(1)).min(1).max(MOST_QUESTIONS),
  }),
]);

export { gherkinReply };
