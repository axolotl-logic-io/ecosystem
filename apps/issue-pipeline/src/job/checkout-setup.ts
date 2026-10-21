// Checkout setup reports signed wiki requirements on failure without claiming
// the issue, replacing recovery evidence or inventing fallback authority.
import type { Config } from "../config.ts";
import { CheckoutSetupError, openJobCheckout } from "./checkout.ts";
import { inputsOf } from "./role-inputs.ts";
import { wikiSetupReason } from "./wiki-requirements.ts";

// Setup precedes the claim. If it fails, retain the checkout and all saved
// authority, and identify any signed required pages before reporting the hold.
function openCheckout(
  cfg: Config,
  issue: number,
  job: { stage: string; branch: string },
): ReturnType<typeof openJobCheckout> {
  try {
    return openJobCheckout(cfg, issue, job);
  } catch (error: unknown) {
    if (!(error instanceof CheckoutSetupError)) {
      throw error;
    }
    let pages: readonly string[] = [];
    try {
      const { gherkin } = inputsOf(cfg, issue, {});
      pages = gherkin?.wikiPages ?? [];
    } catch (inputError: unknown) {
      throw new Error(
        `${error.message}; cannot read signed wiki requirements: ${messageOf(inputError)}`,
        { cause: inputError },
      );
    }
    throw new Error(wikiSetupReason(pages, error.message), { cause: error });
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export { openCheckout };
