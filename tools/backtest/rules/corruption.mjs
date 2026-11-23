// Damaged data. Two kinds of scenario:
//  (a) corrupt WRITES (expectNew:'deny'): even a fully privileged actor must be refused;
//  (b) corrupt STORED docs ('seed' overlays the fixture; null deletes a fixture doc): the
//      stable app's normal flows must behave as under the old rules (replay compares), and a
//      corrupt grant must never confer rights. Scenarios marked info:true are reported, never failed.
// ADD a corruption by naming a base scenario (scenarios.mjs) and a seed overlay or a bad payload.
import { readFileSync } from 'node:fs';
import { scenarios } from './scenarios.mjs';

const CAPS = JSON.parse(readFileSync(new URL('./fixtures/default_caps.json', import.meta.url), 'utf8'));

export function corruption(h) {
  const { A, doc, collection, writeBatch, serverTimestamp, increment, setDoc, updateDoc, getDoc, days, name } = h;
  const base = Object.fromEntries(scenarios(h).map((s) => [s.id, s]));
  const out = [];
  const stored = (id, from, seed, o = {}) => out.push({ ...base[from], id: `corrupt-data/${id}`, area: 'corruption', seed, ...o });
  const write = (id, actors, run) => out.push({ id: `corrupt-write/${id}`, area: 'corruption', actors, expectNew: 'deny', run });
  const g = (role, campus, scope, email, x = {}) => ({ role, campus, scope, email, name: name(email), active: true, expiresAt: { $ts: 100 }, grantedBy: { email: A.OWNER, name: 'o' }, grantedAt: { $ts: -3 }, auditId: 's', ...x });
  const au = (b, db, e, path, campus = 'goa') => { const r = doc(collection(db, 'audit')); b.set(r, { actor: { email: e, name: name(e), role: 'x' }, action: 'x', path, campus, at: serverTimestamp() }); return r.id; };
  const bump = (b, db, c, p) => b.set(doc(db, 'heads', c), { v: { [p]: increment(1) } }, { merge: true });
  const ALL_PRIV = ['OWNER', 'ADMIN_G', 'PRES', 'ADMINPRES'];

  // ---- (a) corrupt writes -------------------------------------------------------
  const grantW = (id, mut, role = 'course', scope = 'EEE F212', staff = { courses: [scope] }) => write(id, ALL_PRIV, async (h_, db, e) => {
    const b = writeBatch(db); const gidv = `${role}|goa|${scope}|${A.TARGET}`;
    const d = { role, campus: 'goa', scope, email: A.TARGET, name: name(A.TARGET), active: true, expiresAt: days(100), grantedBy: { email: e, name: name(e) }, grantedAt: serverTimestamp(), auditId: au(b, db, e, `grants/${gidv}`) };
    mut(d);
    b.set(doc(db, 'grants', gidv), d);
    b.set(doc(db, 'staff', A.TARGET), { email: A.TARGET, name: name(A.TARGET), campus: 'goa', owner: false, admin: false, presidentOf: [], courses: [], expiresAt: days(100), lastGrant: gidv, ...staff });
    bump(b, db, 'goa', 'grants');
    await b.commit();
  });
  grantW('grant-expiresAt-millis', (d) => { d.expiresAt = Date.now() + 864e7 });
  grantW('grant-expiresAt-null', (d) => { d.expiresAt = null });
  grantW('grant-expiresAt-5-years', (d) => { d.expiresAt = days(1800) });
  grantW('grant-expiresAt-past', (d) => { d.expiresAt = days(-1) });
  grantW('grant-active-string', (d) => { d.active = 'true' });
  grantW('grant-name-not-the-persons', (d) => { d.name = 'Somebody Else' });
  grantW('grant-grantedBy-someone-else', (d) => { d.grantedBy = { email: A.OWNER, name: 'o' } }, 'course', 'EEE F212');
  grantW('grant-dangling-custom-roleId', (d) => { d.roleId = 'deleted-role' }, 'custom', 'role', {});
  grantW('grant-scope-huge', (d) => { d.scope = 'X'.repeat(5000) }, 'course', 'EEE F212');
  grantW('staff-presidentOf-string', () => {}, 'course', 'EEE F212', { presidentOf: 'ELEC', courses: ['EEE F212'] });
  grantW('staff-reach-string', () => {}, 'course', 'EEE F212', { reach: 'everything', courses: ['EEE F212'] });
  grantW('staff-reach-claims-admin', () => {}, 'course', 'EEE F212', { reach: [{ role: 'admin', campus: 'all' }], courses: ['EEE F212'] });
  grantW('staff-expiresAt-string', () => {}, 'course', 'EEE F212', { expiresAt: 'never', courses: ['EEE F212'] });
  grantW('staff-admin-flag-on-cr', () => {}, 'course', 'EEE F212', { admin: true, courses: ['EEE F212'] });
  write('roles-builtin-by-admin', ['ADMIN_G', 'PRES', 'STUDENT'], async (h_, db, e) => {
    const b = writeBatch(db); const a = au(b, db, e, 'roles/builtin', 'all');
    b.set(doc(db, 'roles', 'builtin'), { admin: { caps: ['manageRoles'], termDays: 730 }, president: { caps: [], termDays: 365 }, cr: { caps: [], termDays: 183 }, auditId: a });
    await b.commit();
  });
  write('roles-builtin-owner-garbage-termDays', ['OWNER'], async (h_, db, e) => {
    const b = writeBatch(db); const a = au(b, db, e, 'roles/builtin', 'all');
    b.set(doc(db, 'roles', 'builtin'), { admin: { caps: ['manageRoles'], termDays: 'forever' }, president: { caps: [], termDays: 365 }, cr: { caps: [], termDays: 183 }, auditId: a });
    await b.commit();
  });
  write('roles-builtin-owner-caps-huge', ['OWNER'], async (h_, db, e) => {
    const b = writeBatch(db); const a = au(b, db, e, 'roles/builtin', 'all');
    b.set(doc(db, 'roles', 'builtin'), { admin: { caps: Array.from({ length: 5000 }, (_, i) => `c${i}`), termDays: 730 }, president: { caps: [], termDays: 365 }, cr: { caps: [], termDays: 183 }, auditId: a });
    await b.commit();
  });
  write('custom-role-by-admin', ['ADMIN_G', 'PRES'], (h_, db, e) => setDoc(doc(db, 'roles', 'sneaky'), { name: 'x', caps: ['manageRoles'], termDays: 30, campus: 'all', dept: 'all' }));
  write('terms-strings', ['OWNER', 'ADMIN_G'], async (h_, db, e) => {
    const b = writeBatch(db); const a = au(b, db, e, 'config/grantTerms', 'all');
    b.set(doc(db, 'config', 'grantTerms'), { crDays: 'many', presidentDays: 365, adminDays: 730, auditId: a });
    for (const c of ['goa', 'hyderabad', 'pilani', 'dubai']) bump(b, db, c, 'terms');
    await b.commit();
  });
  write('heads-v-string', ['OWNER', 'STUDENT', 'PRES'], (h_, db) => setDoc(doc(db, 'heads', 'goa'), { v: 'x' }, { merge: true }));
  write('heads-unknown-top-key', ['OWNER', 'STUDENT'], (h_, db) => setDoc(doc(db, 'heads', 'goa'), { v: { a: increment(1) }, evil: 1 }, { merge: true }));
  write('gate-on-string', ['OWNER', 'ADMIN_G'], async (h_, db, e) => {
    const b = writeBatch(db); const a = au(b, db, e, 'reviewGate/goa');
    b.set(doc(db, 'reviewGate', 'goa'), { on: 'yes', by: { email: e, name: name(e) }, at: serverTimestamp(), auditId: a }); bump(b, db, 'goa', 'reviewGate');
    await b.commit();
  });
  write('offering-components-not-list', ['OWNER', 'ADMIN_G', 'PRES'], async (h_, db, e) => {
    const b = writeBatch(db); const path = 'courses/EEE F111/offerings/goa_2026-27-1'; const a = au(b, db, e, path);
    b.set(doc(db, path), { courseId: 'EEE F111', campus: 'goa', term: '2026-27-1', components: 'none', updatedBy: { email: e, name: name(e) }, updatedAt: serverTimestamp(), auditId: a });
    await b.commit();
  });
  write('professor-name-number', ['OWNER', 'ADMIN_G', 'PRES'], async (h_, db, e) => {
    const b = writeBatch(db); const a = au(b, db, e, 'professors/pbad');
    b.set(doc(db, 'professors', 'pbad'), { name: 42, campus: 'goa', department: 'ELEC', aliases: [], nameTokens: [], mergedIds: [], active: true, updatedBy: { email: e, name: name(e) }, updatedAt: serverTimestamp(), auditId: a });
    bump(b, db, 'goa', 'professors/ELEC'); await b.commit();
  });
  write('resource-url-javascript', ['OWNER', 'ADMIN_G', 'PRES'], async (h_, db, e) => {
    const b = writeBatch(db); const a = au(b, db, e, 'resources/rbad');
    b.set(doc(db, 'resources', 'rbad'), { title: 'x', url: 'javascript:alert(1)', host: 'x', kind: 'link', campus: 'goa', department: 'ELEC', scope: 'department', courseIds: [], pinnedToDepartment: false, removed: false, actingFor: '', addedBy: { email: e, name: name(e) }, addedAt: serverTimestamp(), auditId: a });
    bump(b, db, 'goa', 'resources'); await b.commit();
  });
  write('users-rev-string', ['STUDENT', 'OWNER'], (h_, db, e) => setDoc(doc(db, 'users', `uid-${e.split('@')[0]}`), { rev: '1', data: '{}' }));
  write('users-data-huge', ['STUDENT'], (h_, db, e) => setDoc(doc(db, 'users', `uid-${e.split('@')[0]}`), { rev: 1, data: 'x'.repeat(600000) }));
  write('people-other-campus', ['STUDENT'], (h_, db, e) => setDoc(doc(db, 'people', e), { name: 'x', campus: 'pilani', firstSignIn: 1 }));
  write('student-appoints-self-admin', ['STUDENT', 'CR', 'CONTRIB', 'MULTI'], async (h_, db, e) => {
    const b = writeBatch(db); const id = `admin|all|all|${e}`; const a = au(b, db, e, `grants/${id}`, 'all');
    b.set(doc(db, 'grants', id), { role: 'admin', campus: 'all', scope: 'all', email: e, name: name(e), active: true, expiresAt: days(100), grantedBy: { email: e, name: name(e) }, grantedAt: serverTimestamp(), auditId: a });
    b.set(doc(db, 'staff', e), { email: e, name: name(e), campus: 'goa', owner: false, admin: true, presidentOf: [], courses: [], expiresAt: days(100), lastGrant: id });
    bump(b, db, 'goa', 'grants'); await b.commit();
  });

  // ---- (b) corrupt stored docs --------------------------------------------------
  // A grant of someone who is not who the doc says, or damaged, must not confer rights.
  const grantDoc = (k, x) => ({ [`grants/course|goa|EEE F211|${A.CR}`]: g('course', 'goa', 'EEE F211', A.CR, x) });
  stored('cr-grant-expiresAt-millis', 'offering/EEE-F211-goa-own-course', grantDoc('m', { expiresAt: Date.now() + 864e7 }), { actors: ['CR'] });
  stored('cr-grant-expiresAt-missing', 'offering/EEE-F211-goa-own-course', grantDoc('n', { expiresAt: { $delete: true } }), { actors: ['CR'] });
  stored('cr-grant-active-string', 'offering/EEE-F211-goa-own-course', grantDoc('s', { active: 'true' }), { actors: ['CR'] });
  stored('cr-grant-expired', 'offering/EEE-F211-goa-own-course', grantDoc('e', { expiresAt: { $ts: -1 } }), { actors: ['CR'] });
  stored('cr-grant-inactive', 'offering/EEE-F211-goa-own-course', grantDoc('i', { active: false }), { actors: ['CR'] });
  stored('staff-without-grant-president', 'offering/EEE-F111-goa', { [`grants/dept|goa|ELEC|${A.PRES}`]: null }, { actors: ['PRES'] });
  stored('staff-without-grant-roster-read', 'read/audit-newest-goa', { [`grants/dept|goa|ELEC|${A.PRES}`]: null }, { actors: ['PRES'] });
  stored('staff-without-grant-staff-read', 'read/staff-other', { [`grants/dept|goa|ELEC|${A.PRES}`]: null }, { actors: ['PRES'] });
  stored('staff-no-campus-field', 'read/staff-other', { [`staff/${A.PRES}`]: { email: A.PRES, presidentOf: ['ELEC'] } }, { actors: ['PRES'] });
  stored('staff-presidentOf-null', 'roles/appoint-cr', { [`staff/${A.PRES}`]: { email: A.PRES, campus: 'goa', presidentOf: null, courses: [], admin: false, expiresAt: { $ts: 100 } } }, { actors: ['PRES'] });
  stored('grant-no-programme-president-renews-cr', 'roles/renew-cr', { [`grants/dept|goa|ELEC|${A.PRES}`]: g('dept', 'goa', 'ELEC', A.PRES, { programme: { $delete: true } }) }, { actors: ['PRES'] });
  stored('terms-doc-partial', 'roles/appoint-cr', { 'config/grantTerms': { crDays: 183 } }, { actors: ['PRES', 'ADMIN_G'] });
  stored('terms-doc-strings', 'roles/appoint-cr', { 'config/grantTerms': { crDays: '183', presidentDays: 'x', adminDays: null } }, { actors: ['PRES', 'ADMIN_G'], info: true });
  stored('terms-doc-absent', 'roles/appoint-cr', { 'config/grantTerms': null }, { actors: ['PRES', 'ADMIN_G'] });
  stored('terms-doc-absent-appoint-president', 'roles/appoint-president', { 'config/grantTerms': null }, { actors: ['ADMIN_G', 'OWNER'] });
  stored('heads-doc-v-string', 'heads/student-bump-own-campus', { 'heads/goa': { v: 'broken' } }, { actors: ['STUDENT', 'PRES'] });
  stored('heads-doc-missing', 'heads/student-bump-own-campus', { 'heads/goa': null }, { actors: ['STUDENT'] });
  stored('heads-doc-v-has-string-value', 'heads/student-bump-own-campus', { 'heads/goa': { v: { reviews: 'x' } } }, { actors: ['STUDENT'] });
  stored('reviewGate-doc-no-on', 'read/reviewGate-goa', { 'reviewGate/goa': { dept: 'ELEC' } }, { actors: ['STUDENT'] });
  stored('resourceVersions-v-string', 'res/create-dept-link', { 'resourceVersions/goa': { v: 'x' } }, { actors: ['PRES'] });
  stored('person-missing-name-cannot-be-appointed', 'roles/appoint-cr', { [`people/${A.TARGET}`]: { campus: 'goa' } }, { actors: ['PRES', 'ADMIN_G'] });
  stored('person-missing-appoint', 'roles/appoint-cr', { [`people/${A.TARGET}`]: null }, { actors: ['PRES', 'ADMIN_G'] });
  stored('users-doc-rev-string-push', 'users/sync-push', { 'users/uid-f20230456': { rev: 'x', data: '{}' } }, { actors: ['STUDENT'] });
  stored('users-doc-no-data-push', 'users/sync-push', { 'users/uid-f20230456': { rev: 3 } }, { actors: ['STUDENT'] });
  // A custom grant whose role was deleted, or damaged: it confers nothing, and its holder's
  // student-level flows (sync, markers, reading) still work.
  const dangling = { [`grants/custom|${A.CR}`]: g('custom', 'goa', 'role', A.CR, { roleId: 'gone' }), [`staff/${A.CR}`]: { email: A.CR, name: 'x', campus: 'goa', owner: false, admin: false, presidentOf: [], courses: ['EEE F211'], reach: [{ role: 'cr', campus: 'goa', course: 'EEE F211' }, { role: 'custom', campus: 'goa', dept: 'all' }], expiresAt: { $ts: 100 }, lastGrant: `custom|${A.CR}` } };
  for (const id of ['users/sync-push', 'heads/student-bump-own-campus', 'read/loadMine-grants-by-email', 'read/grantTerms', 'read/heads-goa', 'review/post']) stored(`dangling-custom-role/${id}`, id, dangling, { actors: ['CR'] });
  stored('dangling-custom-role/cr-still-writes-own-offering', 'offering/EEE-F211-goa-own-course', dangling, { actors: ['CR'] });
  stored('dangling-custom-role/cr-cannot-write-other-offering', 'offering/CS-F211-goa-other-dept', dangling, { actors: ['CR'] });
  stored('custom-role-doc-garbage', 'offering/EEE-F111-goa', { 'roles/x': { caps: 'courseStructures', campus: 'goa' }, [`grants/custom|${A.STUDENT}`]: g('custom', 'goa', 'role', A.STUDENT, { roleId: 'x' }) }, { actors: ['STUDENT'] });
  // roles/builtin damaged on the NEW side only matters to the new rules; informational.
  stored('roles-builtin-doc-partial', 'offering/EEE-F111-goa', { 'roles/builtin': { admin: { caps: ['manageRoles'], termDays: 730 } } }, { actors: ['PRES', 'ADMIN_G'], info: true });
  stored('roles-builtin-doc-empty', 'roles/appoint-cr', { 'roles/builtin': {} }, { actors: ['PRES', 'ADMIN_G'], info: true });
  stored('roles-builtin-doc-garbage-types', 'roles/appoint-cr', { 'roles/builtin': { admin: 'x', president: 3, cr: null } }, { actors: ['PRES', 'ADMIN_G'], info: true });
  // ---- (c) docs the NEW app writes that the stable app later reads/writes --------------
  const nd = (id, from, seed, o = {}) => out.push({ ...base[from], id: `newdocs/${id}`, area: 'newdocs', seed, ...o });
  const reach = (r) => ({ reach: r });
  const crStaff = (x = {}) => ({ [`staff/${A.CR}`]: { email: A.CR, name: 'x', campus: 'goa', owner: false, admin: false, presidentOf: [], courses: ['EEE F211'], expiresAt: { $ts: 100 }, lastGrant: `course|goa|EEE F211|${A.CR}`, ...x } });
  const cr = reach([{ role: 'cr', campus: 'goa', course: 'EEE F211' }]);
  nd('renew-cr-staff-has-reach', 'roles/renew-cr', crStaff(cr), { actors: ['PRES', 'SEC', 'ADMIN_G', 'ADMINPRES', 'OWNER'] });
  nd('revoke-cr-staff-has-reach', 'roles/revoke-cr', crStaff(cr), { actors: ['PRES', 'ADMIN_G', 'OWNER'] });
  nd('renew-president-staff-has-reach', 'roles/renew-president', { [`staff/${A.PRES}`]: { email: A.PRES, name: 'x', campus: 'goa', owner: false, admin: false, presidentOf: ['ELEC'], courses: [], expiresAt: { $ts: 100 }, lastGrant: `dept|goa|ELEC|${A.PRES}`, ...reach([{ role: 'president', campus: 'goa', dept: 'ELEC' }]) } }, { actors: ['ADMIN_G', 'ADMIN_P', 'OWNER'] });
  nd('appoint-cr-over-staff-with-custom-reach', 'roles/appoint-cr', {
    'roles/rx': { name: 'Rx', caps: ['courseStructures'], termDays: 365, campus: 'goa', dept: 'all', createdBy: { email: A.OWNER, name: 'o' } },
    [`grants/custom|${A.TARGET}`]: g('custom', 'goa', 'role', A.TARGET, { roleId: 'rx' }),
    [`staff/${A.TARGET}`]: { email: A.TARGET, name: 'x', campus: 'goa', owner: false, admin: false, presidentOf: [], courses: [], expiresAt: { $ts: 100 }, lastGrant: `custom|${A.TARGET}`, ...reach([{ role: 'custom', campus: 'goa', dept: 'all' }]) } }, { actors: ['PRES', 'ADMIN_G', 'OWNER'] });
  const bi = (cr_, pres, adm) => ({ 'roles/builtin': { admin: { caps: CAPS.admin, termDays: adm }, president: { caps: CAPS.president, termDays: pres }, cr: { caps: CAPS.cr, termDays: cr_ } } });
  nd('terms-mirror-saved-stable-admin-saves-terms', 'roles/save-terms', { ...bi(183, 365, 730) }, { actors: ['ADMIN_G', 'ADMIN_P', 'OWNER'] });
  nd('terms-mirror-saved-stable-appoint-cr-150d', 'roles/appoint-cr', { ...bi(60, 365, 730) }, { actors: ['PRES', 'ADMIN_G'] });
  nd('terms-grantTerms-absent-builtin-30d-stable-appoint-cr-150d', 'roles/appoint-cr', { ...bi(30, 365, 730), 'config/grantTerms': null }, { actors: ['PRES', 'ADMIN_G'], info: true });
  nd('builtin-admin-caps-unticked-stable-admin-appoints-cr', 'roles/appoint-cr', { 'roles/builtin': { admin: { caps: ['readAuditAndRoster'], termDays: 730 }, president: { caps: CAPS.president, termDays: 365 }, cr: { caps: CAPS.cr, termDays: 183 } } }, { actors: ['ADMIN_G'], info: true });
  nd('heads-has-new-roles-marker-student-bump', 'heads/student-bump-own-campus', { 'heads/goa': { v: { grants: 3, roles: 4, 'roles/x': 1 } } }, { actors: ['STUDENT', 'PRES'] });
  nd('reviewGate-written-by-new-app-no-dept-read', 'read/reviewGate-goa', { 'reviewGate/goa': { on: true, by: { email: A.OWNER, name: 'o' }, at: { $ts: -1 }, auditId: 'x' } }, { actors: ['STUDENT', 'PRES'] });
  nd('reviewGate-new-no-dept-president-flips-it', 'gate/set-own-campus-goa', { 'reviewGate/goa': { on: true, by: { email: A.OWNER, name: 'o' }, at: { $ts: -1 }, auditId: 'x' } }, { actors: ['PRES', 'ADMIN_G'] });
  return out;
}
