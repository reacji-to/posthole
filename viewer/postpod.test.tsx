/** @jsxImportSource hono/jsx */
import { test, expect } from 'bun:test';
import { parseHTML } from 'linkedom';
import { Page } from './views';
import { initInterfaceControls } from './interface-controls.js';

for (const view of ['ipod','ipod-color']) {
  test(`${view}: MENU replaces the screen; wheel selects, center opens; list paginates`, async () => {
    const html = String(<Page counts={{x:3}} total={3} query={new URLSearchParams({view})}>
      <section class="post-entry" data-key="x:1" data-title="First post">One</section>
      <section class="post-entry" data-key="x:2" data-title="Second post">Two</section>
      <div class="more" data-next="/cards?offset=2" />
    </Page>);
    const {document,window}=parseHTML(html);
    Object.assign(globalThis,{document,window,CustomEvent:window.CustomEvent});
    window.HTMLElement.prototype.focus=()=>{};
    const picker=document.querySelector('#interface-select')!;
    Object.defineProperty(picker,'options',{value:[...picker.querySelectorAll('option')]});
    const feed=document.querySelector('.feed')!, menu=document.querySelector('.ipod-list')!;
    initInterfaceControls(feed,async()=>{
      feed.querySelector('.more')!.remove();
      feed.insertAdjacentHTML('beforeend','<section class="post-entry" data-key="x:3" data-title="Third post">Three</section>');
      return true;
    });
    const click=(action:string)=>document.querySelector(`[data-deck="${action}"]`)!.click();
    const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
    expect(feed.hidden).toBe(false); expect(menu.hidden).toBe(true);
    click('menu');
    expect(feed.hidden).toBe(true); expect(menu.hidden).toBe(false);
    expect(menu.parentElement).toBe(feed.parentElement);
    expect(document.querySelector('[data-player-title]')!.textContent).toBe('Posts');
    click('next'); await settle();
    expect(menu.querySelector('[aria-current=true]')!.textContent).toBe('Second post');
    expect(feed.querySelector('.is-active')!.dataset.key).toBe('x:1');
    click('menu');
    expect(menu.querySelector('[aria-current=true]')!.textContent).toBe('Second post');
    click('select');
    expect(menu.hidden).toBe(true); expect(feed.hidden).toBe(false);
    expect(feed.querySelector('.is-active')!.dataset.key).toBe('x:2');
    click('menu');
    [...menu.querySelectorAll('button')].find(b=>b.textContent==='Load more posts')!.click(); await settle();
    expect(menu.querySelectorAll('[data-post-index]').length).toBe(3);
    menu.querySelector('[data-post-index="2"]')!.click();
    expect(feed.querySelector('.is-active')!.dataset.key).toBe('x:3');
    expect(menu.hidden).toBe(true); expect(feed.hidden).toBe(false);
    expect(document.querySelectorAll('dialog,[popover]').length).toBe(0);
    expect(document.querySelectorAll('#postpod-monochrome feComponentTransfer>*').length).toBe(view==='ipod'?3:0);
  });
}

for (const view of ['ipod','ipod-color']) {
  test(`${view}: arrows navigate the screen, Space toggles video, and search retains its keys`, async () => {
    const {document,window}=parseHTML(String(<Page counts={{x:2}} total={2} query={new URLSearchParams({view})}>
      <section class="post-entry" data-key="x:1" data-title="Video"><video /></section>
      <section class="post-entry" data-key="x:2" data-title="Text">Text</section>
    </Page>));
    Object.assign(globalThis,{document,window,CustomEvent:window.CustomEvent});
    window.HTMLElement.prototype.focus=()=>{};
    const picker=document.querySelector('#interface-select')!;
    Object.defineProperty(picker,'options',{value:[...picker.querySelectorAll('option')]});
    const feed=document.querySelector('.feed')!, menu=document.querySelector('.ipod-list')!;
    Object.defineProperty(feed,'clientHeight',{value:240});
    feed.scrollTop=0;
    feed.scrollBy=({top})=>{feed.scrollTop+=top;};
    const video=document.querySelector('video')!;
    let playing=false;
    Object.defineProperty(video,'paused',{get:()=>!playing});
    video.play=async()=>{playing=true;}; video.pause=()=>{playing=false;};
    initInterfaceControls(feed,async()=>false);
    const key=(key:string,target=feed,repeat=false)=>{
      const event=new window.Event('keydown',{bubbles:true,cancelable:true});
      Object.assign(event,{key,repeat}); target.dispatchEvent(event); return event;
    };
    const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
    expect(key('ArrowLeft').defaultPrevented).toBe(true); expect(menu.hidden).toBe(false);
    key('ArrowDown',menu); await settle();
    expect(menu.querySelector('[aria-current=true]')!.textContent).toBe('Text');
    key('ArrowUp',menu); await settle();
    key('ArrowRight',menu); expect(menu.hidden).toBe(true);
    expect(feed.querySelector('.is-active')!.dataset.key).toBe('x:1');
    key('ArrowDown'); expect(feed.scrollTop).toBeGreaterThan(0);
    const at=feed.scrollTop;
    key('ArrowRight'); expect(feed.scrollTop).toBe(at);
    key('ArrowUp'); expect(feed.scrollTop).toBe(0);
    expect(key(' ').defaultPrevented).toBe(true); expect(playing).toBe(true);
    key(' ',feed,true); expect(playing).toBe(true);
    key(' ',video); expect(playing).toBe(false);
    key('ArrowLeft',video); expect(menu.hidden).toBe(false);
    expect(key('ArrowRight',document.querySelector('input[type=search]')!).defaultPrevented).toBe(false);
    expect(menu.hidden).toBe(false);
  });
}
