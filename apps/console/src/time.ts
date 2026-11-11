const OFFSET_MS=8*60*60*1000;
const SUFFIX="（UTC+08:00）";

/** Display only. Protocol timestamps and signed payloads must remain unchanged. */
export function formatBeijingTime(value:unknown):string{
  if(value===null||value===undefined||value==="")return "—";
  let milliseconds:number;
  if(typeof value==="number")milliseconds=Math.abs(value)<1e11?value*1000:value;
  else if(typeof value==="string"&&/^\d+(?:\.\d+)?$/.test(value)){
    const number=Number(value);
    milliseconds=Math.abs(number)<1e11?number*1000:number;
  }else if(value instanceof Date)milliseconds=value.getTime();
  else if(typeof value==="string")milliseconds=Date.parse(value);
  else return "—";
  if(!Number.isFinite(milliseconds))return "—";
  const date=new Date(milliseconds+OFFSET_MS);
  if(Number.isNaN(date.getTime()))return "—";
  const pad=(n:number)=>String(n).padStart(2,"0");
  return `${date.getUTCFullYear()}年${pad(date.getUTCMonth()+1)}月${pad(date.getUTCDate())}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${SUFFIX}`;
}
