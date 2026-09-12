/** Exact tick/calendar services for the managed DateTime and TimeSpan value types.
 * Clock reads use the JavaScript host's clock and local time zone. Calendar and
 * interval arithmetic never depend on Date normalization or millisecond storage.
 */
import {ManagedException,Numeric,i4,i8,r8} from './runtime.mjs';
import {ILExecutionError} from './capabilities.mjs';

const DT='System.DateTime', TS='System.TimeSpan', I='System.Int32', L='System.Int64', D='System.Double', B='System.Boolean', O='System.Object', S='System.String', K='System.DateTimeKind';
const MS=10000n, SECOND=10000000n, MINUTE=600000000n, HOUR=36000000000n, DAY=864000000000n;
const UNIX=621355968000000000n, MAX_DATE=3155378975999999999n, MIN_LONG=-(1n<<63n), MAX_LONG=(1n<<63n)-1n;
const units={Days:DAY,Hours:HOUR,Minutes:MINUTE,Seconds:SECOND,Milliseconds:MS,Microseconds:10n,Ticks:1n};
const raw=v=>v?.$byref?raw(v.get()):v?.$box?raw(v.value):v instanceof Numeric?v.value:v;
const fail=(type,message)=>{throw new ManagedException('System.'+type,message);};
const done=value=>({handled:true,value});
const signatures=new Map();
function admit(t,n,s,r,...p){const key=[t,n,s,r].join('|');if(!signatures.has(key))signatures.set(key,new Set());signatures.get(key).add(p.join('|'));}
for(const t of [DT,TS]){
  admit(t,'.ctor',false,'System.Void',L);
  admit(t,'get_Ticks',false,L);admit(t,'GetHashCode',false,I);
  for(const p of [t,O]){admit(t,'Equals',false,B,p);admit(t,'CompareTo',false,I,p);}
  admit(t,'Compare',true,I,t,t);admit(t,'Equals',true,B,t,t);
  for(const n of ['Equality','Inequality','GreaterThan','GreaterThanOrEqual','LessThan','LessThanOrEqual'])admit(t,'op_'+n,true,B,t,t);
  for(const n of ['Add','Subtract'])admit(t,n,false,t,TS);
  for(const n of ['Addition','Subtraction'])admit(t,'op_'+n,true,t,t,TS);
}
for(const n of [3,4,5,6])admit(TS,'.ctor',false,'System.Void',...Array(n).fill(I));
for(const n of ['Days','Hours','Minutes','Seconds','Milliseconds','Microseconds','Nanoseconds'])admit(TS,'get_'+n,false,I);
for(const n of ['Days','Hours','Minutes','Seconds','Milliseconds','Microseconds','Nanoseconds'])admit(TS,'get_Total'+n,false,D);
for(const n of ['Days','Hours','Minutes','Seconds','Milliseconds','Microseconds'])admit(TS,'From'+n,true,TS,D);
admit(TS,'FromTicks',true,TS,L);
for(const [n,ps] of [['Days',[I,I,L,L,L,L]],['Hours',[I,L,L,L,L]],['Minutes',[L,L,L,L]],['Seconds',[L,L,L]],['Milliseconds',[L,L]],['Microseconds',[L]]]){
  admit(TS,'From'+n,true,TS,ps[0]);if(ps.length>1)admit(TS,'From'+n,true,TS,...ps);
}
for(const n of ['Negate','Duration'])admit(TS,n,false,TS);
for(const n of ['UnaryNegation','UnaryPlus'])admit(TS,'op_'+n,true,TS,TS);
admit(TS,'ToString',false,S);admit(TS,'ToString',false,S,S);admit(TS,'ToString',false,S,S,'System.IFormatProvider');
for(const n of ['Multiply','Divide'])admit(TS,n,false,TS,D);
admit(TS,'Divide',false,D,TS);admit(TS,'op_Multiply',true,TS,TS,D);admit(TS,'op_Multiply',true,TS,D,TS);admit(TS,'op_Division',true,TS,TS,D);admit(TS,'op_Division',true,D,TS,TS);
admit(DT,'.ctor',false,'System.Void',L,K);
for(const n of [3,6,7,8])admit(DT,'.ctor',false,'System.Void',...Array(n).fill(I));
for(const n of [6,7,8])admit(DT,'.ctor',false,'System.Void',...Array(n).fill(I),K);
for(const n of ['Year','Month','Day','DayOfYear','Hour','Minute','Second','Millisecond','Microsecond','Nanosecond'])admit(DT,'get_'+n,false,I);
admit(DT,'get_DayOfWeek',false,'System.DayOfWeek');admit(DT,'get_Kind',false,K);admit(DT,'get_Date',false,DT);admit(DT,'get_TimeOfDay',false,TS);
for(const n of ['Now','UtcNow','Today'])admit(DT,'get_'+n,true,DT);
for(const n of ['Days','Hours','Minutes','Seconds','Milliseconds','Microseconds'])admit(DT,'Add'+n,false,DT,D);
admit(DT,'AddTicks',false,DT,L);admit(DT,'AddMonths',false,DT,I);admit(DT,'AddYears',false,DT,I);
admit(DT,'SpecifyKind',true,DT,DT,K);admit(DT,'IsLeapYear',true,B,I);admit(DT,'DaysInMonth',true,I,I,I);
admit(DT,'Subtract',false,TS,DT);admit(DT,'op_Subtraction',true,TS,DT,DT);

