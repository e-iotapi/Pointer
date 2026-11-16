// One probe per capability (CUSTOM_ROLES_PLAN.md Task B4): the smallest real
// request that reaches the capability's rules site, aimed at an in-scope
// target (Goa, ELEC, EEE F211) and an out-of-scope one (Hyderabad, CS,
// CS F211). capability_matrix.test.mjs runs every probe as every actor.
import {
  collection, doc, getDoc, increment, serverTimestamp, setDoc, writeBatch,
} from 'firebase/firestore';
import { DEFAULT_CAPS, OWNER, PRES, appoint, as, bump, name, seed } from './helpers.mjs';

export const IN = { campus: 'goa', dept: 'ELEC', course: 'EEE F211', n: 1 };
export const OUT = { campus: 'hyderabad', dept: 'CS', course: 'CS F211', n: 2 };
export const CR = 'f20240010@goa.bits-pilani.ac.in'; // holds the course grant for EEE F211

/// Rows with no site of their own in B4, so no probe:
///  - degreeRequirements: no writer exists yet.
///  - bulkUpload: a bulk upload writes the same offering documents as a save,
///    so the rules cannot tell them apart; the offering site accepts either
///    row (and courseStructures), and the app gates the screen.
export const UNENFORCED = ['degreeRequirements', 'bulkUpload'];

/// Appointment rows: a custom role holding only the row cannot appoint, since
/// the target's rows must lie inside the appointer's (B5).
export const APPOINT_ROWS = ['appointAdmins', 'appointPresidents', 'appointCrs'];

/// A role scope is the target of these rows' writes, so custom reach follows
/// the target's department like a department row.
export const TARGET_SCOPED = ['manageRoles'];

/// Rows only the app enforces (a screen, not a write).
export const APP_ONLY = ['openAs'];

/// Rows whose site runs out of lookups with the worst-case actor, so custom
/// roles cannot hold them (the built-in terms stay).
export const CUSTOM_EXCLUDED = [];

/// Rows whose site needs the writer to be on the target's campus (the rules
/// compare it with the address); owners are exempt.
export const OWN_CAMPUS_SITES = ['departmentResources', 'courseResources', 'publishDirectly', 'contribute'];

/// Rows a CR can use (the probe's request names their course).
export const COURSE_SITES = ['courseStructures', 'averages', 'courseResources'];

/// Campus-reach rows a built-in president reaches on their own campus.
export const PRESIDENT_CAMPUS_SITES = ['readAuditAndRoster', 'reviewGateSwitch'];

const audit = (b, db, actor, path, campus) => {
  const a = doc(collection(db, 'audit'));
  b.set(a, {
    actor: { email: actor, name: name(actor), role: 'test' }, action: 'probe', path, campus,
    at: serverTimestamp(),
  });
  return a.id;
};
const stamp = (actor, auditId) => ({
  updatedBy: { email: actor, name: name(actor) }, updatedAt: serverTimestamp(), auditId,
});
const mk = (setup, fn) => ({
  setup,
  inScope: (db, actor) => fn(db, actor, IN),
  outScope: (db, actor) => fn(db, actor, OUT),
});
const none = async () => {};

// ---- everywhere rows ----------------------------------------------------

const addRemoveOwners = mk(none, (db, actor, t) => {
  const b = writeBatch(db);
  const email = `new${t.n}@gmail.com`;
  const auditId = audit(b, db, actor, `owners/${email}`, 'all');
  b.set(doc(db, 'owners', email), {
    email, name: 'New', active: true, addedBy: { email: actor, name: name(actor) },
    addedAt: serverTimestamp(), auditId,
  });
  bump(b, db, 'all', 'owners');
  return b.commit();
});

const publish = mk(none, (db, actor, t) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, 'catalog/marker', 'all');
  b.set(doc(db, 'catalog', `v${t.n}`), { version: t.n, schema: 1, json: '{}' });
  b.set(doc(db, 'catalog', 'marker'), { version: t.n, schema: 1, auditId });
  return b.commit();
});

const publicContact = mk(none, (db, actor) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, 'config/public', 'all');
  b.set(doc(db, 'config', 'public'), {
    contactName: 'S', contactMethod: 'whatsapp', contactTarget: '+91', contactEnabled: true, auditId,
  });
  return b.commit();
});

