'use strict';

// Self-contained so the smoke runner can execute this same predicate in the
// renderer; native Node imports are deliberately absent from its body.
function waitForMedia(media, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const events = ['loadeddata', 'canplay', 'seeked'];
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      events.forEach(event => media.removeEventListener(event, ready));
      media.removeEventListener('error', failed);
    };
    const ready = () => {
      if (media.readyState < 2 || media.seeking) return false;
      cleanup(); resolve(); return true;
    };
    const failed = () => { cleanup(); reject(new Error(media.error?.message || 'Video decode failed')); };
    if (media.error) return failed();
    if (ready()) return;
    events.forEach(event => media.addEventListener(event, ready));
    media.addEventListener('error', failed);
    // loadeddata fires only once per load. A restore seek may have temporarily
    // reduced readyState when this wait began, so canplay/seeked matter too.
    timer = setTimeout(() => {
      if (ready()) return;
      cleanup(); reject(new Error('Video load timeout'));
    }, timeoutMs);
  });
}
module.exports = { waitForMedia };
