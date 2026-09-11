import { parseArgs } from 'node:util';
import { cliError } from './io.mjs';

export const COMMANDS = Object.freeze({
  info: 'Print Roslyn and managed runtime versions',
  references: 'List registered compilation references',
  extensions: 'List registered compiler extensions',
  compile: 'Compile C# files/directories/stdin to IL, JavaScript or native Wasm',
  'emit-js': 'Compile a PE/MSIL DLL to a JavaScript ES module',
  'emit-wasm': 'Compile a PE/MSIL DLL to native WebAssembly',
  run: 'Compile and run C#, or execute a DLL, Wasm module or generated JS module',
  inspect: 'Inspect PE metadata and MSIL instructions',
  analyze: 'Check JavaScript or native Wasm compatibility',
  eval: 'Evaluate a C# expression',
  invoke: 'Invoke a static managed method with typed JSON arguments',
  'compile-function': 'Compile a dynamic function described by --spec',
  build: 'Build a C# project using supported MSBuild semantics',
  'evaluate-project': 'Evaluate a project without starting Roslyn',
  restore: 'Resolve NuGet packages and write their lock information',
  package: 'Import a local .nupkg and inspect its selected assets',
  resources: 'Create a .resources binary from a JSON entries array',
  resx: 'Convert a .resx file to a .resources binary',
  task: 'Run a managed build task',
  native: 'Run a WASI Preview 1 command in an isolated Worker',
  api: 'Call a public compiler API using one JSON request',
  session: 'Process JSON-lines requests with a persistent compiler and cache',
  batch: 'Execute a JSON array of API requests in one persistent session',
  script: 'Run a Node ES module with the complete compiler API',
  watch: 'Recompile/rebuild/rerun on file changes while retaining caches',
  serve: 'Serve the browser playground or a custom static directory',
});

const stringNames = ['output','target','backend','options','run-options','wasm-options','javascript-options','project-options','artifact','manifest','pdb','xml','name','kind','optimization','nullable','lang-version','optimize','type','return-type','method','arguments','parameters','generic-arguments','spec','request','framework','root','files-out','runtime','timeout-ms','startup-timeout-ms','max-instructions','max-results','max-result-bytes','max-line-bytes','poll-ms','port','host','cache-dir'];
const multipleNames = ['reference','extension','package','nupkg','feed','property','target-name','define','using'];
const booleanNames = ['help','version','json','verbose','compiler-references','task-references','include-prerelease','unsafe','checked','warnings-as-errors','no-pdb','no-cache','no-restore','invoke','events','stop-on-error','offline'];
const definitions = Object.fromEntries([
  ...stringNames.map(name=>[name,{type:'string',...(name==='output'?{short:'o'}:{})}]),
  ...multipleNames.map(name=>[name,{type:'string',multiple:true,...(name==='reference'?{short:'r'}:{})}]),
  ...booleanNames.map(name=>[name,{type:'boolean',...(name==='help'?{short:'h'}:name==='version'?{short:'v'}:{})}]),
]);
const shared = ['help','version','json','verbose','runtime','timeout-ms','startup-timeout-ms'];
const registration = ['reference','extension','package','nupkg','feed','framework','include-prerelease','compiler-references','task-references','cache-dir','offline'];
const compilation = ['options','name','kind','optimization','nullable','lang-version','unsafe','checked','define','using','warnings-as-errors','pdb','no-pdb','xml','no-cache'];
const emission = ['wasm-options','javascript-options','optimize','manifest','artifact'];
const execution = ['backend','run-options','max-instructions','files-out'];
const projects = ['root','property','target-name','no-restore','project-options'];
const allowed = {
  info: [], references: registration, extensions: registration,
  compile: [...registration,...compilation,...emission,'target','output'],
  'emit-js': [...registration,...emission,'output'], 'emit-wasm': [...registration,...emission,'output'],
  run: [...registration,...compilation,'wasm-options','javascript-options','optimize',...execution,...projects],
  inspect: [...registration,'output'], analyze: [...registration,'wasm-options','javascript-options','optimize','backend','output'],
  eval: [...registration,...compilation,'spec','arguments','type','return-type','method'],
  invoke: [...registration,'type','method','arguments','parameters','generic-arguments','run-options','files-out'],
  'compile-function': [...registration,...compilation,'spec','invoke','arguments','output','type','method','return-type'],
  build: [...registration,...compilation,...emission,...projects,'target','output','files-out'],
  'evaluate-project': [...projects,'output'],
  restore: [...registration,'output','artifact','files-out'], package: [...registration,'output','artifact','files-out'],
  resources: ['output'], resx: ['output'], task: [...registration,'type','request','files-out'],
  native: ['request','files-out'],
  api: [...registration,'request','max-results','max-result-bytes','events'],
  batch: [...registration,'request','max-results','max-result-bytes','events','stop-on-error'],
  session: [...registration,'max-results','max-result-bytes','max-line-bytes','events','stop-on-error'],
  script: registration,
  watch: ['poll-ms'], serve: ['root','host','port'],
};
const camel = name=>name.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());

