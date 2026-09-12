'use strict';
const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;
function isLocalURL(candidate, origin) {
  if (!origin) return false;
  try { return new URL(candidate).origin === origin; } catch { return false; }
}
function validateRecovery(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_RECOVERY_BYTES) {
    throw new Error('Kurtarma kaydı boyutu geçersiz.');
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Geçersiz proje kaydı.');
  return value;
}
module.exports = { isLocalURL, validateRecovery, MAX_RECOVERY_BYTES };
