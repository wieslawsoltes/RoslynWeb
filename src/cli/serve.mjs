import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8' };
export async function startServer(options = {}, context = {}) {
  const root = await realpath(resolve(context.cwd || process.cwd(), options.root || fileURLToPath(new URL('../../',import.meta.url))));
  if(!(await stat(root)).isDirectory()) throw new Error('Server root must be a directory.');
  const within = path => {const rel=relative(root,path);return !isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep);};
  const server=createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
      let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(p=>p.startsWith('.'))) throw new Error('Invalid path');
      if(pathname==='/') pathname=options.root?'/index.html':'/demo/index.html';
      let file=resolve(root,'.'+pathname);
      if(!within(file)) throw new Error('Invalid path');
      if((await stat(file)).isDirectory()) file=resolve(file,'index.html');
      file=await realpath(file);
      if(!within(file) || relative(root,file).split(sep).some(p=>p.startsWith('.'))) throw new Error('Invalid path');
      const content=await readFile(file);
      res.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Content-Length':content.byteLength,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:content);
    }catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');}
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(options.port??8080,options.host||'127.0.0.1',()=>{server.removeListener('error',no);yes();});});
  const address=server.address();
  const host=address.address.includes(':')?`[${address.address}]`:address.address;
  const close=()=>new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
  return {root,url:`http://${host}:${address.port}/`,server,close};
}
