import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'roslynweb-msbuild-'));
try {
 const sdk=process.env.DOTNET||'dotnet';
 const version=execFileSync(sdk,['--version'],{encoding:'utf8'}).trim();
 execFileSync(sdk,['msbuild',resolve('tests/fixtures/projects-v4.proj'),'-nologo','-v:quiet','-t:Build',`-p:OutputDir=${dir}`],{stdio:'inherit'});
 const files={};for(const name of ['properties.txt','red.txt','blue.txt','target-a.txt','target-b.txt','target-c.txt'])files[name]=(await readFile(join(dir,name),'utf8')).replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
 await writeFile('tests/fixtures/projects-v4-native.json',JSON.stringify({environment:`Native dotnet msbuild, SDK ${version}`,fixture:'projects-v4.proj',files},null,2)+'\n');
 execFileSync(sdk,['msbuild',resolve('tests/fixtures/projects-v4-regressions.proj'),'-nologo','-v:quiet',`-p:OutputDir=${dir}`],{stdio:'inherit'});
 const regressionFiles={};for(const name of ['condition.txt','qualified-red.txt','qualified-blue.txt','escaping.txt','removed.txt'])regressionFiles[name]=(await readFile(join(dir,name),'utf8')).replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
 const rejections=[{expression:"$([MSBuild]::BitwiseOr(4294967296,1))",code:'MSB4186'},{expression:"$([MSBuild]::BitwiseNot(-2147483649))",code:'MSB4186'},{task:'<Message Text="x" Bogus="x"/>',code:'MSB4064'}];
 for(const [index,rejection] of rejections.entries()){
  const path=join(dir,`rejection-${index}.proj`);await writeFile(path,rejection.expression?`<Project><PropertyGroup><P>${rejection.expression}</P></PropertyGroup></Project>`:`<Project DefaultTargets="Build"><Target Name="Build">${rejection.task}</Target></Project>`);
  let rejected=false;try{execFileSync(sdk,['msbuild',path,'-nologo','-v:quiet'],{encoding:'utf8'});}catch(error){const text=String(error.stdout)+String(error.stderr);if(!text.includes(rejection.code))throw error;rejected=true;}if(!rejected)throw new Error('Native MSBuild unexpectedly accepted '+JSON.stringify(rejection));
 }
 await writeFile('tests/fixtures/projects-v4-regressions-native.json',JSON.stringify({environment:`Native dotnet msbuild, SDK ${version}`,fixture:'projects-v4-regressions.proj',files:regressionFiles,rejections},null,2)+'\n');
}finally {await rm(dir,{recursive:true,force:true});}
