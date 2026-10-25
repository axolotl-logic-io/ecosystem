// A Config for tests that pass one to an ops module in-process: the
// pipeline's actual defaults (src/config-schema.ts's DEFAULTS) under a test
// repo's required keys, with the models and removed keys handled and the
// schema checked as loadConfig does, without a config file. Neither src
// module it reads resolves the pipeline root, so it is safe to load before a
// test isolates its root.

import type { Config } from "../src/config.ts";
import { withoutRemovedKeys } from "../src/config-legacy.ts";
import { CONFIG_SCHEMA, DEFAULTS } from "../src/config-schema.ts";
import { credentialConfig } from "./credentials-test-kit.ts";

const BASE: {
  allowedUsers: string[];
  baseBranch: string;
  commands: { test: string };
  devAccount: string;
  mergeAccount: string;
  credentialsEnvFile: string;
  repo: string;
} = {
  repo: "o/r",
  ...credentialConfig("bot"),
  allowedUsers: ["alice"],
  baseBranch: "integration",
  commands: { test: "true" },
};

// extra: keys over the defaults and base
function configFixture(extra: Record<string, unknown> = {}): Config {
  const { kept } = withoutRemovedKeys({ ...DEFAULTS, ...BASE, ...extra });
  const data = CONFIG_SCHEMA.parse(kept);
  return { ...data, slug: data.repo.replace("/", "__") };
}

export { configFixture };