export function isTemporalValueType(type){return type===DT||type===TS;}
export function defaultTemporalValue(type){return isTemporalValueType(type)?value(type,0n):undefined;}
export function isTemporalBuiltin(ref){return !!ref&&(ref.genericParameterCount??0)===0&&!ref.genericArguments?.length&&(signatures.get([ref.declaringType,ref.name,ref.isStatic,ref.returnType].join('|'))?.has((ref.parameters??[]).map(p=>p.type??p).join('|'))??false);}
export function isTemporalField(ref){return !!ref&&ref.isStatic!==false&&ref.type===ref.declaringType&&(ref.declaringType===DT&&['MinValue','MaxValue','UnixEpoch'].includes(ref.name)||ref.declaringType===TS&&['MinValue','MaxValue','Zero'].includes(ref.name));}
export function temporalField(ref){if(!isTemporalField(ref))return undefined;const dt=ref.declaringType===DT;return value(ref.declaringType,ref.name==='MaxValue'?(dt?MAX_DATE:MAX_LONG):ref.name==='MinValue'?(dt?0n:MIN_LONG):ref.name==='UnixEpoch'?UNIX:0n,ref.name==='UnixEpoch'?1:0);}
function value(type,ticks,kind=0,rangeError){ticks=BigInt(ticks);if(type===DT?(ticks<0n||ticks>MAX_DATE):(ticks<MIN_LONG||ticks>MAX_LONG))fail(rangeError??(type===DT?'ArgumentOutOfRangeException':'OverflowException'),'The resulting date or interval is outside its supported range.');return {$type:type,$valueType:true,fields:{},$ticks:ticks,$kind:type===DT?kind:0};}
function leap(y){if(y<1||y>9999)fail('ArgumentOutOfRangeException','year');return y%4===0&&(y%100!==0||y%400===0);}
function monthDays(y,m){if(m<1||m>12)fail('ArgumentOutOfRangeException','month');return [31,leap(y)?29:28,31,30,31,30,31,31,30,31,30,31][m-1];}
const starts=[0,31,59,90,120,151,181,212,243,273,304,334];
function calendarTicks(y,m,d,h=0,min=0,s=0,ms=0,us=0){if(d<1||d>monthDays(y,m)||h<0||h>23||min<0||min>59||s<0||s>59||ms<0||ms>999||us<0||us>999)fail('ArgumentOutOfRangeException','Date/time components are outside their supported range.');const a=y-1,days=a*365+Math.floor(a/4)-Math.floor(a/100)+Math.floor(a/400)+starts[m-1]+(m>2&&leap(y)?1:0)+d-1;return BigInt(days)*DAY+BigInt(h)*HOUR+BigInt(min)*MINUTE+BigInt(s)*SECOND+BigInt(ms)*MS+BigInt(us)*10n;}
function parts(t){let n=Number(t/DAY);const dow=(n+1)%7,y400=Math.floor(n/146097);n-=y400*146097;let y100=Math.min(3,Math.floor(n/36524));n-=y100*36524;const y4=Math.floor(n/1461);n-=y4*1461;const y1=Math.min(3,Math.floor(n/365));n-=y1*365;const year=y400*400+y100*100+y4*4+y1+1,dayOfYear=n+1;let month=1;while(n>=monthDays(year,month)){n-=monthDays(year,month);month++;}return{Year:year,Month:month,Day:n+1,DayOfYear:dayOfYear,DayOfWeek:dow,Hour:Number(t/HOUR%24n),Minute:Number(t/MINUTE%60n),Second:Number(t/SECOND%60n),Millisecond:Number(t/MS%1000n),Microsecond:Number(t/10n%1000n),Nanosecond:Number(t%10n)*100};}
const validKind=k=>{if(k<0||k>2)fail('ArgumentException','Invalid DateTimeKind.');return k;};
// A Double cannot represent Int64.MaxValue; .NET explicitly maps its rounded
// 2^63 boundary back to MaxValue before converting the remaining finite values.
function intervalDouble(ticks){if(Number.isNaN(ticks)||ticks<Number(MIN_LONG)||ticks>Number(MAX_LONG))fail('OverflowException','TimeSpan overflowed because the duration is too long.');return ticks===Number(MAX_LONG)?MAX_LONG:BigInt(Math.trunc(ticks));}
function roundEven(n){if(!Number.isFinite(n)||Math.abs(n)>=2**52)return n;const f=Math.floor(n),r=n-f;return r<.5?f:r>.5?f+1:f%2===0?f:f+1;}
export function formatTemporalValue(v,format){v=raw(v);if(v?.$type===DT)throw new ILExecutionError('DateTime formatting is not implemented by the generated runtime; use explicit date/time components.',{runtimeLimitation:true});if(v?.$type!==TS)return undefined;if(format!=null&&format!==''&&!['c','t','T'].includes(format))throw new ILExecutionError('TimeSpan formatting currently supports the invariant c, t and T formats.',{runtimeLimitation:true});let t=v.$ticks,neg=t<0n;if(neg)t=-t;const d=t/DAY,h=t/HOUR%24n,m=t/MINUTE%60n,s=t/SECOND%60n,f=t%SECOND;return `${neg?'-':''}${d?`${d}.`:''}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${f?'.'+String(f).padStart(7,'0'):''}`;}

