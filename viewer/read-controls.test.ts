import { test, expect } from 'bun:test';
import { parseHTML } from 'linkedom';
import { initReadControls } from './read-controls.js';

const card = (key: string) => `<section class="post-entry" data-key="${key}"><article class="interface-card"><div class="story-heading"><details><summary>A saved post</summary>Body</details></div><div class="interface-bottom"></div></article></section>`;
function setup(storage = new Map<string,string>()) {
  const {document,window} = parseHTML(`<html><body><div class="interface-toolbar"></div><main>${card('x:1')}</main></body></html>`);
  Object.assign(globalThis, {document,window,MutationObserver:window.MutationObserver});
  const store = {getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,value);}};
  return {document, window, storage, controls:initReadControls(document,store)};
}

test('read status is explicit, persistent, reversible and shared by duplicate cards', async () => {
  const f=setup();
  try {
    const button=f.document.querySelector('.read-toggle')!;
    expect(button.textContent).toBe('Unread');
    button.click(); expect(button.textContent).toBe('Read');
    expect(JSON.parse(f.storage.get('posthole.read')!)).toEqual(['x:1']);
    f.document.querySelector('main')!.insertAdjacentHTML('beforeend',card('x:1'));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect([...f.document.querySelectorAll('.read-toggle')].map(b=>b.textContent)).toEqual(['Read','Read']);
    button.click(); expect([...f.document.querySelectorAll('.read-toggle')].map(b=>b.textContent)).toEqual(['Unread','Unread']);
    f.controls.mark('x:1');
  } finally {f.controls.destroy();}
  const reopened=setup(f.storage);
  expect(reopened.document.querySelector('.read-toggle')!.textContent).toBe('Read');
  reopened.controls.destroy();
});
test('opening a story marks it read; scrolling and closing it do not', () => {
  const f=setup();
  try {
    const details=f.document.querySelector('details')!;
    f.document.dispatchEvent(new f.window.Event('scroll'));
    expect(f.document.querySelector('.read-toggle')!.textContent).toBe('Unread');
    details.open=true; details.dispatchEvent(new f.window.Event('toggle',{bubbles:true}));
    expect(f.document.querySelector('.read-toggle')!.textContent).toBe('Read');
    f.controls.mark('x:1',false);
    details.open=false; details.dispatchEvent(new f.window.Event('toggle',{bubbles:true}));
    expect(f.document.querySelector('.read-toggle')!.textContent).toBe('Unread');
  } finally {f.controls.destroy();}
});
test('a storage failure leaves the post unread and reports that saving failed', () => {
  const f=setup(); f.controls.destroy();
  const control=initReadControls(f.document,{getItem:()=>null,setItem:()=>{throw new Error('Quota');}});
  control.mark('x:1');
  expect(f.document.querySelector('.read-toggle')!.textContent).toBe('Unread');
  expect(f.document.querySelectorAll('.read-status')[1].textContent).toContain('Couldn’t save');
  control.destroy();
});
