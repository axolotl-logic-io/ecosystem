// @ts-check
// A Config for tests that pass one to an ops module in-process: the
// pipeline's actual defaults (src/config-schema.ts's DEFAULTS) under a test
// repo's required keys, with the models and removed keys handled and the
// schema checked as loadConfig does, without a config file. Neither src
// module it reads resolves the pipeline root, so it is safe to load before a
// test isolates its root.
import { withoutRemovedKeys } from "../src/config-legacy.ts";
import { CONFIG_SCHEMA, DEFAULTS } from "../src/config-schema.ts";

/** @import { Config } from "../src/config.ts" */

const BASE = {
  repo: "o/r",
  account: "bot",
  allowedUsers: ["alice"],
  baseBranch: "integration",
  commands: { test: "true" },
};

/**
 * @param {Record<string, unknown>} [extra] keys over the defaults and base
 * @returns {Config}
 */
function configFixture(extra = {}) {
  const { kept } = withoutRemovedKeys({ ...DEFAULTS, ...BASE, ...extra });
  const data = CONFIG_SCHEMA.parse(kept);
  return { ...data, slug: data.repo.replace("/", "__") };
}

export { configFixture };
