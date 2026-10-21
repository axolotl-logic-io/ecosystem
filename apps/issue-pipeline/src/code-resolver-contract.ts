// The versioned agreement between a pinned Integration page and the code
// resolver task. This declares compatibility, not tools or write authority.

const CODE_RESOLVER_PROTOCOL = "stage-text-and-return/v1";
const PROTOCOL_DECLARATION =
  /^Code-Resolver-Protocol:(?<protocol>[^\r\n]*)\r?$/gmu;

// A page must declare exactly one supported protocol on its own line. Do not
// infer compatibility from prose or silently substitute instructions.
function codeResolverContractProblem(text: string): string | null {
  const declarations = [...text.matchAll(PROTOCOL_DECLARATION)].map((match) => {
    const { protocol = "" } = match.groups ?? {};
    return protocol.trim();
  });
  if (declarations.length === 1 && declarations[0] === CODE_RESOLVER_PROTOCOL) {
    return null;
  }
  let found = "missing Code-Resolver-Protocol declaration";
  if (declarations.length > 0) {
    found = `unsupported or ambiguous Code-Resolver-Protocol declaration: ${JSON.stringify(declarations)}`;
  }
  return `incompatible code-resolver contract: required Code-Resolver-Protocol: ${CODE_RESOLVER_PROTOCOL}; ${found}`;
}

export { CODE_RESOLVER_PROTOCOL, codeResolverContractProblem };
