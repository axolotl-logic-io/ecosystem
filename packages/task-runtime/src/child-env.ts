// Credentials never travel through ordinary child environments. The landing
// token's name before #166 stays hidden too, in case an operator environment
// still sets it; it never selects an authentication identity.
const CREDENTIAL_VARIABLES: readonly string[] = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "POSTGRES_PASSWORD",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_DEBUG",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CURL_VERBOSE",
  "ISSUE_PIPELINE_DEV_GITHUB_TOKEN",
  "ISSUE_PIPELINE_MERGE_GITHUB_TOKEN",
  "ISSUE_PIPELINE_LANDING_GITHUB_TOKEN",
];
const GIT_CONFIG_ENTRY = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u;
const GIT_TRACE = /^GIT_TRACE/u;
const hiddenVariables = new Set(CREDENTIAL_VARIABLES);

function hideCredentialVariable(name: string): void {
  hiddenVariables.add(name);
}

function childEnvironment(
  from: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(from)) {
    if (
      value !== undefined &&
      !hiddenVariables.has(name) &&
      !GIT_CONFIG_ENTRY.test(name) &&
      !GIT_TRACE.test(name)
    ) {
      clean[name] = value;
    }
  }
  return clean;
}

export { childEnvironment, hideCredentialVariable };
