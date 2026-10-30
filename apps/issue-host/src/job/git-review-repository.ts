// Repository authority and the configuration-free metadata view used by Git.
import fs from "node:fs";
import path from "node:path";

const SHA256 = /^\s*objectformat\s*=\s*sha256\s*$/imu;
const REFTABLE = /^\s*refstorage\s*=\s*reftable\s*$/imu;
const SHARED_INDEX = /^sharedindex\.[a-f0-9]+$/u;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function rootsOf(roots: readonly string[]): string[] {
  return roots.map((root) => {
    if (!path.isAbsolute(root)) {
      throw new Error("Repository roots must be absolute paths");
    }
    const canonical = fs.realpathSync(root);
    const gitDir = path.join(canonical, ".git");
    if (!fs.lstatSync(gitDir).isDirectory()) {
      throw new Error(
        "Only repositories with a plain .git directory are supported",
      );
    }
    return canonical;
  });
}

function repositoryOf(cwd: string, roots: readonly string[]): string {
  if (!path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute allowlisted repository root");
  }
  const canonical = fs.realpathSync(cwd);
  if (!roots.includes(canonical)) {
    throw new Error("cwd must name an explicitly allowlisted repository root");
  }
  return canonical;
}

// Check existing ancestors too, so a missing file below an escaping symlink
// cannot bypass validation. Git receives literal pathspecs only.
function checkPaths(repo: string, paths: readonly string[]): void {
  for (const file of paths) {
    let current = path.resolve(repo, file);
    while (fs.lstatSync(current, { throwIfNoEntry: false }) === undefined) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Unsupported path: ${file}`);
      }
      current = parent;
    }
    if (!inside(repo, fs.realpathSync(current))) {
      throw new Error(`Path leaves repository: ${file}`);
    }
  }
}

function assertPlainTree(dir: string): void {
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) {
    throw new Error("Symlink or special file in Git metadata is unsupported");
  }
  if (info.isDirectory()) {
    for (const child of fs.readdirSync(dir)) {
      assertPlainTree(path.join(dir, child));
    }
  }
}

function copyIfPresent(source: string, target: string): void {
  if (fs.existsSync(source)) {
    assertPlainTree(source);
    fs.cpSync(source, target, { recursive: true, dereference: false });
  }
}

function metadataView(repo: string, view: string): void {
  const source = path.join(repo, ".git");
  if (!fs.lstatSync(source).isDirectory()) {
    throw new Error("Git directory indirection is unsupported");
  }
  for (const name of [
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ]) {
    if (fs.existsSync(path.join(source, name))) {
      throw new Error(`Unsupported Git metadata indirection: ${name}`);
    }
  }
  const configFile = path.join(source, "config");
  assertPlainTree(configFile);
  const config = fs.readFileSync(configFile, "utf8");
  if (REFTABLE.test(config)) {
    throw new Error("Reftable repositories are unsupported");
  }
  let format = "";
  if (SHA256.test(config)) {
    format = ["", "[extensions]", "objectformat = sha256", ""].join("\n");
  }
  fs.mkdirSync(view);
  fs.writeFileSync(
    path.join(view, "config"),
    `[core]\nrepositoryformatversion = 1\nbare = false\nlogAllRefUpdates = false\n${format}`,
  );
  for (const name of [
    "HEAD",
    "index",
    "refs",
    "packed-refs",
    "shallow",
    ...fs.readdirSync(source).filter((entry) => SHARED_INDEX.test(entry)),
  ]) {
    copyIfPresent(path.join(source, name), path.join(view, name));
  }
  const objects = path.join(source, "objects");
  assertPlainTree(objects);
  fs.symlinkSync(objects, path.join(view, "objects"), "dir");
}

export { checkPaths, metadataView, repositoryOf, rootsOf };
