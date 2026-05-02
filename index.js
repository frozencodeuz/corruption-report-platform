require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

process.env.TZ = 'Asia/Tashkent';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const RESET_ADMIN_PASSWORD = String(process.env.RESET_ADMIN_PASSWORD || 'false').toLowerCase() === 'true';
const DATABASE_PATH = path.resolve(process.env.DATABASE_PATH || './data/database.json');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const MAX_FILES = Number(process.env.MAX_FILES || 5);

const STATUSES = {
  new: { label: 'Янги', short: 'Янги', tone: 'new', icon: '●' },
  reviewing: { label: 'Кўриб чиқилмоқда', short: 'Ижрода', tone: 'reviewing', icon: '◐' },
  checked: { label: 'Ўрганилди', short: 'Ўрганилди', tone: 'checked', icon: '✓' },
  baseless: { label: 'Асоссиз', short: 'Асоссиз', tone: 'baseless', icon: '!' },
  closed: { label: 'Ёпилди', short: 'Ёпилди', tone: 'closed', icon: '■' },
};

const PRIORITIES = {
  normal: 'Оддий',
  important: 'Муҳим',
  urgent: 'Тезкор',
};

const INCIDENT_TYPES = {
  bribery: 'Пора талаб қилиш ёки таклиф қилиш',
  abuse: 'Мансаб ваколатини суиистеъмол қилиш',
  barrier: 'Сунъий тўсиқ яратиш',
  conflict: 'Манфаатлар тўқнашуви',
  other: 'Бошқа шубҳали ҳолат',
};

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function now() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function h(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(value) {
  return h(value).replace(/\n/g, '<br>');
}

function readDb() {
  if (!fs.existsSync(DATABASE_PATH)) {
    return { reports: [], files: [], admins: [], logs: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATABASE_PATH, 'utf8'));
    return {
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
      admins: Array.isArray(parsed.admins) ? parsed.admins : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    };
  } catch (error) {
    console.error('Database read error:', error.message);
    return { reports: [], files: [], admins: [], logs: [] };
  }
}

function writeDb(db) {
  const safeDb = {
    reports: Array.isArray(db.reports) ? db.reports : [],
    files: Array.isArray(db.files) ? db.files : [],
    admins: Array.isArray(db.admins) ? db.admins : [],
    logs: Array.isArray(db.logs) ? db.logs : [],
  };

  fs.writeFileSync(DATABASE_PATH, JSON.stringify(safeDb, null, 2));
}

async function initDb() {
  const db = readDb();
  const existingAdmin = db.admins.find((a) => a.username === ADMIN_USERNAME);
  const createdAt = now();

  if (!existingAdmin) {
    db.admins.push({
      id: Date.now(),
      username: ADMIN_USERNAME,
      password_hash: await bcrypt.hash(ADMIN_PASSWORD, 12),
      created_at: createdAt,
      updated_at: createdAt,
    });
    writeDb(db);
    return;
  }

  if (RESET_ADMIN_PASSWORD) {
    existingAdmin.password_hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    existingAdmin.updated_at = createdAt;
    writeDb(db);
  }
}

function generateReportId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const random = Math.floor(1000 + Math.random() * 9000);
  return `KOR-${y}${m}${day}-${Date.now().toString().slice(-6)}${random}`;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[\s()-]/g, '').trim();
}

function displayPhone(phone) {
  const raw = normalizePhone(phone);
  if (/^\+?998\d{9}$/.test(raw)) {
    const p = raw.startsWith('+') ? raw : `+${raw}`;
    return `${p.slice(0, 4)} ${p.slice(4, 6)} ${p.slice(6, 9)} ${p.slice(9, 11)} ${p.slice(11, 13)}`;
  }
  return raw;
}

function isValidPhone(phone) {
  return /^\+?998\d{9}$/.test(phone) || /^\d{7,15}$/.test(phone);
}

function statusLabel(status) {
  return STATUSES[status]?.label || status || 'Номаълум';
}