export function invokeTemporalBuiltin(rt,ref,args,self,kind){
  const receiver=raw(self);
  if(isTemporalValueType(receiver?.$type)&&ref.isStatic===false&&['System.Object','System.ValueType','System.IComparable',`System.IComparable`+'`1<'+receiver.$type+'>',`System.IEquatable`+'`1<'+receiver.$type+'>'].includes(ref.declaringType))ref={...ref,declaringType:receiver.$type};
  if(!isTemporalBuiltin(ref))return{handled:false};
  const selfRef=self?.$byref?self:null;self=raw(self);const a=args.map(raw),t=ref.declaringType,n=ref.name,span=t===TS,p=(ref.parameters??[]).map(p=>p.type??p),make=(ticks,k=self?.$kind??0,err)=>value(t,ticks,k,err);
  if(n==='.ctor'){
    let ticks,k=0;
    // The .NET 10 multi-component constructor accumulates signed Int64
    // microseconds before range validation; preserve that unchecked accumulation.
    if(span){if(a.length===1)ticks=BigInt(a[0]);else{const c=a.length===3?[0,...a]:a;ticks=BigInt(c[0])*DAY+BigInt(c[1])*HOUR+BigInt(c[2])*MINUTE+BigInt(c[3])*SECOND+BigInt(c[4]??0)*MS+BigInt(c[5]??0)*10n;if(a.length!==3)ticks=BigInt.asIntN(64,ticks/10n)*10n;}}
    else if(a.length<=2){ticks=BigInt(a[0]);k=validKind(Number(a[1]??0));}else{const c=[...a];if(p.at(-1)===K)k=validKind(Number(c.pop()));ticks=calendarTicks(...c);}
    const v=make(ticks,k,'ArgumentOutOfRangeException');if(kind==='newobj'&&!self)return{handled:true,constructed:v};if(selfRef)selfRef.set(v);else Object.assign(self,v);return done();
  }
  if(!span&&['get_Now','get_UtcNow','get_Today'].includes(n)){const ms=Date.now(),utc=n==='get_UtcNow',clock=new Date(ms);let ticks=BigInt(ms)*MS+UNIX;if(!utc)ticks=calendarTicks(clock.getFullYear(),clock.getMonth()+1,clock.getDate(),clock.getHours(),clock.getMinutes(),clock.getSeconds(),clock.getMilliseconds());if(n==='get_Today')ticks-=ticks%DAY;return done(make(ticks,utc?1:2));}
  if(n==='SpecifyKind')return done(make(a[0].$ticks,validKind(Number(a[1]))));
  if(n==='IsLeapYear')return done(i4(leap(a[0])));if(n==='DaysInMonth')return done(i4(monthDays(...a)));
  if(span&&n.startsWith('From')){const u=units[n.slice(4)];let ticks;if(p[0]===D){if(Number.isNaN(a[0]))fail('ArgumentException','TimeSpan does not accept NaN.');ticks=intervalDouble(a[0]*Number(u));}else{const allUnits=[DAY,HOUR,MINUTE,SECOND,MS,10n],start=allUnits.indexOf(u);ticks=a.length===1?BigInt(a[0])*u:a.reduce((sum,v,i)=>sum+BigInt(v)*allUnits[start+i],0n);if(n!=='FromTicks'&&(ticks<MIN_LONG||ticks>MAX_LONG))fail('ArgumentOutOfRangeException','Interval is outside its supported range.');}return done(make(ticks));}
  if(n==='get_Ticks')return done(i8(self.$ticks));
  if(n==='GetHashCode')return done(i4(Number(BigInt.asIntN(32,self.$ticks^(self.$ticks>>32n)))));
  if(n.startsWith('get_')){const ticks=self.$ticks,q=n.slice(4);if(span){if(q==='Nanoseconds')return done(i4(Number(ticks%10n)*100));if(q.startsWith('Total')){const suffix=q.slice(5);let result=suffix==='Nanoseconds'?Number(ticks)*100:Number(ticks)/Number(units[suffix]);if(suffix==='Milliseconds')result=Math.max(Number(MIN_LONG/MS),Math.min(Number(MAX_LONG/MS),result));return done(r8(result));}const mod={Days:null,Hours:24n,Minutes:60n,Seconds:60n,Milliseconds:1000n,Microseconds:1000n}[q];let result=ticks/units[q];if(mod!==null)result%=mod;return done(i4(Number(result)));}if(q==='Kind')return done(i4(self.$kind));if(q==='Date')return done(make(ticks-ticks%DAY));if(q==='TimeOfDay')return done(value(TS,ticks%DAY));return done(i4(parts(ticks)[q]));}
  if(['Compare','CompareTo','Equals','op_Equality','op_Inequality','op_GreaterThan','op_GreaterThanOrEqual','op_LessThan','op_LessThanOrEqual'].includes(n)){
    const l=ref.isStatic?a[0]:self,r=ref.isStatic?a[1]:a[0];if(r==null)return done(i4(n==='Equals'?0:1));if(r.$type!==t){if(n==='Equals')return done(i4(0));fail('ArgumentException','Object must be of the same temporal type.');}const c=l.$ticks<r.$ticks?-1:l.$ticks>r.$ticks?1:0;return done(i4(({Compare:c,CompareTo:c,Equals:c===0,op_Equality:c===0,op_Inequality:c!==0,op_GreaterThan:c>0,op_GreaterThanOrEqual:c>=0,op_LessThan:c<0,op_LessThanOrEqual:c<=0})[n]));
  }
  if(['Negate','Duration','op_UnaryNegation','op_UnaryPlus'].includes(n)){const ticks=ref.isStatic?a[0].$ticks:self.$ticks;return done(make(n==='Duration'?ticks<0n?-ticks:ticks:n==='op_UnaryPlus'?ticks:-ticks));}
  if(['Add','Subtract','op_Addition','op_Subtraction'].includes(n)){const l=ref.isStatic?a[0]:self,r=ref.isStatic?a[1]:a[0],sub=n==='Subtract'||n==='op_Subtraction';return done(value(ref.returnType,l.$ticks+(sub?-r.$ticks:r.$ticks),l.$kind));}
  if(!span&&n.startsWith('Add')){let ticks=self.$ticks;if(n==='AddMonths'||n==='AddYears'){const amount=a[0]*(n==='AddYears'?12:1);if(amount< -120000||amount>120000)fail('ArgumentOutOfRangeException','months');const c=parts(ticks),index=c.Year*12+c.Month-1+amount,y=Math.floor(index/12),m=index-y*12+1;const d=Math.min(c.Day,monthDays(y,m));ticks=calendarTicks(y,m,d)+ticks%DAY;}else{const u=units[n.slice(3)],v=a[0];if(p[0]===L)ticks+=BigInt(v);else{if(!Number.isFinite(v)||Math.abs(v)>Number(MAX_DATE/u))fail('ArgumentOutOfRangeException','value');const whole=Math.trunc(v);/* Split before scaling so whole-unit ticks retain Int64 precision. */ticks+=BigInt(whole)*u+BigInt(Math.trunc((v-whole)*Number(u)));}}return done(make(ticks));}
  if(span&&['Multiply','Divide','op_Multiply','op_Division'].includes(n)){const left=ref.isStatic?a[0]:self,right=ref.isStatic?a[1]:a[0];if(ref.returnType===D)return done(r8(Number(left.$ticks)/Number(right.$ticks)));let ticks,factor;if(typeof left==='number'){factor=left;ticks=right.$ticks;}else{ticks=left.$ticks;factor=right;}if(Number.isNaN(factor))fail('ArgumentException','TimeSpan does not accept NaN.');const result=n==='Multiply'||n==='op_Multiply'?Number(ticks)*factor:Number(ticks)/factor;return done(make(intervalDouble(roundEven(result))));}
  if(span&&n==='ToString')return done(formatTemporalValue(self,a[0]));
  return{handled:false};
}
