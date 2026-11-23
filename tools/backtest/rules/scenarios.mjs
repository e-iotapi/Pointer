// The stable (origin/master) app's Firestore traffic, one scenario per call site family,
// with its exact payload shape (cited per scenario from lib/ at origin/master). A scenario
// is {id, area, actors:'all'|[names], w:false for read-only, seed?:{path:data}, run(h, db, email, who)};
// run throws when the rules refuse. replay.mjs runs it as every actor under old/new rules.
// ADD A SCENARIO HERE when the app gains a Firestore call site; add a fixture doc in
// fixtures/prod_shapes.json when it needs data.
const HEADS = ['goa', 'hyderabad', 'pilani', 'dubai']; // Campus.values: bumpPathOnAllHeads

export function scenarios(h) {
  const { A, doc, collection, writeBatch, serverTimestamp, increment, getDoc, getDocs, query, where, orderBy, limit, setDoc, updateDoc, deleteDoc, days, name, deleteField, collectionGroup } = h;
  const TARGET = A.TARGET;
  const gid = (role, campus, scope, email) => `${role}|${campus}|${scope}|${email}`;
  const roleOf = (who) => (who === 'OWNER' ? 'owner' : /ADMIN/.test(who) ? 'admin' : /PRES|SEC/.test(who) ? 'president' : who === 'CR' ? 'cr' : 'student');

  /// role_store.logInto
  const audit = (b, db, email, who, path, campus, { course, before = null, after = null } = {}) => {
    const r = doc(collection(db, 'audit'));
    b.set(r, { actor: { email, name: name(email), role: roleOf(who) }, action: 'x', summary: 'x', path, campus,
      ...(course ? { course } : {}), before, after, at: serverTimestamp() });
    return r.id;
  };
  const bumpOne = (b, db, campus, path) => b.set(doc(db, 'heads', campus), { v: { [path]: increment(1) } }, { merge: true });
  const bumpAll = (b, db, path) => HEADS.forEach((c) => bumpOne(b, db, c, path));
  /// role_store._bumpGrants
  const bumpGrants = (b, db, campus) => (campus === 'all' ? bumpAll(b, db, 'grants') : bumpOne(b, db, campus, 'grants'));
  /// StaffEntry.after (roles.dart): no `reach` field in the stable app.
  const staffSet = (b, db, g, s) => b.set(doc(db, 'staff', g.email), {
    email: g.email, name: s.name ?? name(g.email), campus: s.campus ?? g.campus, owner: false, admin: s.admin ?? false,
    presidentOf: s.presidentOf ?? [], courses: s.courses ?? [], expiresAt: s.expiresAt ?? g.expiresAt, lastGrant: gid(g.role, g.campus, g.scope, g.email) });

  /// role_store._writeGrant / _grantInto for a new grant.
  const appointB = (db, email, who, g, s) => {
    const b = writeBatch(db);
    const id = gid(g.role, g.campus, g.scope, g.email);
    const aid = audit(b, db, email, who, `grants/${id}`, g.campus, { course: g.role === 'course' ? g.scope : undefined });
    b.set(doc(db, 'grants', id), { active: true, expiresAt: g.expiresAt, auditId: aid, role: g.role, email: g.email, name: name(g.email),
      campus: g.campus, scope: g.scope, ...(g.programme ? { programme: g.programme } : {}), ...(g.secretary ? { secretary: true } : {}),
      grantedBy: { email, name: name(email) }, grantedAt: serverTimestamp() });
    staffSet(b, db, g, s);
    bumpGrants(b, db, g.campus);
    return b.commit();
  };
  /// the same for an existing grant: b.update(active, expiresAt, auditId[, programme]).
  const updateB = (db, email, who, g, s, { active = true } = {}) => {
    const b = writeBatch(db);
    const id = gid(g.role, g.campus, g.scope, g.email);
    const aid = audit(b, db, email, who, `grants/${id}`, g.campus, { course: g.role === 'course' ? g.scope : undefined });
    b.update(doc(db, 'grants', id), { active, expiresAt: g.expiresAt, auditId: aid, ...(g.programme ? { programme: g.programme } : {}) });
    staffSet(b, db, g, s);
    bumpGrants(b, db, g.campus);
    return b.commit();
  };
  const S = [];
  const add = (id, area, run, o = {}) => S.push({ id, area, run, ...o });

  // ---- role_store: appoint, renew, revoke, handover, terms, owners, public contact ----
  add('roles/appoint-cr', 'roles', (h_, db, e, w) => appointB(db, e, w,
    { role: 'course', campus: 'goa', scope: 'EEE F212', email: TARGET, expiresAt: days(150) }, { courses: ['EEE F212'] }));
  add('roles/appoint-cr-claimed-elective', 'roles', (h_, db, e, w) => appointB(db, e, w,
    { role: 'course', campus: 'goa', scope: 'GEN F101', email: TARGET, expiresAt: days(150) }, { courses: ['GEN F101'] }));
  add('roles/renew-cr', 'roles', (h_, db, e, w) => updateB(db, e, w,
    { role: 'course', campus: 'goa', scope: 'EEE F211', email: A.CR, expiresAt: days(170) }, { courses: ['EEE F211'] }));
  add('roles/revoke-cr', 'roles', (h_, db, e, w) => updateB(db, e, w,
    { role: 'course', campus: 'goa', scope: 'EEE F211', email: A.CR, expiresAt: days(100) }, { courses: [] }, { active: false }));
  add('roles/appoint-president', 'roles', (h_, db, e, w) => appointB(db, e, w,
    { role: 'dept', campus: 'goa', scope: 'CS', programme: 'A7', email: TARGET, expiresAt: days(300) }, { presidentOf: ['CS'] }));
  add('roles/renew-president', 'roles', (h_, db, e, w) => updateB(db, e, w,
    { role: 'dept', campus: 'goa', scope: 'ELEC', programme: 'A3', email: A.PRES, expiresAt: days(300) }, { presidentOf: ['ELEC'] }));
  // Composite production actors (an admin who is also a president; a president who is also a CR).
  add('roles/renew-president-cs', 'roles', (h_, db, e, w) => updateB(db, e, w,
    { role: 'dept', campus: 'goa', scope: 'CS', programme: 'A7', email: A.MULTI, expiresAt: days(300) }, { presidentOf: ['CS'], courses: ['CS F111'] }),
    { actors: ['ADMIN_G', 'ADMINPRES', 'OWNER', 'MULTI', 'PRES'] });
  add('roles/appoint-cr-cs', 'roles', (h_, db, e, w) => appointB(db, e, w,
    { role: 'course', campus: 'goa', scope: 'CS F211', email: TARGET, expiresAt: days(150) }, { courses: ['CS F211'] }),
    { actors: ['MULTI', 'ADMIN_G', 'ADMINPRES', 'OWNER', 'PRES'] });
  add('roles/renew-cr-by-multi-own-cr-course', 'roles', (h_, db, e, w) => updateB(db, e, w,
    { role: 'course', campus: 'goa', scope: 'CS F111', email: A.MULTI, expiresAt: days(170) }, { presidentOf: ['CS'], courses: ['CS F111'] }),
    { actors: ['MULTI', 'ADMIN_G', 'ADMINPRES', 'OWNER'] });
  add('roles/revoke-president', 'roles', (h_, db, e, w) => updateB(db, e, w,
    { role: 'dept', campus: 'goa', scope: 'ELEC', programme: 'A3', email: A.PRES, expiresAt: days(100) }, { presidentOf: [] }, { active: false }));
  add('roles/appoint-secretary', 'roles', (h_, db, e, w) => appointB(db, e, w,
    { role: 'dept', campus: 'goa', scope: 'ELEC', programme: 'A3', secretary: true, email: TARGET, expiresAt: days(300) }, { presidentOf: ['ELEC'] }));
  add('roles/appoint-admin', 'roles', (h_, db, e, w) => appointB(db, e, w,
    { role: 'admin', campus: 'all', scope: 'all', email: TARGET, expiresAt: days(600) }, { admin: true, campus: 'all' }));
  add('roles/revoke-admin', 'roles', (h_, db, e, w) => updateB(db, e, w,
    { role: 'admin', campus: 'all', scope: 'all', email: A.ADMIN_G, expiresAt: days(100) }, { admin: false, campus: 'all' }, { active: false }));
  add('roles/appoint-cr-pilani-person-by-admin', 'roles', (h_, db, e, w) => appointB(db, e, w,
    { role: 'course', campus: 'pilani', scope: 'EEE F211', email: 'f20230555@pilani.bits-pilani.ac.in', expiresAt: days(150) }, { courses: ['EEE F211'] }),
    { actors: ['ADMIN_P', 'ADMIN_G', 'OWNER', 'PRES'], seed: { 'people/f20230555@pilani.bits-pilani.ac.in': { name: 'Name of f20230555', campus: 'pilani', firstSignIn: 1 } } });
  // contacts.dart / role_store handover: the batch from the old contacts.test.mjs.
  add('roles/handover', 'roles', async (h_, db, e, w) => {
    const b = writeBatch(db);
    const mine = gid('dept', 'goa', 'ELEC', e); const next = gid('dept', 'goa', 'ELEC', TARGET);
    // expiresBefore must equal the grant's own expiry, so read it as the app does (RoleStore.grant).
    const before = (await getDoc(doc(db, 'grants', mine))).data()?.expiresAt ?? days(100);
    b.set(doc(db, 'grants', next), { role: 'dept', campus: 'goa', scope: 'ELEC', programme: 'A3', email: TARGET, name: name(TARGET), active: true,
      expiresAt: days(300), grantedBy: { email: e, name: name(e) }, grantedAt: serverTimestamp(), auditId: audit(b, db, e, w, `grants/${next}`, 'goa') });
    b.set(doc(db, 'staff', TARGET), { email: TARGET, name: name(TARGET), campus: 'goa', owner: false, admin: false, presidentOf: ['ELEC'], courses: [], expiresAt: days(300), lastGrant: next });
    b.update(doc(db, 'grants', mine), { expiresAt: days(19.9), handedTo: TARGET, expiresBefore: before, auditId: audit(b, db, e, w, `grants/${mine}`, 'goa') });
    b.set(doc(db, 'staff', e), { email: e, name: name(e), campus: 'goa', owner: false, admin: e === A.ADMINPRES, presidentOf: ['ELEC'], courses: [], expiresAt: before, lastGrant: mine });
    bumpOne(b, db, 'goa', 'grants');
    await b.commit();
  }, { actors: ['PRES', 'SEC', 'ADMINPRES', 'STUDENT', 'ADMIN_G', 'OWNER'] });
  add('roles/save-terms', 'roles', async (h_, db, e, w) => {
    const b = writeBatch(db);
    const id = audit(b, db, e, w, 'config/grantTerms', 'all');
    b.set(doc(db, 'config', 'grantTerms'), { crDays: 200, presidentDays: 365, adminDays: 730, auditId: id });
    bumpAll(b, db, 'terms');
    await b.commit();
  });
  add('roles/add-owner', 'roles', async (h_, db, e, w) => {
    const b = writeBatch(db);
    const id = audit(b, db, e, w, 'owners/new@gmail.com', 'all');
    b.set(doc(db, 'owners', 'new@gmail.com'), { email: 'new@gmail.com', name: 'New', active: true, addedBy: { email: e, name: name(e) }, addedAt: serverTimestamp(), auditId: id });
    bumpAll(b, db, 'owners');
    await b.commit();
  });
  add('roles/save-public-contact', 'roles', async (h_, db, e, w) => {
    const b = writeBatch(db);
    const id = audit(b, db, e, w, 'config/public', 'all');
    b.set(doc(db, 'config', 'public'), { contactName: 'Help', contactMethod: 'email', contactTarget: 'help@x.org', contactEnabled: true,
      updatedBy: { email: e, name: name(e) }, updatedAt: serverTimestamp(), auditId: id });
    for (const c of HEADS) b.set(doc(db, 'heads', c), { contact: { contactName: 'Help', contactMethod: 'email', contactTarget: 'help@x.org', contactEnabled: true } }, { merge: true });
    await b.commit();
  });
  // reads: loadMine, audit, terms, people, staff, grants
  add('read/loadMine-owner-doc', 'roles', (h_, db, e) => getDoc(doc(db, 'owners', e)), { w: false });
  add('read/loadMine-grants-by-email', 'roles', (h_, db, e) => getDocs(query(collection(db, 'grants'), where('email', '==', e))), { w: false });
  add('read/grant-get-missing', 'roles', (h_, db, e) => getDoc(doc(db, 'grants', gid('course', 'goa', 'EEE F999', TARGET))), { w: false });
  add('read/grantTerms', 'roles', (h_, db) => getDoc(doc(db, 'config', 'grantTerms')), { w: false });
  add('read/public-contact', 'roles', (h_, db) => getDoc(doc(db, 'config', 'public')), { w: false });
  add('read/person', 'roles', (h_, db) => getDoc(doc(db, 'people', TARGET)), { w: false });
  add('read/audit-newest-goa', 'roles', (h_, db) => getDocs(query(collection(db, 'audit'), where('campus', 'in', ['goa', 'all']), orderBy('at', 'desc'), limit(50))), { w: false });
  add('read/staff-own', 'roles', (h_, db, e) => getDoc(doc(db, 'staff', e)), { w: false });
  add('read/staff-other', 'roles', (h_, db) => getDoc(doc(db, 'staff', A.CR)), { w: false });
  add('read/roster-grants-goa', 'roles', (h_, db) => getDocs(query(collection(db, 'grants'), where('campus', '==', 'goa'))), { w: false });
  add('read/owners-list', 'roles', (h_, db) => getDocs(collection(db, 'owners')), { w: false });
  add('read/staff-list', 'roles', (h_, db) => getDocs(collection(db, 'staff')), { w: false });
  add('read/heads-goa', 'heads', (h_, db) => getDoc(doc(db, 'heads', 'goa')), { w: false });
  add('read/heads-pilani', 'heads', (h_, db) => getDoc(doc(db, 'heads', 'pilani')), { w: false });
  add('read/reviewGate-goa', 'reviews', (h_, db) => getDoc(doc(db, 'reviewGate', 'goa')), { w: false });

  // ---- people / users / heads ----
  add('people/first-sign-in', 'people', (h_, db, e) => setDoc(doc(db, 'people', e), { name: 'x', campus: e.split('@')[1].split('.')[0], firstSignIn: Date.now(), lastSeen: Date.now() }));
  add('people/last-seen', 'people', (h_, db, e) => updateDoc(doc(db, 'people', e), { lastSeen: Date.now() }));
  add('users/sync-push', 'users', (h_, db, e) => setDoc(doc(db, 'users', `uid-${e.split('@')[0]}`), { rev: 1, data: '{"courses":[]}', uid: `uid-${e.split('@')[0]}` }));
  add('users/sync-pull-check', 'users', (h_, db, e) => getDocs(query(collection(db, 'users'), where('uid', '==', `uid-${e.split('@')[0]}`))), { w: false });
  add('heads/student-bump-own-campus', 'heads', (h_, db, e) => setDoc(doc(db, 'heads', e.split('@')[1].split('.')[0]), { v: { reviews: increment(1) } }, { merge: true }));

  // ---- reviewGate (gate_store.set stable: on, by, at, auditId[, dept]) ----
  const gate = (campus, withDept) => async (h_, db, e, w) => {
    const b = writeBatch(db);
    const id = audit(b, db, e, w, `reviewGate/${campus}`, campus);
    b.set(doc(db, 'reviewGate', campus), { on: true, by: { email: e, name: name(e) }, at: serverTimestamp(), auditId: id, ...(withDept ? { dept: 'ELEC' } : {}) });
    bumpOne(b, db, campus, 'reviewGate');
    await b.commit();
  };
  add('gate/set-own-campus-goa', 'reviews', gate('goa', true));
  add('gate/set-other-campus-pilani', 'reviews', gate('pilani', false));

  // ---- courses, offerings (maintain_store / publish) ----
  const offering = (course, off) => async (h_, db, e, w) => {
    const b = writeBatch(db);
    const [campus, term] = off.split('_'); const path = `courses/${course}/offerings/${off}`;
    const id = audit(b, db, e, w, path, campus, { course });
    b.set(doc(db, path), { courseId: course, campus, term, weighted: true, totalMarks: 100,
      components: [{ id: 'c1', name: 'Quiz', weight: 10, parts: [{ name: '', outOf: 20 }], countBest: 0 }], professors: [],
      updatedBy: { email: e, name: name(e) }, updatedAt: serverTimestamp(), auditId: id });
    bumpOne(b, db, campus, `offerings/${course}`);
    await b.commit();
  };
  add('offering/EEE-F111-goa', 'courses', offering('EEE F111', 'goa_2026-27-1'));
  add('offering/EEE-F211-goa-own-course', 'courses', offering('EEE F211', 'goa_2026-27-1'));
  add('offering/CS-F211-goa-other-dept', 'courses', offering('CS F211', 'goa_2026-27-1'));
  add('offering/EEE-F111-pilani-other-campus', 'courses', offering('EEE F111', 'pilani_2026-27-1'));
  add('course/draft-create', 'courses', async (h_, db, e, w) => {
    const b = writeBatch(db);
    const id = audit(b, db, e, w, 'courses/EEE F500', 'goa');
    b.set(doc(db, 'courses', 'EEE F500'), { id: 'EEE F500', title: 'New', credits: 3, retired: false, elective: true, draft: true, auditId: id, updatedBy: { email: e, name: name(e) }, updatedAt: serverTimestamp() });
    await b.commit();
  });
  add('read/course-doc', 'courses', (h_, db) => getDoc(doc(db, 'courses', 'EEE F211')), { w: false });
  add('read/offering-doc', 'courses', (h_, db) => getDoc(doc(db, 'courses', 'EEE F211', 'offerings', 'goa_2025-26-2')), { w: false });

  // ---- professors (professor_store) ----
  const stamp = (e, a) => ({ updatedBy: { email: e, name: name(e) }, updatedAt: serverTimestamp(), auditId: a });
  add('prof/add-ELEC', 'professors', async (h_, db, e, w) => {
    const b = writeBatch(db); const a = audit(b, db, e, w, 'professors/pnew', 'goa');
    b.set(doc(db, 'professors', 'pnew'), { name: 'Dr. R. Menon', campus: 'goa', department: 'ELEC', aliases: [], nameTokens: ['r', 'm'], mergedIds: [], active: true, ...stamp(e, a) });
    bumpOne(b, db, 'goa', 'professors/ELEC'); await b.commit();
  });
  add('prof/add-CS', 'professors', async (h_, db, e, w) => {
    const b = writeBatch(db); const a = audit(b, db, e, w, 'professors/pnew', 'goa');
    b.set(doc(db, 'professors', 'pnew'), { name: 'Dr. R. Menon', campus: 'goa', department: 'CS', aliases: [], nameTokens: ['r', 'm'], mergedIds: [], active: true, ...stamp(e, a) });
    bumpOne(b, db, 'goa', 'professors/CS'); await b.commit();
  });
  add('prof/merge-p2-into-p1', 'professors', async (h_, db, e, w) => {
    const b = writeBatch(db); const a = audit(b, db, e, w, 'professors/p2', 'goa');
    b.update(doc(db, 'professors', 'p2'), { mergedInto: 'p1', active: false, ...stamp(e, a) });
    b.update(doc(db, 'professors', 'p1'), { mergedIds: ['p2'], aliases: ['Dr. R. Menon'], ...stamp(e, a) });
    bumpOne(b, db, 'goa', 'professors/ELEC'); await b.commit();
  });
  add('read/professor', 'professors', (h_, db) => getDoc(doc(db, 'professors', 'p1')), { w: false });

  // ---- resources (resource_store: resource + audit + marker + resourceVersions) ----
  const resBase = { title: 'Notes', url: 'https://drive.google.com/drive/folders/xyz', host: 'drive.google.com', kind: 'folder', campus: 'goa', department: 'ELEC',
    scope: 'department', courseIds: [], pinnedToDepartment: false, removed: false, actingFor: '' };
  add('res/create-dept-link', 'resources', async (h_, db, e, w) => {
    const b = writeBatch(db); const a = audit(b, db, e, w, 'resources/rnew', 'goa');
    b.set(doc(db, 'resources', 'rnew'), { ...resBase, addedBy: { email: e, name: name(e) }, addedAt: serverTimestamp(), auditId: a });
    bumpOne(b, db, 'goa', 'resources');
    const v = (await getDoc(doc(db, 'resourceVersions', 'goa'))).data()?.v ?? 0;
    b.set(doc(db, 'resourceVersions', 'goa'), { v: v + 1, k: 'rnew', links: { rnew: { title: 'Notes', url: resBase.url, department: 'ELEC', scope: 'department', courseIds: [], pinnedToDepartment: false } } }, { merge: true });
    await b.commit();
  });
  add('res/create-other-campus', 'resources', async (h_, db, e, w) => {
    const b = writeBatch(db); const a = audit(b, db, e, w, 'resources/rnew', 'pilani');
    b.set(doc(db, 'resources', 'rnew'), { ...resBase, campus: 'pilani', addedBy: { email: e, name: name(e) }, addedAt: serverTimestamp(), auditId: a });
    bumpOne(b, db, 'pilani', 'resources');
    b.set(doc(db, 'resourceVersions', 'pilani'), { v: 1, k: 'rnew', links: { rnew: { title: 'Notes', url: resBase.url, department: 'ELEC', scope: 'department', courseIds: [], pinnedToDepartment: false } } }, { merge: true });
    await b.commit();
  });
  add('res/soft-remove', 'resources', async (h_, db, e, w) => {
    const b = writeBatch(db); const a = audit(b, db, e, w, 'resources/r1', 'goa');
    b.update(doc(db, 'resources', 'r1'), { removed: true, removedBy: { email: e, name: name(e) }, removedAt: serverTimestamp(), auditId: a });
    bumpOne(b, db, 'goa', 'resources');
    const v = (await getDoc(doc(db, 'resourceVersions', 'goa'))).data()?.v ?? 0;
    b.set(doc(db, 'resourceVersions', 'goa'), { v: v + 1 }, { merge: true });
    await b.commit();
  });
  add('read/resources-goa-list', 'resources', (h_, db) => getDocs(query(collection(db, 'resources'), where('campus', '==', 'goa'), where('removed', '==', false))), { w: false });
  add('read/resourceVersions-goa', 'resources', (h_, db) => getDoc(doc(db, 'resourceVersions', 'goa')), { w: false });

  // ---- reviews (review_store): review + stats counters + reviewIndex + mirror + marker ----
  add('review/post', 'reviews', async (h_, db, e) => {
    const sha = (await import('node:crypto')).createHash('sha256').update(`uid-${e.split('@')[0]}EEE F211`).digest('hex');
    const C = 'EEE F211'; const b = writeBatch(db);
    const d = { courseId: C, department: 'ELEC', stars: 4, recommend: true, text: 'Good', campus: 'goa', term: '2025-26-2', professorId: 'p1', hidden: false, helpful: 0, reports: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    b.set(doc(db, 'reviews', C, 'entries', sha), d);
    for (const p of [null, 'p1']) b.set(doc(db, 'courses', C, 'stats', p ? `goa_${p}` : 'goa'), { count: increment(1), starSum: increment(4), recommendCount: increment(1), campus: 'goa', courseId: C, scope: p ? 'professor' : 'course', professorId: p, touchedBy: sha }, { merge: true });
    b.set(doc(db, 'reviewIndex', 'goa'), { k: C, c: { [C]: { count: increment(1), starSum: increment(4), recommendCount: increment(1) } } }, { merge: true });
    bumpOne(b, db, 'goa', 'reviews');
    b.set(doc(db, 'reviews', C, 'campus', 'goa'), { k: sha, r: { [sha]: { stars: 4, recommend: true, text: 'Good', term: '2025-26-2', professorId: 'p1', helpful: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } } }, { merge: true });
    bumpOne(b, db, 'goa', `reviews/${C}`);
    await b.commit();
  }, { actors: ['STUDENT', 'CR', 'PRES', 'SEC', 'ADMIN_G', 'ADMINPRES', 'MULTI', 'CONTRIB', 'OTHER', 'FACULTY'] });

  // ---- contributors: apply (contributor_store) ----
  add('contrib/apply', 'contributors', async (h_, db, e) => {
    const b = writeBatch(db);
    b.set(doc(db, 'contributorRequests', `goa|CS|${e}`), { name: name(e), email: e, campus: 'goa', dept: 'CS', status: 'pending', createdAt: serverTimestamp() });
    bumpOne(b, db, 'goa', 'contributorRequests/CS');
    await b.commit();
  }, { actors: ['STUDENT', 'CR', 'MULTI', 'OTHER', 'FACULTY', 'PRES'] });

  // ---- courseClaims (claim_store) ----
  add('claim/create-elective', 'claims', async (h_, db, e, w) => {
    const b = writeBatch(db); const id = 'goa|GEN F102';
    const a = audit(b, db, e, w, `courseClaims/${id}`, 'goa');
    b.set(doc(db, 'courseClaims', id), { campus: 'goa', courseId: 'GEN F102', dept: 'ELEC', by: { email: e, name: name(e) }, at: serverTimestamp(), auditId: a });
    bumpOne(b, db, 'goa', 'courseClaims'); await b.commit();
  });
  add('claim/create-elective-pilani', 'claims', async (h_, db, e, w) => {
    const b = writeBatch(db); const id = 'pilani|GEN F102';
    const a = audit(b, db, e, w, `courseClaims/${id}`, 'pilani');
    b.set(doc(db, 'courseClaims', id), { campus: 'pilani', courseId: 'GEN F102', dept: 'ELEC', by: { email: e, name: name(e) }, at: serverTimestamp(), auditId: a });
    bumpOne(b, db, 'pilani', 'courseClaims'); await b.commit();
  });
  add('read/claims', 'claims', (h_, db) => getDocs(collection(db, 'courseClaims')), { w: false });

  return S;
}
