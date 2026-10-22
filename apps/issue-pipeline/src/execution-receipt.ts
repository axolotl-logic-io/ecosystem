// Optional only for saved-state compatibility. A missing receipt never grants
// the explicit execution seam permission; malformed receipts never default away.
import { z } from "zod";

const EXECUTION_RECEIPT = z.strictObject({
  protocol: z.literal(1),
  request: z.number().int().positive(),
  instance: z.string().uuid(),
});
type ExecutionReceipt = z.infer<typeof EXECUTION_RECEIPT>;

export type { ExecutionReceipt };
export { EXECUTION_RECEIPT };
