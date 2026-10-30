import type { IssueGitHub } from "./issue-github.ts";
import { marked } from "./markers.ts";
import { recovery } from "./recovery.ts";

interface IssueArtifactOptions {
  task: string;
  execution: string;
  baseBranch: string;
  update: readonly string[];
  append: readonly string[];
}
interface IssueArtifacts {
  publish: (name: string, content: string) => Promise<void>;
}

// Updates only artifacts authored by a prior claimant of this task. Questions
// and other append artifacts always get a fresh comment. Every write is guarded.
function issueArtifacts(
  github: IssueGitHub,
  options: IssueArtifactOptions,
): IssueArtifacts {
  const history = recovery(github, options.task, options.baseBranch);
  return {
    publish: (name: string, content: string): Promise<void> => {
      github.checkStop();
      const body = marked(content, options.task, name, {
        run: options.execution,
      });
      if (options.append.includes(name)) {
        github.comment(body);
        return Promise.resolve();
      }
      if (!options.update.includes(name)) {
        throw new Error(`unknown task artifact: ${name}`);
      }
      const earlier = history.earlierComments(name).at(-1);
      if (earlier === undefined) {
        github.comment(body);
      } else {
        github.editComment(earlier.comment.id, body);
      }
      return Promise.resolve();
    },
  };
}

export type { IssueArtifactOptions, IssueArtifacts };
export { issueArtifacts };
