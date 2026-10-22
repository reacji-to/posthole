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
