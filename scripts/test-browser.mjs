// Optional local browser test runner. Install Playwright separately: npm install --no-save playwright.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = await import('playwright');
const root = fileURLToPath(new URL('../',import.meta.url));
const server = spawn(process.execPath,['scripts/serve.mjs'],{cwd:root,env:{...process.env,PORT:'8189'},stdio:'pipe'});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',c=>reject(new Error('Server exited: '+c)));});
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:8189/tests/browser.html');
 await page.waitForFunction(()=>document.documentElement.dataset.complete==='true'||document.querySelector('#status').textContent==='BOOT FAILED',{},{timeout:180000});
 console.log(await page.locator('body').innerText());
 const failureCount=await page.locator('html').getAttribute('data-failures');
 if(failureCount!== '0')process.exitCode=1;
} finally {await browser.close();server.kill();}
