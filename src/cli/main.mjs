import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCli, helpText } from './options.mjs';
import { cliError, readInputBytes, readStdin, CLI_INPUT_LIMIT } from './io.mjs';
import { encodeJson, stringifyJson, serializeError } from './codec.mjs';
import { createApiSession } from './session.mjs';
import { createRestoreOptions, isCliRestoreOptions } from './package-cache.mjs';

export function exitCodeFor(result, fallback = 0) {
  const code=result?.error?.code || result?.code;
  if(code==='TIMEOUT')return 124;
  if(code==='ABORTED')return 130;
  if(['CLI_USAGE','INVALID_JSON','INVALID_REQUEST','INVALID_ARGUMENT','UNKNOWN_METHOD','INVALID_REFERENCE','INVALID_TARGET'].includes(code))return 2;
  if(result?.success===false || result instanceof Error)return 1;
  const application=result?.exitCode;
  if(Number.isInteger(application)) return application<0?((application%256)+256)%256:application>255?application%256:application;
  return fallback;
}

async function* jsonLines(stream,{signal,maxLineBytes=CLI_INPUT_LIMIT}={}) {
  let pending=Buffer.alloc(0);
  const abort=()=>stream.destroy(Object.assign(new Error('Session input aborted'),{code:'ABORTED'}));
  signal?.addEventListener('abort',abort,{once:true});
  try{
    if(signal?.aborted)throw Object.assign(new Error('Session input aborted'),{code:'ABORTED'});
    for await(const chunk of stream){
      const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      let offset=0;
      for(let index=data.indexOf(10);index>=0;index=data.indexOf(10,offset)){
        if(pending.length+index-offset>maxLineBytes)throw cliError(`JSON request exceeds ${maxLineBytes} bytes.`,'INPUT_LIMIT');
        const line=Buffer.concat([pending,data.subarray(offset,index)]).toString('utf8');
        pending=Buffer.alloc(0); offset=index+1;
        if(line.trim())yield line;
      }
      if(pending.length+data.length-offset>maxLineBytes)throw cliError(`JSON request exceeds ${maxLineBytes} bytes.`,'INPUT_LIMIT');
      pending=Buffer.concat([pending,data.subarray(offset)]);
    }
    if(pending.toString('utf8').trim())yield pending.toString('utf8');
  }finally{signal?.removeEventListener('abort',abort);}
}

