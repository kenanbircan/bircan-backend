'use strict';

function asBool(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['yes', 'true', 'y', '1', 'provided', 'approved'].includes(v)) return true;
    if (['no', 'false', 'n', '0', 'none', 'not provided'].includes(v)) return false;
  }
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return null;
  return Math.floor((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

function ageAt(dateOfBirth, atDate) {
  const dob = parseDate(dateOfBirth);
  const at = parseDate(atDate);
  if (!dob || !at) return null;
  let age = at.getFullYear() - dob.getFullYear();
  const m = at.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < dob.getDate())) age -= 1;
  return age;
}

function normaliseString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function lower(value) {
  return normaliseString(value).toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compact(arr) {
  return (arr || []).filter(Boolean);
}

function yesNoUnknown(value) {
  const b = asBool(value);
  return b === true ? 'yes' : b === false ? 'no' : 'unknown';
}

module.exports = { asBool, parseDate, daysBetween, ageAt, normaliseString, lower, numberOrNull, compact, yesNoUnknown };
