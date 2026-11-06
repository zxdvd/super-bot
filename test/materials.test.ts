import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { readMaterials } from '../src/materials.ts';

test('explicit references capture exact UTF-8 snapshots and reject invalid or oversized inputs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'super-bot-materials-'));try {
    const path=join(root,'guide.md');writeFileSync(path,'# 参考\n只处理明确授权的任务。\n');
    const [snapshot]=await readMaterials([path]);assert.match(snapshot!.text,/明确授权/);
    writeFileSync(path,'Changed later');assert.match(snapshot!.text,/明确授权/);assert.notEqual((await readMaterials([path]))[0]?.sha256,snapshot!.sha256);
    writeFileSync(path,Buffer.from([0xff,0xfe,0x00]));await assert.rejects(readMaterials([path]),/UTF-8/);
    writeFileSync(path,'x'.repeat(16385));await assert.rejects(readMaterials([path]),/16 KiB/);
    await assert.rejects(readMaterials(['relative.md']),/绝对/);await assert.rejects(readMaterials([join(root,'missing.md')]),/无法读取/);
    await assert.rejects(readMaterials([path,path,path,path,path]),/四份/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('named pipes are rejected without blocking a reference or evidence request',{skip:process.platform==='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'super-bot-pipe-'));try {
    const path=join(root,'pipe');execFileSync('mkfifo',[path]);
    const script=`import assert from 'node:assert/strict';import {readMaterials} from ${JSON.stringify(resolve('src/materials.ts'))};import {collectEvidence} from ${JSON.stringify(resolve('src/evidence.ts'))};await assert.rejects(readMaterials([${JSON.stringify(path)}]),/普通文件/);await assert.rejects(collectEvidence(${JSON.stringify(root)},[${JSON.stringify(path)}]),/普通文件/);`;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',timeout:2000});assert.equal(result.status,0,result.stderr||String(result.error));
  }finally{rmSync(root,{recursive:true,force:true});}
});
