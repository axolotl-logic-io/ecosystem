// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProjectSettings } from "../src/project-policy-schema.ts";

const REPEATED_FIELD = /project policy repeats field/u;
for (const document of [
  '{"commands":{"test":"trusted"},"commands":{"test":"weakened"}}',
  '{"commands":{"test":"trusted","test":"weakened"}}',
  '{"commands":{"test":"trusted","\\u0074est":"weakened"}}',
]) {
  test(`project JSON refuses duplicate authority: ${document}`, () => {
    assert.throws(() => parseProjectSettings(document), REPEATED_FIELD);
  });
}

test("same member names in separate objects and punctuation inside command strings remain valid", () => {
  const settings = {
    commands: { test: 'printf "test":{}', setup: "true" },
    migrations: { up: "migrate", setup: "true", pathGlobs: ["migrations/**"] },
  };
  assert.deepEqual(parseProjectSettings(JSON.stringify(settings)), settings);
});

test("duplicate-key validation does not repair malformed JSON", () => {
  assert.throws(
    () => parseProjectSettings('{"commands":{"test":"true"}'),
    SyntaxError,
  );
});
