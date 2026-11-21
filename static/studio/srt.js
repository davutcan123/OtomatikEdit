(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioSrt = api;
})(globalThis, () => {
  'use strict';

  const maxCues = 500;
  const maxCharacters = 200;
  const maxFileBytes = 1024 * 1024;
  const timestampPattern = '(\\d{2,}):([0-5]\\d):([0-5]\\d)[,.](\\d{3})';
  const cueTiming = new RegExp('^'+timestampPattern+'\\s*-->\\s*'+timestampPattern+'$');
  const normalizedLines = value => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const milliseconds = value => Math.round(value*1000);
  const validTime = value => Number.isFinite(value)&&value>=0&&Number.isSafeInteger(milliseconds(value));

  function failure(line, reason) {
    const error = new Error(line ? 'Satır '+line+': '+reason : reason);
    error.line = line;
    return error;
  }

  function textValue(value, line) {
    const text = normalizedLines(String(value??'')).trim();
    if (!text || /\u0000/.test(text)) throw failure(line, 'Altyazı metni boş veya geçersiz.');
    if ([...text].length>maxCharacters) throw failure(line, 'Altyazı metni en fazla '+maxCharacters+' karakter olabilir.');
    if (/\n[\t ]*\n/.test(text)) throw failure(line, 'Altyazı metninde boş satır kullanılamaz.');
    return text;
  }

  function cueValue(start, end, value, line) {
    if (!validTime(start)||!validTime(end)||milliseconds(end)<=milliseconds(start)) {
      throw failure(line, 'Bitiş zamanı başlangıçtan sonra olmalı.');
    }
    return {start:milliseconds(start)/1000,end:milliseconds(end)/1000,text:textValue(value,line)};
  }

  function readTime(parts) {
    const [hour, minute, second, millisecond] = parts.map(Number);
    return ((hour*60+minute)*60+second)+millisecond/1000;
  }

  function parse(source) {
    const lines = normalizedLines(source).split('\n');
    const cues = [];
    let cursor = 0;
    while (cursor<lines.length) {
      while (cursor<lines.length&&!lines[cursor].trim()) cursor++;
      if (cursor===lines.length) break;
      if (/^\d+$/.test(lines[cursor].trim())) cursor++;
      const timingLine = cursor+1;
      const timing = cueTiming.exec(lines[cursor]?.trim()||'');
      if (!timing) throw failure(timingLine, 'Geçerli bir zaman satırı bekleniyor (00:00:00,000 --> 00:00:01,000).');
      if (cues.length>=maxCues) throw failure(timingLine, 'En fazla '+maxCues+' altyazı içe aktarılabilir.');
      cursor++;
      const firstTextLine = cursor+1, body = [];
      while (cursor<lines.length&&lines[cursor].trim()) {
        if (/^\s*\d{2,}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(lines[cursor])) {
          throw failure(cursor+1, 'Yeni altyazıdan önce boş satır bırakılmalı.');
        }
        body.push(lines[cursor++]);
      }
      const start = readTime(timing.slice(1,5)), end = readTime(timing.slice(5,9));
      if (!validTime(start)||!validTime(end)||milliseconds(end)<=milliseconds(start)) {
        throw failure(timingLine, 'Bitiş zamanı başlangıçtan sonra olmalı.');
      }
      cues.push({...cueValue(start,end,body.join('\n'),firstTextLine),line:timingLine});
    }
    if (!cues.length) throw failure(1, 'Dosyada altyazı bulunamadı.');
    return cues;
  }

  function cueKey({start,end,text}) {
    return JSON.stringify([milliseconds(start),milliseconds(end),normalizedLines(String(text??'')).trim().normalize('NFC')]);
  }

  function planImport(cues, existingTexts, {mode='append',offset=0}={}) {
    const existing = mode==='replace' ? existingTexts.filter(item=>item.kind!=='subtitle') : existingTexts;
    const known = new Set(existing.filter(item=>item.kind==='subtitle').map(cueKey));
    const added = [];
    let duplicates = 0;
    for (const cue of cues) {
      const adjusted = cueValue(cue.start+offset,cue.end+offset,cue.text,cue.line);
      const key = cueKey(adjusted);
      if (known.has(key)) {duplicates++;continue;}
      if (existing.length+added.length>=maxCues) {
        throw failure(cue.line, 'Bir zaman çizelgesinde toplam '+maxCues+' metin ve altyazı katmanı olabilir.');
      }
      known.add(key);added.push(adjusted);
    }
    return {retained:existing,added,duplicates};
  }

  function formatTime(value) {
    let remaining = milliseconds(value);
    const hour = Math.floor(remaining/3600000);remaining %= 3600000;
    const minute = Math.floor(remaining/60000);remaining %= 60000;
    const second = Math.floor(remaining/1000), millis = remaining%1000;
    const pad = (number,width=2) => String(number).padStart(width,'0');
    return [pad(hour),pad(minute),pad(second)].join(':')+','+pad(millis,3);
  }

  function serialize(items) {
    if (!items.length) throw failure(0, 'Bu zaman çizelgesinde dışa aktarılacak altyazı yok.');
    if (items.length>maxCues) throw failure(0, 'En fazla '+maxCues+' altyazı dışa aktarılabilir.');
    const cues = items.map((item,index)=>cueValue(item.start,item.end,item.text,index+1))
      .sort((a,b)=>a.start-b.start||a.end-b.end);
    return '\uFEFF'+cues.map((cue,index)=>(index+1)+'\r\n'+formatTime(cue.start)+' --> '+formatTime(cue.end)+'\r\n'+cue.text.replace(/\n/g,'\r\n')).join('\r\n\r\n')+'\r\n';
  }

  return {parse,planImport,serialize,formatTime,cueValue,maxFileBytes,maxCharacters,maxCues};
});
