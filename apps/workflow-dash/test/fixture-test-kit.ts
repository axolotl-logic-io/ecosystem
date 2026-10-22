import { cp, mkdtemp, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Materialize byte-preserved source snapshots, including malformed JSON. */
async function materializeFixtures(source: URL): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workflow-dash-fixtures-"));
  await cp(source, root, { recursive: true });
  const files = await readdir(root, { recursive: true });
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json.txt"))
      .map((file) =>
        rename(join(root, file), join(root, file.slice(0, -".txt".length))),
      ),
  );
  return root;
}

export { materializeFixtures };
