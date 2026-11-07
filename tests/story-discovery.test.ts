import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StoryDiscovery, parseDiscovery } from '../packages/providers/src/discovery.ts';
import { canonicalStoryUrl } from '../packages/domain/src/story-url.ts';
import { Store } from '../packages/storage/src/store.ts';
import { StoryRepository } from '../packages/storage/src/story-repository.ts';
import { AppError } from '../packages/contracts/src/errors.ts';

const searchData = { Code:0,Message:'success',Data:{ Items:[
  { Title:'雨夜故事',Url:'https://www.xiaohongshu.com/explore/123?utm_source=tracking',AuthorName:'小王',ContentText:'相遇',ContentType:'Note' },
  { Title:'混入异站',Url:'https://www.zhihu.com/question/456',AuthorName:'作者',ContentText:'其他',ContentType:'Answer' },
] } };

test('discovery compiles the official endpoint, timestamp, Bearer token and site filter', async () => {
  let received: URL | undefined;
  const client = new StoryDiscovery(()=>'private-test-secret', async (input, init) => {
    received = new URL(String(input));
    const headers = init?.headers as Record<string,string>;
    assert.equal(headers.Authorization, 'Bearer private-test-secret');
    assert.equal(headers['X-Request-Timestamp'], '1700000000');
    return new Response(JSON.stringify(searchData),{status:200,headers:{'content-type':'application/json'}});
  },()=>1700000000000);
  const hits = await client.search('xiaohongshu','反转故事');
  assert.equal(received?.hostname,'developer.zhihu.com');
  assert.equal(received?.pathname,'/api/v1/content/global_search');
  assert.equal(received?.searchParams.get('Filter'),'host=="xiaohongshu.com"');
  assert.equal(received?.searchParams.get('Query'),'反转故事');
  assert.equal(hits.length,1);
  assert.equal(hits[0]?.url,'https://www.xiaohongshu.com/explore/123');
});

test('discovery does not leak credentials when upstream fails or is unconfigured', async () => {
  const empty = new StoryDiscovery(()=>'');
  await assert.rejects(()=>empty.search('zhihu','hello'),(error:unknown)=>error instanceof AppError && error.code==='DISCOVERY_NOT_CONFIGURED');
  const denied = new StoryDiscovery(()=>'private-test-secret',async()=>new Response('unauthorized',{status:401}));
  await assert.rejects(()=>denied.search('zhihu','hello'),(error:unknown)=>error instanceof AppError && !error.message.includes('private-test-secret'));
});

test('source URLs are canonicalized and duplicate provenance is rejected', t => {
  const root = mkdtempSync(join(tmpdir(),'owntake-discovery-'));
  const store = new Store({dataDir:join(root,'data'),projectsDir:join(root,'projects')});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  assert.equal(canonicalStoryUrl('https://example.com/a?utm_source=test&b=1'),'https://example.com/a?b=1');
  const repo = new StoryRepository(store);
  const story = { title:'故事',genre:'',summary:'',tags:[],beats:[],
    source:{platform:'manual',url:'https://example.com/a?b=1',author:'',title:'故事',rights:'inspiration_only'} };
  repo.create(story);
  assert.throws(()=>repo.create({...story,source:{...story.source,url:'https://example.com/a?b=1&utm_campaign=source'}}),
    (error:unknown)=>error instanceof AppError && error.code==='STORY_ALREADY_SAVED');
  assert.equal(repo.list().length,1);
  assert.equal(parseDiscovery('xiaohongshu',searchData).length,1);
});
