'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const srt = require('../static/studio/srt.js');

const turkish = '\uFEFF1\r\n00:00:00,125 --> 00:00:01,250\r\nİstanbul’da ışık.\r\nÇığ, göl ve ölçü.\r\n\r\n2\r\n00:00:02.005 --> 00:00:02.945\r\nÜç kişi yürüdü.\r\n';
const first = { start:.125,end:1.25,text:'İstanbul’da ışık.\nÇığ, göl ve ölçü.' };

test('parses UTF-8 BOM, CRLF, Turkish letters, decimal marks and multiline cues',()=>{
  assert.deepEqual(srt.parse(turkish),[
    {...first,line:2},{start:2.005,end:2.945,text:'Üç kişi yürüdü.',line:7}
  ]);
  assert.equal(srt.parse('00:00:00,010 --> 00:00:00,040\nMerhaba')[0].end,.04);
});

test('malformed second block identifies its line and yields no partial result',()=>{
  assert.throws(()=>srt.parse(turkish.replace('00:00:02.005','00:73:02.005')),error=>error.line===7&&/Satır 7/.test(error.message));
  assert.throws(()=>srt.parse('1\n00:00:01,000 --> 00:00:00,000\nA'),error=>error.line===2);
  assert.throws(()=>srt.parse('1\n00:00:00,000 --> 00:00:01,000\n'),error=>error.line===3);
  assert.throws(()=>srt.parse('1\n00:00:00,100 --> 00:00:01,000\nA\n2\n00:00:02,000 --> 00:00:03,000\nB'),error=>error.line===5);
});

test('applies character limits without cutting Unicode or exporting invalid records',()=>{
  const allowed='🍀'.repeat(200);
  assert.equal(srt.cueValue(0,1,allowed).text,allowed);
  assert.throws(()=>srt.parse('01\n00:00:01,000 --> 00:00:02,000\n'+allowed+'ş'),/Satır 3.*200/);
  assert.throws(()=>srt.serialize([{...first,text:'ş'.repeat(201)}]),/200/);
  assert.throws(()=>srt.cueValue(0,1,'a\n\nb'),/boş satır/);
});

test('plans additions atomically, skips exact duplicates and preserves ordinary text when replacing',()=>{
  const cues=srt.parse(turkish), existing=[{...first,id:'original',kind:'subtitle'},{id:'title',kind:'text'}];
  const plan=srt.planImport([...cues,cues[1]],existing);
  assert.equal(plan.retained,existing);
  assert.deepEqual(plan.added,[{start:2.005,end:2.945,text:'Üç kişi yürüdü.'}]);
  assert.equal(plan.duplicates,2);
  assert.equal(existing.length,2);
  const shifted=srt.planImport(cues,existing,{offset:3.125,mode:'replace'});
  assert.deepEqual(shifted.retained,[existing[1]]);
  assert.deepEqual(shifted.added[0],{...first,start:3.25,end:4.375});
});

test('rejects more than 500 total text items or cues and leaves existing collection untouched',()=>{
  const initial=Array.from({length:499},(_,i)=>({id:'T'+i,kind:'text'}));
  assert.throws(()=>srt.planImport(srt.parse(turkish),initial),/Satır 7.*500/);
  assert.equal(initial.length,499);
  const source=Array.from({length:501},(_,i)=>`${i+1}\n00:00:00,100 --> 00:00:01,000\nMetin ${i+1}`).join('\n\n');
  assert.throws(()=>srt.parse(source),/Satır 2002.*500/);
  assert.equal(srt.planImport(srt.parse('1\n00:00:00,100 --> 00:00:01,000\nMetin'),initial).added.length,1);
});

test('round-trip export retains milliseconds and multiline text with sequential cue numbering',()=>{
  const original=srt.parse(turkish), output=srt.serialize([...original].reverse());
  assert.match(output,/^\uFEFF1\r\n00:00:00,125 --> 00:00:01,250\r\n/);
  assert.deepEqual(srt.parse(output),original);
});