const publishTimetable = mk(none, async (db, actor, t) => {
  const base = `goa|2026-${t.n}`;
  const marker = ((await getDoc(doc(db, 'heads', 'goa'))).data()?.v?.timetable ?? 0) + 1;
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, `timetable/${base}`, 'goa');
  b.set(doc(db, 'timetable', base), {
    v: 1, sem: `2026-${t.n}`, campus: 'goa', hours: { 1: [480, 540] }, examSlots: { FN: [570, 750] },
    events: [], chunks: 1, publishedAt: serverTimestamp(), marker, auditId,
  });
  b.set(doc(db, 'timetable', `${base}|0`), { n: 0, courses: { 'AAA F100': { t: 'x', sec: [] } } });
  b.set(doc(db, 'timetable', 'goa|current'), { sem: `2026-${t.n}`, marker });
  bump(b, db, 'goa', 'timetable');
  return b.commit();
});

// ---- professors ----------------------------------------------------------

const prof = (t) => ({
  campus: t.campus, department: t.dept, aliases: [], nameTokens: ['me'], mergedIds: [], active: true,
});

const professors = mk(none, (db, actor, t) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, `professors/p${t.n}`, t.campus);
  b.set(doc(db, 'professors', `p${t.n}`), { name: 'Dr. R. Menon', ...prof(t), ...stamp(actor, auditId) });
  bump(b, db, t.campus, `professors/${t.dept}`);
  return b.commit();
});

const mergeProfessors = mk(
  () => seed(async (db) => {
    for (const t of [IN, OUT]) {
      await setDoc(doc(db, 'professors', `a${t.n}`), { name: 'Ramesh Menon', ...prof(t) });
      await setDoc(doc(db, 'professors', `b${t.n}`), { name: 'Dr. R. Menon', ...prof(t) });
    }
  }),
  (db, actor, t) => {
    const b = writeBatch(db);
    const auditId = audit(b, db, actor, `professors/b${t.n}`, t.campus);
    b.update(doc(db, 'professors', `b${t.n}`), { mergedInto: `a${t.n}`, active: false, ...stamp(actor, auditId) });
    b.update(doc(db, 'professors', `a${t.n}`), {
      mergedIds: [`b${t.n}`], aliases: ['Dr. R. Menon'], ...stamp(actor, auditId),
    });
    bump(b, db, t.campus, `professors/${t.dept}`);
    return b.commit();
  },
);

// ---- offerings (course structures, averages) -------------------------------

const comps = [{ id: 'c1', name: 'Quiz', weight: 10, parts: [{ name: '', outOf: 20 }], countBest: 0 }];
const offId = (t) => `${t.campus}_2026-27-1`;
const offering = (db, actor, t, extra = {}) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, `courses/${t.course}/offerings/${offId(t)}`, t.campus);
  b.set(doc(db, 'courses', t.course, 'offerings', offId(t)), {
    courseId: t.course, campus: t.campus, term: '2026-27-1', weighted: true, totalMarks: 100,
    components: comps, professors: [], ...stamp(actor, auditId), ...extra,
  });
  return b.commit();
};

const courseStructures = mk(none, (db, actor, t) => offering(db, actor, t));

const averages = mk(
  () => seed(async (db) => {
    for (const t of [IN, OUT]) {
      await setDoc(doc(db, 'courses', t.course, 'offerings', offId(t)), {
        courseId: t.course, campus: t.campus, term: '2026-27-1', weighted: true, totalMarks: 100,
        components: comps, professors: [], updatedBy: { email: OWNER, name: name(OWNER) },
        updatedAt: new Date(), auditId: 'x',
      });
    }
  }),
  (db, actor, t) => offering(db, actor, t, { courseAverage: 55 }),
);

// ---- resources ---------------------------------------------------------------

const link = (t, extra = {}) => ({
  title: 'Notes', url: 'https://drive.google.com/x', host: 'drive.google.com', kind: 'folder',
  campus: t.campus, department: t.dept, scope: 'department', courseIds: [], pinnedToDepartment: false,
  removed: false, actingFor: '', ...extra,
});

const seedLinks = (extra) => () => seed(async (db) => {
  for (const t of [IN, OUT]) {
    await setDoc(doc(db, 'resources', `l${t.n}`), {
      ...link(t, extra(t)), addedBy: { email: PRES, name: name(PRES) }, addedAt: new Date(), auditId: 'x',
    });
    await setDoc(doc(db, 'resourceVersions', t.campus), { v: 5 });
  }
});

/// Edits a seeded link the way the app does: resource, audit, both version moves.
async function editLink(db, actor, t, extra) {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, `resources/l${t.n}`, t.campus);
  b.update(doc(db, 'resources', `l${t.n}`), { title: 'Renamed', ...extra, auditId });
  bump(b, db, t.campus, 'resources');
  b.set(doc(db, 'resourceVersions', t.campus), { v: 6 }, { merge: true });
  return b.commit();
}

const departmentResources = mk(seedLinks(() => ({})), (db, actor, t) => editLink(db, actor, t, {}));

