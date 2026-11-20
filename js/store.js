// store.js - sessions live in IndexedDB on the phone; falls back to memory if the browser blocks it.
import { serializeSession, reviveSession } from './core.js';

const DB = 'edge-finger-tests';
const STORE = 'sessions';
let dbPromise = null;
const memory = new Map();
export let persistent = true;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch (err) {
    persistent = false;
    return null;
  }
}

export async function allSessions() {
  const rows = await tx('readonly', (s) => s.getAll());
  if (rows === null) return [...memory.values()].sort((a, b) => a.startedAt - b.startedAt);
  return rows.sort((a, b) => a.startedAt - b.startedAt);
}

export async function putSession(session) {
  memory.set(session.id, session);
  await tx('readwrite', (s) => s.put(session));
}

export async function deleteSession(id) {
  memory.delete(id);
  await tx('readwrite', (s) => s.delete(id));
}

export async function clearSessions() {
  memory.clear();
  await tx('readwrite', (s) => s.clear());
}

export const exportJson = (sessions) =>
  JSON.stringify({ app: 'edge', version: 1, sessions: sessions.map(serializeSession) });

export function parseImport(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.sessions)) throw new Error('This file is not an Edge export');
  return data.sessions.map(reviveSession);
}

const KEY = 'edge.settings';
export const defaultSettings = { bodyweight: null, threshold: 5, edge: 20, hand: 'L' };

export function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaultSettings };
  }
}
export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: settings last for this visit only */
  }
}
