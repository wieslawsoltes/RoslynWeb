import { stat, readdir } from 'node:fs/promises';
import { resolve, extname, basename, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cliError } from './io.mjs';

export async function watchCommand(command, positionals, options, context, execute) {
  if(!positionals.length || positionals.includes('-')) throw cliError('watch requires filesystem inputs; standard input is not repeatable.');
  const inputs=[...positionals,...['reference','extension','nupkg'].flatMap(k=>options[k]||[]),...['options','runOptions','wasmOptions','javascriptOptions','projectOptions'].flatMap(k=>typeof options[k]==='string' && !options[k].trimStart().startsWith('{')?[options[k]]:[])];
  if(command==='build' || (command==='run' && positionals.length===1 && extname(positionals[0]).toLowerCase()==='.csproj')) inputs.push(options.root || resolve(context.cwd,positionals[0],'..'));
  const ignored=new Set(['output','artifact','manifest','pdb','xml'].filter(k=>typeof options[k]==='string').map(k=>resolve(context.cwd,options[k])));
  const outDir=options.filesOut && resolve(context.cwd,options.filesOut);
  const sourceExt=new Set(['.cs','.csproj','.props','.targets','.resx','.json','.txt','.dll','.nupkg','.wasm','.js','.mjs','.editorconfig','.config']);
  const watchedFile=path=>basename(path)==='.editorconfig' || sourceExt.has(extname(path).toLowerCase());
  const inOutputDirectory=path=>{
    if(!outDir)return false;
    const pathFromOutput=relative(outDir,path);
    return !isAbsolute(pathFromOutput) && pathFromOutput!=='..' && !pathFromOutput.startsWith('..'+sep);
  };
  async function snapshot(){
    const files=new Map();
    async function scan(path,explicit=false){
      const full=resolve(context.cwd,path);
      if(ignored.has(full) || inOutputDirectory(full)) return;
      let info;try{info=await stat(full);}catch(error){if(error.code==='ENOENT'){files.set(full,'missing');return;}throw error;}
      if(info.isDirectory()){
        for(const item of await readdir(full,{withFileTypes:true})){
          if(item.isSymbolicLink() || ['.git','node_modules','bin','obj','dist','.pages','artifacts'].includes(item.name))continue;
          if(item.isDirectory() || watchedFile(item.name))await scan(resolve(full,item.name));
        }
      }else if(explicit || watchedFile(full))files.set(full,`${info.mtimeMs}:${info.ctimeMs}:${info.size}`);
      if(files.size>20000)throw cliError('Watch input exceeds 20,000 files. Choose a narrower --root.','INPUT_LIMIT');
    }
    for(const input of inputs)await scan(input,true);
    return files;
  }
  let previous=await snapshot();
  const run=async event=>{
    const outputs=await execute(event);
    // The compiler determines default names after collecting/evaluating inputs.
    // Only its actual emitted artifacts are excluded; dependency DLLs still
    // trigger reloads, and concurrent source edits remain in the next snapshot.
    for(const path of Object.values(outputs || {}))if(typeof path==='string')ignored.add(resolve(context.cwd,path));
    for(const path of ignored)previous.delete(path);
  };
  await run({iteration:1,changed:[]});
  let iteration=1;
  while(!context.signal.aborted){
    try{await delay(options.pollMs??500,undefined,{signal:context.signal});}catch(error){if(error.name==='AbortError')break;throw error;}
    const next=await snapshot();
    const changed=[...new Set([...previous.keys(),...next.keys()])].filter(path=>previous.get(path)!==next.get(path));
    previous=next;
    if(changed.length)await run({iteration:++iteration,changed});
  }
}