const courseResources = mk(
  seedLinks((t) => ({ scope: 'course', courseIds: [t.course] })),
  (db, actor, t) => editLink(db, actor, t, actor === CR ? { actingFor: t.course } : {}),
);

/// A live (approved) department link, created in one batch.
const publishDirectly = mk(seedLinks(() => ({})), async (db, actor, t) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, `resources/new${t.n}`, t.campus);
  const r = link(t);
  b.set(doc(db, 'resources', `new${t.n}`), {
    ...r, addedBy: { email: actor, name: name(actor) }, addedAt: serverTimestamp(), auditId,
  });
  bump(b, db, t.campus, 'resources');
  b.set(doc(db, 'resourceVersions', t.campus), {
    v: 6, k: `new${t.n}`,
    links: { [`new${t.n}`]: {
      title: r.title, url: r.url, department: r.department, scope: r.scope,
      courseIds: r.courseIds, pinnedToDepartment: false,
    } },
  }, { merge: true });
  return b.commit();
});

/// A contributor-style link: unapproved, in a pending batch.
const contribute = mk(seedLinks(() => ({})), (db, actor, t) => {
  const b = writeBatch(db);
  const rid = `c${t.n}`;
  const auditId = audit(b, db, actor, `resources/${rid}`, t.campus);
  const r = link(t, { approved: false, publishedAt: serverTimestamp(), batchId: 'b1' });
  b.set(doc(db, 'resources', rid), {
    ...r, addedBy: { email: actor, name: name(actor) }, addedAt: serverTimestamp(), auditId,
  });
  b.set(doc(db, 'resourceVersions', t.campus), {
    v: 6, k: rid,
    links: { [rid]: {
      title: r.title, url: r.url, department: r.department, scope: r.scope,
      courseIds: r.courseIds, pinnedToDepartment: false, approved: false, publishedAt: r.publishedAt,
    } },
  }, { merge: true });
  b.set(doc(db, 'pending', `${t.campus}|${t.dept}`), {
    batches: { b1: { email: actor, username: 'cee', at: serverTimestamp(), links: { [rid]: { title: r.title, url: r.url } } } },
    b: 'b1', k: rid,
  }, { merge: true });
  b.set(doc(db, 'heads', t.campus), {
    v: { resources: increment(1), [`pending/${t.dept}`]: increment(1) },
  }, { merge: true });
  return b.commit();
});

// ---- reviews, roster, contributors, claims, gate ----------------------------

const moderateReviews = mk(
  () => seed(async (db) => {
    for (const t of [IN, OUT]) {
      await setDoc(doc(db, 'reviews', t.course, 'entries', `r${t.n}`), {
        courseId: t.course, department: t.dept, stars: 4, recommend: true, text: 'Good', campus: t.campus,
        term: '2025-26-2', professorId: null, hidden: false, helpful: 0, reports: 0,
        createdAt: new Date(), updatedAt: new Date(),
      });
      await setDoc(doc(db, 'courses', t.course, 'stats', t.campus), {
        count: 1, starSum: 4, recommendCount: 1, campus: t.campus, courseId: t.course,
        scope: 'course', professorId: null, touchedBy: 'x',
      });
    }
  }),
  (db, actor, t) => {
    const b = writeBatch(db);
    const id = `r${t.n}`;
    const auditId = audit(b, db, actor, `reviews/${t.course}/entries/${id}`, t.campus);
    b.update(doc(db, 'reviews', t.course, 'entries', id), {
      hidden: true, reason: 'Names a person', hiddenBy: { email: actor, name: name(actor) },
      auditId, moderatedAt: serverTimestamp(),
    });
    b.set(doc(db, 'courses', t.course, 'stats', t.campus), {
      count: increment(-1), starSum: increment(-4), recommendCount: increment(-1),
      campus: t.campus, courseId: t.course, scope: 'course', professorId: null, touchedBy: id,
    }, { merge: true });
    return b.commit();
  },
);

const readAuditAndRoster = mk(
  () => seed(async (db) => {
    for (const t of [IN, OUT]) {
      await setDoc(doc(db, 'audit', `e${t.n}`), {
        actor: { email: OWNER, name: name(OWNER), role: 'owner' }, action: 'x', path: 'x',
        campus: t.campus, at: new Date(),
      });
    }
  }),
  (db, actor, t) => getDoc(doc(db, 'audit', `e${t.n}`)),
);

