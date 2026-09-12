// Deterministic decimal strings, syntax/style combinations, and exact IEEE rounding boundaries.
export function createFloatParseInputs(){
let seed=0x431949a7;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
const inputs=[];function item(text,style=167){inputs.push({text,style});}
for(let i=0;i<6000;i++){let text='';for(let j=0,n=random()%100+1;j<n;j++)text+=String(random()%10);const point=random()%(text.length+1);text=text.slice(0,point)+'.'+text.slice(point);item((random()%2?'-':'')+text+'e'+((random()%900)-450));}
for(const prefix of ['','+','-','(', ' ', '- ', '¤', '¤-', '-¤','(¤'])for(const number of ['1','1.5','.5','1,,2,','0','-0','NaN','Infinity'])for(const suffix of ['',')','-','+',' ',' ¤','¤','\0','\0 ','e+1','e-1',' e1'])item(prefix+number+suffix,random()%512);
function rational(bits,width){const frac=width===32?23:52,bias=width===32?127:1023,exp=Number((bits>>BigInt(frac))&BigInt(width===32?255:2047)),m=(bits&((1n<<BigInt(frac))-1n))+(exp?1n<<BigInt(frac):0n),shift=(exp?exp-bias:1-bias)-frac;return{m,p:shift};}
function boundary(a,b,width){const x=rational(a,width),y=rational(b,width),power=Math.min(x.p,y.p)-1;let n=(x.m<<BigInt(x.p-power-1))+(y.m<<BigInt(y.p-power-1)),scale=0;if(power>=0)n<<=BigInt(power);else{scale=-power;n*=5n**BigInt(scale);}const digits=n.toString();return {digits,scale};}
for(const width of [32,64])for(let k=0;k<180;k++){const max=width===32?0x7f7fffffn:0x7fefffffffffffffn;let bits=width===32?BigInt(random())%max:((BigInt(random())<<32n)|BigInt(random()))%max;if(k===0)bits=0n;else if(k===1)bits=1n;else if(k===2)bits=max-1n;const {digits,scale}=boundary(bits,bits+1n,width);for(const delta of [-1n,0n,1n]){const s=(BigInt(digits)*1000n+delta).toString();item(s+'e-'+(scale+3));item('-'+s+'e-'+(scale+3));}}
return inputs;
}
