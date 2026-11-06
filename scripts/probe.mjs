import { hostClient } from './host-client.mjs';
const client=await hostClient();
const response=await client.post('/api/super-bot-probe');
const result=await response.json();
console.log(JSON.stringify(result,null,2));
if(!response.ok||!result.ok)process.exitCode=1;
