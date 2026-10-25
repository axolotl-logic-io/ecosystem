// The executables the fakes install, such as `gh` and `pi`, as small node
// scripts that call one export of a TypeScript test module. Node strips a
// .ts module's types each time a process loads it, which costs tens of
// milliseconds; a fake starts once per call, so a full flow pays that
// thousands of times (#152). Each script turns on Node's compile cache
// first, so a module is stripped and compiled once, not once per call.

// The source of a script that awaits `name(...args)` from the module `kit`.
function tsShim(kit: string, name: string, args: readonly unknown[]): string {
  const call = args.map((arg) => JSON.stringify(arg)).join(", ");
  return [
    "#!/usr/bin/env node",
    'import module from "node:module";',
    "module.enableCompileCache();",
    `const { ${name} } = await import(${JSON.stringify(kit)});`,
    `await ${name}(${call});`,
    "",
  ].join("\n");
}

export { tsShim };