const approveContributors = mk(
  () => seed(async (db) => {
    for (const t of [IN, OUT]) {
      const e = `f2023077${t.n}@${t.campus}.bits-pilani.ac.in`;
      await setDoc(doc(db, 'contributorRequests', `${t.campus}|${t.dept}|${e}`), {
        name: name(e), email: e, campus: t.campus, dept: t.dept, status: 'pending', createdAt: new Date(),
      });
    }
  }),
  (db, actor, t) => {
    const b = writeBatch(db);
    const e = `f2023077${t.n}@${t.campus}.bits-pilani.ac.in`;
    const id = `${t.campus}|${t.dept}|${e}`;
    const auditId = audit(b, db, actor, `contributorRequests/${id}`, t.campus);
    b.update(doc(db, 'contributorRequests', id), {
      status: 'declined', decidedBy: actor, decidedAt: serverTimestamp(), reason: 'no', auditId,
    });
    bump(b, db, t.campus, `contributorRequests/${t.dept}`);
    return b.commit();
  },
);

const claimElectives = mk(none, (db, actor, t) => {
  const b = writeBatch(db);
  const id = `${t.campus}|BITS F225`;
  const auditId = audit(b, db, actor, `courseClaims/${id}`, t.campus);
  b.set(doc(db, 'courseClaims', id), {
    campus: t.campus, courseId: 'BITS F225', dept: t.dept, by: { email: actor, name: name(actor) },
    at: serverTimestamp(), auditId,
  });
  bump(b, db, t.campus, 'courseClaims');
  return b.commit();
});

const reviewGateSwitch = mk(none, (db, actor, t) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, `reviewGate/${t.campus}`, t.campus);
  b.set(doc(db, 'reviewGate', t.campus), {
    on: true, by: { email: actor, name: name(actor) }, at: serverTimestamp(), auditId, dept: t.dept,
  });
  bump(b, db, t.campus, 'reviewGate');
  return b.commit();
});

// ---- appointments, roles, terms (B5) ---------------------------------------

const grantee = (t) => `f2023090${t.n}@${t.campus}.bits-pilani.ac.in`;
const seedGrantees = () => seed(async (db) => {
  for (const t of [IN, OUT]) {
    const email = grantee(t);
    await setDoc(doc(db, 'people', email), { name: name(email), campus: t.campus, firstSignIn: 1 });
  }
});

const appointAdmins = mk(seedGrantees, (db, actor, t) => appoint(
  db, actor, { role: 'admin', campus: 'all', scope: 'all', email: grantee(t) },
  { admin: true, campus: 'all' },
));

const appointPresidents = mk(seedGrantees, (db, actor, t) => appoint(
  db, actor, { role: 'dept', campus: t.campus, scope: t.dept, programme: 'A3', email: grantee(t) },
  { presidentOf: [t.dept], campus: t.campus },
));

const appointCrs = mk(seedGrantees, (db, actor, t) => appoint(
  db, actor, { role: 'course', campus: t.campus, scope: t.course, email: grantee(t) },
  { courses: [t.course], campus: t.campus },
));

/// A role with a row only the author holds, in the target's scope.
const manageRoles = mk(none, (db, actor, t) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, `roles/p${t.n}`, 'all');
  b.set(doc(db, 'roles', `p${t.n}`), {
    name: 'Probe', caps: ['manageRoles'], termDays: 10, campus: t.campus, dept: t.dept,
    createdBy: { email: actor, name: name(actor) }, updatedAt: serverTimestamp(), auditId,
  });
  bump(b, db, 'all', 'roles');
  return b.commit();
});

/// roles/builtin with one term changed (the setup seeds the defaults).
const termsProbe = (role) => mk(none, (db, actor, t) => {
  const b = writeBatch(db);
  const auditId = audit(b, db, actor, 'roles/builtin', 'all');
  const terms = { admin: 730, president: 365, cr: 183, [role]: 100 + t.n };
  b.set(doc(db, 'roles', 'builtin'), {
    admin: { caps: DEFAULT_CAPS.admin, termDays: terms.admin },
    president: { caps: DEFAULT_CAPS.president, termDays: terms.president },
    cr: { caps: DEFAULT_CAPS.cr, termDays: terms.cr },
    auditId,
  });
  bump(b, db, 'all', 'roles');
  return b.commit();
});
const grantTermsCrPresident = termsProbe('cr');
const grantTermsAdmin = termsProbe('admin');

export const PROBES = {
  appointAdmins, appointPresidents, appointCrs, manageRoles, grantTermsCrPresident, grantTermsAdmin,
  addRemoveOwners, publish, publicContact, publishTimetable, professors, mergeProfessors,
  courseStructures, averages, departmentResources, courseResources, publishDirectly, contribute,
  moderateReviews, readAuditAndRoster, approveContributors, claimElectives, reviewGateSwitch,
};
