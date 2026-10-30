import type { World } from "./fake-github-world.ts";

const REPO = "acme/widgets";
const ORGANIZATION = "acme";
const LANDING = "lawd-landing";
function baseWorld(): World {
  return {
    repo: REPO,
    organization: ORGANIZATION,
    organizationObject: false,
    tokens: [
      { token: "landing-token", login: LANDING },
      { token: "dev-token", login: "lawd-dev" },
    ],
    accounts: [
      { login: LANDING, id: 1, type: "User" },
      { login: "lawd-dev", id: 2, type: "User" },
      { login: "autumn", id: 10, type: "User" },
      { login: "mallory", id: 11, type: "User" },
      { login: "renovate[bot]", id: 12, type: "Bot" },
      { login: "pending-pat", id: 13, type: "User" },
    ],
    members: [
      { login: LANDING, state: "active", role: "member" },
      { login: "lawd-dev", state: "active", role: "member" },
      { login: "autumn", state: "active", role: "admin" },
      { login: "pending-pat", state: "pending", role: "member" },
    ],
    issues: [],
    faults: [],
    pageSize: 100,
    post: "ok",
    nextId: 500,
  };
}

export { baseWorld, LANDING, ORGANIZATION, REPO };
