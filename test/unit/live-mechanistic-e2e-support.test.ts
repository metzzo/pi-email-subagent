import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { parseFiniteEnv,parseLiveModel,parseLfJournal } from "../../scripts/live-mechanistic-e2e-support.ts";
describe('reusable live journal framing',()=>{
 it('validates finite model and timeout inputs',()=>{assert.deepEqual(parseLiveModel('openai-codex/gpt-5.6-luna'),{provider:'openai-codex',modelId:'gpt-5.6-luna'});assert.equal(parseFiniteEnv('30000',1),30000);assert.throws(()=>parseLiveModel('bad'),/provider\/model/);assert.throws(()=>parseFiniteEnv('1',1),/integer/);});
 it('parses production MailEvent JSONL and rejects truncation/malformed records',()=>{const at=new Date().toISOString();const email={id:'mail_test',from:'main@test.com',to:'main@test.com',subject:'n',message:'m',priority:'low',kind:'notification',requiresResponse:false,createdAt:at,deliveryState:'queued'};const line=JSON.stringify({type:'email.created',email});assert.equal(parseLfJournal(line+'\n').length,1);assert.throws(()=>parseLfJournal(line),/truncated/);assert.throws(()=>parseLfJournal('{bad}\n'),/Expected property/);});
});