/** Run a command using injectable streams; returns the process exit status. */
export async function runCli(argv, io = {}) {
  const input=io.stdin || process.stdin, output=io.stdout || process.stdout, errorOutput=io.stderr || process.stderr;
  const cwd=resolve(io.cwd || process.cwd());
  const controller=new AbortController();
  const signal=controller.signal;
  let interrupted=null, compiler, compilerPromise, session;
  let options={json:argv.includes('--json')}, command;
  const write=async(stream,text)=>{
    if(!text)return;
    if(stream.destroyed)throw Object.assign(new Error('Output pipe closed'),{code:'EPIPE'});
    await new Promise((yes,no)=>{stream.write(text,error=>error?no(error):yes());});
  };
  const stderr=text=>errorOutput.write(String(text));
  const interrupt=code=>{interrupted=code;controller.abort();compiler?.dispose();};
  const onInt=()=>interrupt(130),onTerm=()=>interrupt(143),onOuterAbort=()=>interrupt(130);
  const onPipeError=error=>{if(error.code==='EPIPE')interrupt(0);};
  if(io.signals!==false){process.once('SIGINT',onInt);process.once('SIGTERM',onTerm);}
  io.signal?.addEventListener('abort',onOuterAbort,{once:true});
  if(io.signal?.aborted)onOuterAbort();
  output.on('error',onPipeError);
  if(errorOutput!==output)errorOutput.on('error',onPipeError);
  let stdinPromise;
  const context={cwd,signal,stderr,stdinText:()=>stdinPromise ||= readStdin(input,{signal}),getCompiler:async()=>{
    compilerPromise ||= (async()=>{
      const {createRoslyn}=await import('../node/index.js');
      compiler=await createRoslyn({baseUrl:options.runtime?resolve(cwd,options.runtime):undefined,timeoutMs:options.timeoutMs??30000,startupTimeoutMs:options.startupTimeoutMs??300000,signal,
        onEvent:event=>{if(options.events)stderr(JSON.stringify({event:encodeJson(event)})+'\n');else if(options.verbose && event.type==='progress')stderr(`[${event.stage}] ${event.message || ''}\n`);},
        onWorkerOutput:text=>stderr(text),
      });
      const {prepareCompiler}=await import('./commands.mjs');
      const restore=compiler.restore.bind(compiler);
      compiler.restore=(requests,restoreOptions={})=>restore(requests,isCliRestoreOptions(restoreOptions)?restoreOptions:createRestoreOptions({...options,restoreOptions},context));
      await prepareCompiler(compiler,options,context);
      return compiler;
    })();
    return compilerPromise;
  }};
  async function resetCompiler(){if(compiler)await compiler.close();compiler=undefined;compilerPromise=undefined;}
  async function emitResult(value,{json=options.json,output:human}={}){
    if(json)await write(output,stringifyJson(value)+'\n');
    else{
      if(human!==undefined)await write(output,human);
      else if(typeof value?.stdout==='string')await write(output,value.stdout);
      else if(value!==undefined)await write(output,stringifyJson(value,2)+'\n');
      if(value?.stderr)await write(errorOutput,value.stderr);
      for(const diagnostic of value?.diagnostics || value?.assembly?.diagnostics || []){
        const location=diagnostic.path?`${diagnostic.path}${diagnostic.startLine?`(${diagnostic.startLine},${diagnostic.startColumn})`:''}: `:'';
        await write(errorOutput,`${location}${diagnostic.severity || 'error'} ${diagnostic.id || diagnostic.code || ''}: ${diagnostic.message}\n`);
      }
      if(value?.success===false && value.error)await write(errorOutput,`${value.error.code || value.error.type || 'Error'}: ${value.error.message || value.error}\n`);
    }
  }
  try{
    const parsed=parseCli(argv);({command,options}=parsed);const {positionals,watchCommand:watched}=parsed;
    context.command=watched || command;
    if(options.version){const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));await write(output,options.json?JSON.stringify({name:pkg.name,version:pkg.version})+'\n':pkg.version+'\n');return 0;}
    if(options.help || command==='help'){await write(output,helpText(command));return 0;}
    if(command==='serve'){
      const {startServer}=await import('./serve.mjs');
      const server=await startServer(options,context);
      try{
        await emitResult({success:true,url:server.url,root:server.root},{output:`RoslynWeb: ${server.url}\n`});
        if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      }finally{await server.close();}
      return interrupted ?? 0;
    }
    if(['api','batch','session'].includes(command)){
      session=createApiSession({getCompiler:context.getCompiler,cwd,signal,maxResults:options.maxResults,maxResultBytes:options.maxResultBytes});
      let exitCode=0;
      const dispatch=async(request)=>{
        const result=await session.dispatch(request);
        await write(output,JSON.stringify(result)+'\n');
        const code=exitCodeFor(result);if(code)exitCode=code;
        return result.success;
      };
      const parse=string=>{try{return JSON.parse(string);}catch(error){throw cliError(error.message,'INVALID_JSON');}};
      if(command==='session'){
        if(positionals.length>1)throw cliError('session accepts at most one JSON-lines input file.');
        const stream=positionals[0] && positionals[0]!=='-'?createReadStream(resolve(cwd,positionals[0])):input;
        try{
          for await(const line of jsonLines(stream,{signal,maxLineBytes:options.maxLineBytes})){
            let request;
            try{request=parse(line);}catch(error){await write(output,JSON.stringify({id:null,success:false,error:serializeError(error)})+'\n');exitCode=2;if(options.stopOnError)break;continue;}
            if(!await dispatch(request) && options.stopOnError)break;
            if(signal.aborted)break;
          }
        }finally{if(stream!==input || options.stopOnError)stream.destroy();}
      }else{
        if(positionals.length>1 || (positionals.length && options.request))throw cliError(`${command} accepts one JSON input file or --request.`);
        const path=options.request || positionals[0];
        const request=parse(path && path!=='-'?new TextDecoder().decode(await readInputBytes(path,cwd)):await context.stdinText());
        if(command==='batch'){
          if(!Array.isArray(request))throw cliError('batch input must be a JSON array.');
          for(const item of request){if(!await dispatch(item) && options.stopOnError)break;}
        }else await dispatch(request);
      }
      return interrupted ?? exitCode;
    }
    if(command==='script'){
      if(positionals.length!==1)throw cliError('script requires a Node ES module path.');
      const module=await import(pathToFileURL(resolve(cwd,positionals[0])).href);
      if(typeof module.default!=='function')throw cliError('Script must export a default function accepting { compiler, args, cwd, signal }.');
      const result=await module.default({compiler:await context.getCompiler(),args:options.args,cwd,signal});
      if(result!==undefined)await emitResult(result);
      return interrupted ?? exitCodeFor(result);
    }
    const {executeCommand}=await import('./commands.mjs');
    if(command==='watch'){
      const {watchCommand}=await import('./watch.mjs');
      await watchCommand(watched,positionals,options,context,async({iteration,changed})=>{
        if(compiler?.disposed || changed.some(path=>!['.cs','.resx'].includes(extname(path).toLowerCase())))await resetCompiler();
        try{
          const result=await executeCommand(watched,positionals,options,context);
          await emitResult(options.json?{iteration,changed,...result.result}:result.result,{output:result.output});
          return result.result?.outputs;
        }catch(error){if(!signal.aborted)await emitResult({success:false,error:serializeError(error)});}
      });
      return interrupted ?? 0;
    }
    const result=await executeCommand(command,positionals,options,context);
    await emitResult(result.result,{output:result.output});
    return interrupted ?? exitCodeFor({...result.result,...(Number.isInteger(result.exitCode)?{exitCode:result.exitCode}:{})});
  }catch(error){
    if(error.code==='EPIPE')return 0;
    if(interrupted!==null)return interrupted;
    const result={success:false,error:serializeError(error)};
    try{if(options.json || ['api','batch','session'].includes(command))await write(output,JSON.stringify(result)+'\n');else await write(errorOutput,`${result.error.code || 'Error'}: ${result.error.message}\n`);}catch{}
    return exitCodeFor(error);
  }finally{
    controller.abort();
    await session?.dispose();
    try{if(compiler)await compiler.close();else if(compilerPromise){const instance=await compilerPromise;await instance.close();}}catch{}
    process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);
    io.signal?.removeEventListener('abort',onOuterAbort);
    output.removeListener('error',onPipeError);
    if(errorOutput!==output)errorOutput.removeListener('error',onPipeError);
  }
}
