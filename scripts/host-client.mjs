/** Authenticate only against the dedicated host URL; never print credentials. */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
export async function hostClient(logPath='.runtime/host.log') {
  const log=await readFile(logPath,'utf8');
  const match=log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
  assert.ok(match,'dedicated host has not announced a URL');
  const base=new URL(match[1]).origin;const cookies=new Map();let url=match[1];
  for(let n=0;n<5;n++) {
    const response=await fetch(url,{redirect:'manual',headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}});
    for(const cookie of response.headers.getSetCookie()) {const [pair]=cookie.split(';');const i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
    const location=response.headers.get('location');if(!location)break;url=new URL(location,url).href;
    assert.equal(new URL(url).origin,base,'authentication stays on dedicated host');
  }
  return {base,post:async(path,body={})=>fetch(base+path,{method:'POST',headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),origin:base,'content-type':'application/json'},body:JSON.stringify(body)})};
}