export function parseCli(argv) {
  let parsed;
  try { parsed = parseArgs({ args:argv, options:definitions, allowPositionals:true, strict:true, tokens:true }); }
  catch(error) { throw cliError(error.message); }
  const {values,tokens} = parsed;
  const terminator = tokens.find(t=>t.kind==='option-terminator')?.index ?? argv.length;
  const args = terminator < argv.length ? argv.slice(terminator+1) : [];
  const positionals = tokens.filter(t=>t.kind==='positional' && t.index<terminator).map(t=>t.value);
  let command = positionals.shift() || 'help';
  if (command==='help') {
    command=positionals.shift() || 'help'; values.help=true;
    if(command!=='help' && !Object.hasOwn(COMMANDS,command)) throw cliError(`Unknown command: ${command}`);
  } else if(!Object.hasOwn(COMMANDS,command)) throw cliError(`Unknown command: ${command}`);
  const options = Object.fromEntries(Object.entries(values).map(([key,value])=>[camel(key),value]));
  options.args=args;
  let watchCommand;
  if(command==='watch' && !options.help) {
    watchCommand=positionals.shift();
    if(!['compile','build','run'].includes(watchCommand)) throw cliError('watch requires compile, build, or run as its subcommand.');
  }
  if(!options.help && !options.version) {
    const permit = new Set([...shared,...(allowed[watchCommand || command] || []),...(watchCommand?['poll-ms']:[])]);
    for(const key of Object.keys(values)) if(!permit.has(key)) throw cliError(`--${key} is not supported by ${watchCommand || command}.`);
    if(args.length && !['run','native','script'].includes(watchCommand || command)) throw cliError(`Arguments after -- are not supported by ${watchCommand || command}.`);
  }
  for(const key of ['timeoutMs','startupTimeoutMs','maxInstructions','maxResults','maxResultBytes','maxLineBytes','pollMs','port']) {
    if(options[key]!==undefined) {
      const min = key==='port'?0:1;
      const value=Number(options[key]);
      if(!Number.isSafeInteger(value) || value<min || (key==='port' && value>65535)) throw cliError(`--${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())} must be an integer from ${min}${key==='port'?' to 65535':''}.`);
      options[key]=value;
    }
  }
  if(options.noPdb) options.emitPdb=false;
  if(options.noRestore) options.restore=false;
  if(options.noCache) options.useCompilationCache=false;
  if(options.pdb && options.noPdb) throw cliError('--pdb and --no-pdb cannot be combined.');
  if(options.target && !['il','javascript','wasm'].includes(options.target)) throw cliError('--target must be il, javascript, or wasm.');
  if(options.backend && !['auto','wasm','javascript','native-wasm'].includes(options.backend)) throw cliError('--backend must be auto, wasm, javascript, or native-wasm.');
  if(options.optimization && !['debug','release'].includes(options.optimization)) throw cliError('--optimization must be debug or release.');
  if(options.kind && !['console','library','windows','module'].includes(options.kind)) throw cliError('--kind must be console, library, windows, or module.');
  if(options.nullable && !['enable','disable','warnings','annotations'].includes(options.nullable)) throw cliError('--nullable must be enable, disable, warnings, or annotations.');
  if(options.optimize && !['true','false','blocks'].includes(options.optimize)) throw cliError('--optimize must be true, false, or blocks.');
  return { command, positionals, options, watchCommand };
}

export function helpText(command='help') {
  if(command==='help') return `RoslynWeb — Roslyn C# and MSIL compilers for Node and browsers\n\nUsage: roslynweb <command> [inputs] [options] [-- program arguments]\n\n${Object.entries(COMMANDS).map(([name,description])=>`  ${name.padEnd(19)}${description}`).join('\n')}\n\nUse roslynweb help <command> for options. Node.js 22 or newer is required.\nA source checkout needs npm run build once; prebuilt packages include the Wasm runtime.\nCLI guide: docs/CLI.md\n`;
  const names=[...new Set([...shared,...allowed[command]])];
  return `roslynweb ${command} — ${COMMANDS[command]}\n\nUsage: roslynweb ${command} [inputs] [options]\n\nOptions:\n${names.map(name=>`  --${name}${definitions[name].type==='string'?' <value>':''}${definitions[name].multiple?' (repeatable)':''}`).join('\n')}\n\n${command==='watch'?'Subcommands: compile, build, run. Their options are accepted after watch.\n':''}--json reserves stdout for a lossless JSON result. Diagnostics/progress use stderr.\n--timeout-ms controls operation timeout (default 30000); startup defaults to 300000 ms.\nJSON option files expose the complete corresponding public API options.\nSee docs/CLI.md for examples and the API/session wire format.\n`;
}
