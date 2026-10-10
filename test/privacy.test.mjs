import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('synthetic privacy canaries stay out of stdout/stderr and snapshot filenames across failure paths', async () => {
  const root = new URL('../.scratch/public-release/', import.meta.url);
  await mkdir(root, {recursive: true});
  const dir = await mkdtemp(join(root.pathname, 'privacy-'));
  try {
    const demoUrl = new URL('../src/demo.mjs', import.meta.url).href;
    const snapshotUrl = new URL('../src/snapshot.mjs', import.meta.url).href;
    const script = `import {createDemo} from ${JSON.stringify(demoUrl)};
      import {FileSnapshots} from ${JSON.stringify(snapshotUrl)};
      import {readdir,writeFile} from 'node:fs/promises';
      const canary='FICTIONAL_CONTENT_CANARY', secret='FICTIONAL_SECRET_CANARY_0000000000000000';
      const policy={tenantId:'synthetic',privateUsers:['101'],groups:{}};
      const request=(n=1)=>({method:'POST',path:'/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':secret},
        body:Buffer.from(JSON.stringify({update_id:n,message:{message_id:1,chat:{id:101,type:'private'},
          from:{id:101,is_bot:false},text:canary}}))});
      const d=createDemo({secret,policy}); await d.ingress(request()); await d.drain();
      await d.ingress({...request(),headers:{}});
      await d.ingress(request(2)); policy.privateUsers=[]; await d.drain(); policy.privateUsers=['101'];
      for(const provider of [{runTurn:async()=>{throw Error(canary+secret)}},{runTurn:()=>new Promise(()=>{})}]) {
        const e=createDemo({secret,policy,provider,timeoutMs:5}); await e.ingress(request()); await e.drain();
      }
      const stateKey=d.outputs()[0].turnId;
      const snapshots=new FileSnapshots(process.argv[1]);
      // Filename is a validated digest, never a message, identity or error.
      await snapshots.save(stateKey,{version:1,revision:0,epoch:0,lease:null,memoryMarkdown:canary,order:[],turns:{}});
      const files=await readdir(process.argv[1]); if(files.some(f=>f.includes(canary)||f.includes(secret))) throw Error('filename leak');
      await writeFile(process.argv[1]+'/'+stateKey+'.json','broken');
      try { await snapshots.load(stateKey); } catch {}
      process.stdout.write('privacy_cases_complete');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], {encoding: 'utf8'});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'privacy_cases_complete');
    assert.equal(result.stderr, '');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
