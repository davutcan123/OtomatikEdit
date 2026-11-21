'use strict';

const { app } = require('electron');
const assert = require('node:assert/strict');
const { withStudioBrowser } = require('./support/studio_backend.cjs');

app.whenReady().then(() => withStudioBrowser(async ({ evaluate }) => {
    const loaded = await evaluate(`(async () => {
      await window.StudioFonts.ready;
      const faces = await document.fonts.load('700 32px "studio-font-barlow"', 'İğşÖüç');
      return {families:el('text-font-family').options.length, face:faces[0]?.family,status:faces[0]?.status};
    })()`);
    assert.equal(loaded.families, 10);
    assert.match(loaded.face, /studio-font-barlow/);
    assert.equal(loaded.status, 'loaded');

    await evaluate(`{
      const base = emptyTimelineState();
      base.texts = [
        {...TEXT_STYLES.classic,id:'T1',text:'İğşÖüç',start:0,end:2,x:50,y:50},
        {...TEXT_STYLES.classic,id:'T2',text:'Çevrimdışı',kind:'subtitle',start:0,end:2,x:50,y:87},
      ];
      base.nextTextId = 3;
      restoreProject({name:'Font fixture',activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Metin',state:base}]});
      S.timelineCursor = .5;
      selectText('T1',false);
    }`);
    const change = (id, value) => evaluate(`{
      const input = el(${JSON.stringify(id)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('change', {bubbles:true}));
    }`);
    await change('text-font-family', 'spacemono');
    await change('text-font-weight', '400');
    const textState = await evaluate(`(() => {
      const node = document.querySelector('[data-text-id="T1"] .preview-text-content');
      return [selectedText().fontFamily,selectedText().bold,getComputedStyle(node).fontFamily,getComputedStyle(node).fontWeight];
    })()`);
    assert.deepEqual(textState.slice(0, 2), ['spacemono', false]);
    assert.match(textState[2], /studio-font-spacemono/);
    assert.equal(textState[3], '400');

    await evaluate("selectText('T2',false)");
    await change('subtitle-selected-font-family', 'instrumentserif');
    assert.equal(await evaluate("el('subtitle-selected-font-weight').disabled"), true);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-text-id=T2] .preview-text-content')).fontWeight"), '400');
    await change('subtitle-selected-style', 'pop');
    assert.equal(await evaluate('selectedText().fontFamily'), 'instrumentserif');
    await evaluate("S.trackState.subtitle.locked=true;drawClips()");
    await change('subtitle-selected-font-family', 'barlow');
    assert.equal(await evaluate('selectedText().fontFamily'), 'instrumentserif');
    await evaluate("S.trackState.subtitle.locked=false;selectText('T1',false)");
    const duplicate = await evaluate(`(() => {
      timelineCopySelection();
      S.timelineCursor = 1;
      timelinePasteClipboard();
      const payload=JSON.parse(JSON.stringify(projectPayload()));
      restoreProject(payload);
      return S.texts.filter(item=>item.kind!=='subtitle').map(item=>[item.fontFamily,item.bold]);
    })()`);
    assert.deepEqual(duplicate, [['spacemono', false], ['spacemono', false]]);

    const hasStudio = await evaluate("!!window.StudioWorkspace && !!el('studio-fonts')");
    if (hasStudio) {
      await evaluate("window.StudioWorkspace.openSection('fonts')");
      await evaluate('window.StudioPreferences.ready');
      assert.equal(await evaluate("document.querySelectorAll('[data-font]').length"), 9);
      await evaluate(`{
        const query = el('studio-font-search');
        query.value = 'IBM';
        query.dispatchEvent(new Event('input'));
      }`);
      assert.equal(await evaluate("document.querySelectorAll('[data-font]').length"), 1);
      assert.equal(await evaluate("document.querySelector('[data-font]').dataset.font"), 'ibmplexmono');
      await evaluate(`{
        const field = el('studio-font-sample-input');
        field.value = 'Şaşırtıcı ölçüler';
        field.dispatchEvent(new Event('input'));
        document.querySelector('[data-font-favorite="ibmplexmono"]').click();
      }`);
      assert.equal(await evaluate("document.querySelector('.studio-font-sample').textContent"), 'Şaşırtıcı ölçüler');
      for (let attempt = 0; attempt < 30 && !await evaluate("window.StudioPreferences.get('favorites',[]).includes('font:ibmplexmono')"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.ok(await evaluate("window.StudioPreferences.get('favorites',[]).includes('font:ibmplexmono')"));

      await evaluate("S.selectedText=null;drawClips()");
      assert.equal(await evaluate("document.querySelector('[data-apply-font=ibmplexmono]').textContent"), 'Bu yazı tipiyle metin ekle');
      const count = await evaluate('S.texts.length');
      await evaluate("document.querySelector('[data-apply-font=ibmplexmono]').click()");
      assert.equal(await evaluate('S.texts.length'), count + 1);
      assert.equal(await evaluate('selectedText().fontFamily'), 'ibmplexmono');
      await evaluate("undoEdit();S.selectedText=null;S.trackState.text.locked=true;drawClips()");
      assert.equal(await evaluate('S.texts.length'), count);
      assert.equal(await evaluate("document.querySelector('[data-apply-font=ibmplexmono]').disabled"), true);
    }
    console.log('Bundled fonts load in offline Chromium and persist for text/subtitle editing.');
})).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
