import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScroller, scrollStep } from '../src/auto-scroll.js';

function fixture() {
  let time = 100000;
  const values = {}, executions = [], updates = [], alarms = new Set();
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const tab = { id: 42, url: 'https://x.com/home', title: 'Home / X', active: false, autoDiscardable: true };
  const settings = {paused:false, platforms:{x:true}};
  const api = {
    storage: {session:{get:async key => ({[key]:values[key]}),set:async data => Object.assign(values, structuredClone(data))},onChanged:event()},
    tabs: {get:async id => { assert.equal(id,42); return {...tab}; },update:async (id, patch) => {updates.push({id,...patch});Object.assign(tab,patch);},onUpdated:event(),onRemoved:event()},
    alarms: {create:async name => alarms.add(name),clear:async name => alarms.delete(name),onAlarm:event()},
    scripting: {executeScript:async request => {executions.push(request);return [{result:{moved:true}}];}},
  };
  const scroller = createAutoScroller(api, async () => settings, () => time);
  return {scroller, api, executions, updates, tab, settings, alarms, advance:ms => time+=ms};
}

test('auto-scroll targets the opted-in inactive tab, stops at deadline and restores discardability', async () => {
  const f=fixture();
  const run=await f.scroller.start(42,2);
  assert.equal(run.running,true); assert.equal(run.endsAt,220000);
  assert.equal(f.executions[0].target.tabId,42); assert.equal(f.tab.active,false);
  assert.equal(f.tab.autoDiscardable,false);
  await f.scroller.tick(); assert.equal(f.executions.length,2);
  f.advance(120000);
  assert.equal((await f.scroller.tick()).running,false);
  assert.equal(f.executions.length,2); assert.equal(f.tab.autoDiscardable,true); assert.equal(f.alarms.size,0);
});
test('auto-scroll requires valid duration and enabled supported site', async () => {
  const f=fixture();
  for(const n of [0,121,1.5,NaN,'5']) await assert.rejects(f.scroller.start(42,n),/whole number/);
  f.settings.paused=true; await assert.rejects(f.scroller.start(42,5),/Turn on saving/);
  f.settings.paused=false; f.tab.url='https://example.com/';
  await assert.rejects(f.scroller.start(42,5),/supported feed/);
  assert.equal(f.executions.length,0);
});
test('manual stop, settings pause and navigation prevent further scrolls', async () => {
  for (const reason of ['stop','paused','navigation']) {
    const f=fixture(); await f.scroller.start(42,5);
    if(reason==='stop') await f.scroller.stop();
    if(reason==='paused') f.settings.paused=true;
    if(reason==='navigation') f.tab.url='https://x.com/settings';
    assert.equal((await f.scroller.tick()).running,false);
    assert.equal(f.executions.length,1);
  }
});
test('stalled pages stop after a minute and injection errors restore tab settings', async () => {
  const f=fixture(); await f.scroller.start(42,5);
  f.api.scripting.executeScript=async()=>[{result:{moved:false}}];
  f.advance(60000); assert.match((await f.scroller.tick()).reason,/No more/);
  await f.scroller.start(42,5);
  f.api.scripting.executeScript=async()=>{throw new Error('No tab');};
  assert.equal((await f.scroller.tick()).running,false); assert.equal(f.tab.autoDiscardable,true);
});
test('worker restart resumes the same tab and expired injected steps do nothing', async () => {
  const f=fixture(); await f.scroller.start(42,5);
  const restarted=createAutoScroller(f.api,async()=>f.settings,()=>100001);
  assert.equal((await restarted.status()).tabId,42);
  assert.equal(f.executions.length,2);
  await restarted.stop(); await f.scroller.stop();
  assert.deepEqual(scrollStep(0,'https://x.com/home'),{stopped:'Time is up.'});
});