function priorityLabel(priority) {
  return PRIORITIES[priority] || PRIORITIES.normal;
}

function incidentTypeLabel(type) {
  return INCIDENT_TYPES[type] || INCIDENT_TYPES.other;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect('/admin/login');
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n\r;]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function getReports({ status = '', q = '', priority = '', from = '', to = '' } = {}) {
  const db = readDb();
  let reports = [...db.reports];

  if (status) reports = reports.filter((r) => r.status === status);
  if (priority) reports = reports.filter((r) => (r.priority || 'normal') === priority);
  if (from) reports = reports.filter((r) => String(r.created_at || '').slice(0, 10) >= from);
  if (to) reports = reports.filter((r) => String(r.created_at || '').slice(0, 10) <= to);

  if (q) {
    const needle = q.toLowerCase();
    reports = reports.filter((r) => {
      return [r.id, r.phone, r.place, r.message, r.incident_type, r.responsible_person, r.admin_note]
        .some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }

  return reports
    .map((report) => ({
      ...report,
      file_count: db.files.filter((f) => f.report_id === report.id).length,
      status_label: statusLabel(report.status),
      priority_label: priorityLabel(report.priority || 'normal'),
      incident_type_label: incidentTypeLabel(report.incident_type || 'other'),
      phone_display: displayPhone(report.phone),
    }))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function getReport(id) {
  const db = readDb();
  const report = db.reports.find((r) => r.id === id) || null;
  if (!report) return null;

  return {
    ...report,
    status_label: statusLabel(report.status),
    priority_label: priorityLabel(report.priority || 'normal'),
    incident_type_label: incidentTypeLabel(report.incident_type || 'other'),
    phone_display: displayPhone(report.phone),
  };
}

function getReportFiles(reportId) {
  const db = readDb();
  return db.files.filter((f) => f.report_id === reportId).sort((a, b) => b.id - a.id);
}

function getReportLogs(reportId) {
  const db = readDb();
  return db.logs.filter((log) => log.report_id === reportId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function getCounts() {
  const db = readDb();
  const total = db.reports.length;
  const counts = {
    total,
    with_files: 0,
    today: 0,
    new: 0,
    reviewing: 0,
    checked: 0,
    baseless: 0,
    closed: 0,
    urgent: 0,
  };
  const today = todayDate();

  for (const report of db.reports) {
    counts[report.status] = (counts[report.status] || 0) + 1;
    if (String(report.created_at || '').startsWith(today)) counts.today += 1;
    if ((report.priority || 'normal') === 'urgent') counts.urgent += 1;
    if (db.files.some((f) => f.report_id === report.id)) counts.with_files += 1;
  }

  return counts;
}

function addLog(db, reportId, action, details, adminUsername = 'system') {
  db.logs.push({
    id: Date.now() + Math.floor(Math.random() * 100000),
    report_id: reportId,
    action,
    details,
    admin: adminUsername,
    created_at: now(),
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ext && ext.length <= 10 ? ext : '';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
]);

const upload = multer({
  storage,
  limits: {
    files: MAX_FILES,
    fileSize: MAX_FILE_MB * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (allowedMimeTypes.has(file.mimetype)) return cb(null, true);
    return cb(new Error('Фақат JPG, PNG, WEBP, GIF, MP4, MOV, WEBM ёки PDF файллар қабул қилинади.'));
  },
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Жуда кўп уриниш. Илтимос, бироздан кейин қайта уриниб кўринг.',
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Жуда кўп уриниш. Илтимос, бироздан кейин қайта уриниб кўринг.',
});

app.locals.h = h;
app.locals.nl2br = nl2br;
app.locals.statusLabel = statusLabel;
app.locals.priorityLabel = priorityLabel;
app.locals.incidentTypeLabel = incidentTypeLabel;
app.locals.STATUSES = STATUSES;
app.locals.PRIORITIES = PRIORITIES;
app.locals.INCIDENT_TYPES = INCIDENT_TYPES;
app.locals.MAX_FILE_MB = MAX_FILE_MB;
app.locals.MAX_FILES = MAX_FILES;

app.use((req, res, next) => {
  res.locals.h = h;
  res.locals.nl2br = nl2br;
  res.locals.statusLabel = statusLabel;
  res.locals.priorityLabel = priorityLabel;
  res.locals.incidentTypeLabel = incidentTypeLabel;
  res.locals.STATUSES = STATUSES;
  res.locals.PRIORITIES = PRIORITIES;
  res.locals.INCIDENT_TYPES = INCIDENT_TYPES;
  res.locals.MAX_FILE_MB = MAX_FILE_MB;
  res.locals.MAX_FILES = MAX_FILES;
  next();
});

app.get('/', (req, res) => {
  res.render('index', {
    title: 'Коррупцион ҳолатлар бўйича аноним хабар бериш',
    error: null,
    old: {},
  });
});

app.post('/submit', submitLimiter, (req, res) => {
  upload.array('evidence', MAX_FILES)(req, res, (err) => {
    const uploadedFiles = req.files || [];

    try {
      if (err) throw err;

      const phone = normalizePhone(req.body.phone);
      const place = String(req.body.place || '').trim();
      const eventDate = String(req.body.event_date || '').trim();
      const incidentType = String(req.body.incident_type || 'other').trim();
      const message = String(req.body.message || '').trim();
      const consent = req.body.consent === 'on';

      if (!isValidPhone(phone)) {
        throw new Error('Телефон рақамни тўғри киритинг. Масалан: +998901234567');
      }

      if (!INCIDENT_TYPES[incidentType]) {
        throw new Error('Ҳолат турини тўғри танланг.');
      }

      if (place.length < 3) {
        throw new Error('Ҳолат содир бўлган жойни аниқроқ киритинг.');
      }

      if (message.length < 30) {
        throw new Error('Ҳолат мазмуни жуда қисқа. Илтимос, камида 30 белгидан иборат батафсил маълумот ёзинг.');
      }

      if (!consent) {
        throw new Error('Маълумотлар тўғри ва холис эканини тасдиқлашингиз керак.');
      }

      const db = readDb();
      const id = generateReportId();
      const createdAt = now();

      const report = {
        id,
        phone,
        place,
        event_date: eventDate,
        incident_type: incidentType,
        message,
        status: 'new',
        priority: 'normal',
        responsible_person: '',
        admin_note: '',
        created_at: createdAt,
        updated_at: createdAt,
      };

      db.reports.push(report);

      for (const file of uploadedFiles) {
        db.files.push({
          id: Date.now() + Math.floor(Math.random() * 100000),
          report_id: id,
          filename: file.filename,
          original_name: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          created_at: createdAt,
        });
      }

      addLog(db, id, 'created', 'Фуқаро томонидан янги хабар юборилди.', 'system');
      writeDb(db);
      return res.redirect(`/success/${encodeURIComponent(id)}`);
    } catch (e) {
      for (const file of uploadedFiles) {
        fs.unlink(path.join(UPLOAD_DIR, file.filename), () => {});
      }

      return res.status(400).render('index', {
        title: 'Коррупцион ҳолатлар бўйича аноним хабар бериш',
        error: e.message || 'Маълумот юборишда хатолик юз берди.',
        old: req.body || {},
      });
    }
  });
});

app.get('/success/:id', (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.redirect('/');

  res.render('success', {
    title: 'Хабар қабул қилинди',
    report,
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  const status = String(req.query.status || '').trim();
  const q = String(req.query.q || '').trim();
  const priority = String(req.query.priority || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const reports = getReports({ status, q, priority, from, to });
  const counts = getCounts();

  res.render('admin-dashboard', {
    title: 'Админ панел',
    reports,
    counts,
    filters: { status, q, priority, from, to },
    adminUsername: req.session.adminUsername,
  });
});

app.get('/admin/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin-login', {
    title: 'Админ панелга кириш',
    error: null,
  });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const db = readDb();
  const admin = db.admins.find((a) => a.username === username);
  const ok = admin ? await bcrypt.compare(password, admin.password_hash) : false;

  if (!ok) {
    return res.status(401).render('admin-login', {
      title: 'Админ панелга кириш',
      error: 'Логин ёки пароль нотўғри.',
    });
  }

  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.redirect('/admin');
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin/reports/:id', requireAdmin, (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).send('Хабар топилмади.');

  const files = getReportFiles(report.id);
  const logs = getReportLogs(report.id);

  res.render('admin-report', {
    title: `Хабар ${report.id}`,
    report,
    files,
    logs,
    adminUsername: req.session.adminUsername,
  });
});

app.post('/admin/reports/:id/update', requireAdmin, (req, res) => {
  const status = String(req.body.status || '').trim();
  const priority = String(req.body.priority || 'normal').trim();
  const responsiblePerson = String(req.body.responsible_person || '').trim();
  const adminNote = String(req.body.admin_note || '').trim();
  const allowedStatuses = new Set(Object.keys(STATUSES));
  const allowedPriorities = new Set(Object.keys(PRIORITIES));

  if (!allowedStatuses.has(status)) return res.status(400).send('Нотўғри статус.');
  if (!allowedPriorities.has(priority)) return res.status(400).send('Нотўғри муҳимлик даражаси.');

  const db = readDb();
  const report = db.reports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).send('Хабар топилмади.');

  const changes = [];
  if (report.status !== status) changes.push(`Статус: ${statusLabel(report.status)} → ${statusLabel(status)}`);
  if ((report.priority || 'normal') !== priority) changes.push(`Муҳимлик: ${priorityLabel(report.priority || 'normal')} → ${priorityLabel(priority)}`);
  if ((report.responsible_person || '') !== responsiblePerson) changes.push('Масъул ходим янгиланди');
  if ((report.admin_note || '') !== adminNote) changes.push('Ички изоҳ янгиланди');

  report.status = status;
  report.priority = priority;
  report.responsible_person = responsiblePerson;
  report.admin_note = adminNote;
  report.updated_at = now();

  addLog(db, report.id, 'updated', changes.length ? changes.join('; ') : 'Маълумот қайта сақланди.', req.session.adminUsername);
  writeDb(db);

  res.redirect(`/admin/reports/${encodeURIComponent(req.params.id)}`);
});

app.get('/admin/files/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) return res.status(404).send('Файл топилмади.');
  res.sendFile(filePath);
});

app.get('/admin/export.csv', requireAdmin, (req, res) => {
  const reports = getReports({
    status: String(req.query.status || ''),
    q: String(req.query.q || ''),
    priority: String(req.query.priority || ''),
    from: String(req.query.from || ''),
    to: String(req.query.to || ''),
  });

  const header = [
    'ID',
    'Yaratilgan vaqt',
    'Yangilangan vaqt',
    'Telefon',
    'Joy',
    'Hodisa sanasi',
    'Holat turi',
    'Mazmun',
    'Status',
    'Muhimlik',
    'Masul',
    'Admin izoh',
    'Fayllar soni',
  ];
  const rows = reports.map((r) => [
    r.id,
    r.created_at,
    r.updated_at,
    r.phone,
    r.place,
    r.event_date || '',
    r.incident_type_label,
    r.message,
    r.status_label,
    r.priority_label,
    r.responsible_person || '',
    r.admin_note || '',
    r.file_count || 0,
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(';')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="corruption-reports-${Date.now()}.csv"`);
  res.send('\uFEFF' + csv);
});

app.use((req, res) => {
  res.status(404).render('index', {
    title: 'Саҳифа топилмади',
    error: 'Саҳифа топилмади. Асосий форма орқали хабар юборишингиз мумкин.',
    old: {},
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Серверда хатолик юз берди.');
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
      console.log(`Admin panel: /admin`);
      console.log(`Default local admin if no .env: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
    });
  })
  .catch((err) => {
    console.error('Database init error:', err);
    process.exit(1);
  });
