import crypto from 'node:crypto';
import { one, run, now } from './db.js';

const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

export function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('insert into sessions(token, user_id, expires_at) values(?, ?, ?)', token, userId, now() + SESSION_DAYS * 864e5);
  return token;
}

export function cookieFor(token, maxAgeSec = SESSION_DAYS * 86400) {
  // Na nuvem (HTTPS) o cookie só viaja criptografado: COOKIE_SECURE=1.
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

export function loadUser(req) {
  const token = readCookie(req, 'sid');
  if (!token) return null;
  const u = one(
    `select u.id, u.name, u.email, u.is_admin, u.role_id, r.rights from sessions s
     join users u on u.id = s.user_id left join roles r on r.id = u.role_id
     where s.token = ? and s.expires_at > ? and u.is_active = 1`, token, now());
  if (!u) return null;
  u.token = token;
  u.rights = JSON.parse(u.rights || '{}');
  return u;
}

// --- permissões: escopo por entidade ('leads' | 'contacts' | 'companies') e ação ('view' | 'edit')
export function scope(user, ent, act, col = 'responsible_id') {
  if (user.is_admin) return '1=1';
  const r = user.rights?.[ent]?.[act];
  if (r === 'all') return '1=1';
  if (r === 'own') return `${col} = ${Number(user.id)}`;
  return '0=1';
}

export function can(user, ent, act, row) {
  if (user.is_admin) return true;
  const r = user.rights?.[ent]?.[act];
  if (act === 'del') return r === true;
  if (r === 'all') return true;
  if (r === 'own') return !row || row.responsible_id === user.id;
  return false;
}
