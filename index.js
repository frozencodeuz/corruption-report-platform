require('dotenv').config();

const express = require('express');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

process.env.TZ = 'Asia/Tashkent';

const app = express();
const PORT = Number(process.env.PORT || 3000);

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const RESET_ADMIN_PASSWORD = String(process.env.RESET_ADMIN_PASSWORD || 'false').toLowerCase() === 'true';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'report-files';

const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);
const MAX_FILES = Number(process.env.MAX_FILES || 5);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL yoki SUPABASE_SERVICE_ROLE_KEY topilmadi. Render Environment Variables ni tekshiring.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const STATUSES = {
  new: { label: 'Янги', short: 'Янги', tone: 'new', icon: '●' },
  reviewing: { label: 'Кўриб чиқилмоқда', short: 'Ижрода', tone: 'reviewing', icon: '◐' },
  checked: { label: 'Ўрганилди', short: 'Ўрганилди', tone: 'checked', icon: '✓' },
  baseless: { label: 'Асоссиз', short: 'Асоссиз', tone: 'baseless', icon: '!' },
  closed: { label: 'Ёпилди', short: 'Ёпилди', tone: 'closed', icon: '■' }
};

const PRIORITIES = {
  normal: 'Оддий',
  important: 'Муҳим',
  urgent: 'Тезкор'
};

const INCIDENT_TYPES = {
  bribery: 'Пора талаб қилиш ёки таклиф қилиш',
  abuse: 'Мансаб ваколатини суиистеъмол қилиш',
  barrier: 'Сунъий тўсиқ яратиш',
  conflict: 'Манфаатлар тўқнашуви',
  other: 'Бошқа шубҳали ҳолат'
};

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

function generateReportId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const random = Math.floor(1000 + Math.random() * 9000);
  return `KOR-${y}${m}${day}-${Date.now().toString().slice(-6)}${random}`;
}

function safeFileName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const safeExt = ext && ext.length <= 10 ? ext : '';
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
}

function decorateReport(report, fileCount = 0) {
  return {
    ...report,
    file_count: fileCount,
    status_label: statusLabel(report.status),
    priority_label: priorityLabel(report.priority || 'normal'),
    incident_type_label: incidentTypeLabel(report.incident_type || 'other'),
    phone_display: displayPhone(report.phone)
  };
}

function decorateFile(file) {
  return {
    id: file.id,
    report_id: file.report_id,
    filename: file.file_name,
    original_name: file.original_name,
    mimetype: file.mime_type,
    size: file.size_bytes,
    storage_path: file.storage_path,
    created_at: file.created_at
  };
}

async function ensureBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();

  if (listError) {
    console.error('Storage bucket list error:', listError.message);
    return;
  }

  const exists = Array.isArray(buckets) && buckets.some((bucket) => bucket.name === SUPABASE_BUCKET);

  if (!exists) {
    const { error: createError } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: false,
      fileSizeLimit: `${MAX_FILE_MB}MB`
    });

    if (createError) {
      console.error('Storage bucket create error:', createError.message);
    }
  }
}

async function initDb() {
  await ensureBucket();

  const createdAt = now();

  const { data: existingAdmin, error: findError } = await supabase
    .from('admins')
    .select('*')
    .eq('username', ADMIN_USERNAME)
    .maybeSingle();

  if (findError) {
    throw new Error(`Admin tekshirishda xato: ${findError.message}`);
  }

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    const { error: insertError } = await supabase
      .from('admins')
      .insert({
        username: ADMIN_USERNAME,
        password_hash: passwordHash,
        created_at: createdAt,
        updated_at: createdAt
      });

    if (insertError) {
      throw new Error(`Admin yaratishda xato: ${insertError.message}`);
    }

    return;
  }

  if (RESET_ADMIN_PASSWORD) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    const { error: updateError } = await supabase
      .from('admins')
      .update({
        password_hash: passwordHash,
        updated_at: createdAt
      })
      .eq('username', ADMIN_USERNAME);

    if (updateError) {
      throw new Error(`Admin parolni yangilashda xato: ${updateError.message}`);
    }
  }
}

async function addLog(reportId, action, details, adminUsername = 'system') {
  const { error } = await supabase
    .from('logs')
    .insert({
      report_id: reportId,
      action,
      details,
      admin: adminUsername,
      created_at: now()
    });

  if (error) {
    console.error('Log insert error:', error.message);
  }
}

async function getReports({ status = '', q = '', priority = '', from = '', to = '' } = {}) {
  let query = supabase
    .from('reports')
    .select('*')
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (priority) query = query.eq('priority', priority);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', `${to} 23:59:59`);

  const { data: reports, error } = await query;

  if (error) {
    console.error('Reports select error:', error.message);
    return [];
  }

  let filteredReports = Array.isArray(reports) ? reports : [];

  if (q) {
    const needle = q.toLowerCase();
    filteredReports = filteredReports.filter((r) => {
      return [
        r.id,
        r.phone,
        r.place,
        r.message,
        r.incident_type,
        r.responsible_person,
        r.admin_note
      ].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }

  const reportIds = filteredReports.map((r) => r.id);

  let fileCounts = {};

  if (reportIds.length > 0) {
    const { data: files, error: fileError } = await supabase
      .from('report_files')
      .select('report_id')
      .in('report_id', reportIds);

    if (!fileError && Array.isArray(files)) {
      fileCounts = files.reduce((acc, file) => {
        acc[file.report_id] = (acc[file.report_id] || 0) + 1;
        return acc;
      }, {});
    }
  }

  return filteredReports.map((report) => decorateReport(report, fileCounts[report.id] || 0));
}

async function getReport(id) {
  const { data: report, error } = await supabase
    .from('reports')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('Report select error:', error.message);
    return null;
  }

  if (!report) return null;

  const { count } = await supabase
    .from('report_files')
    .select('id', { count: 'exact', head: true })
    .eq('report_id', id);

  return decorateReport(report, count || 0);
}

async function getReportFiles(reportId) {
  const { data: files, error } = await supabase
    .from('report_files')
    .select('*')
    .eq('report_id', reportId)
    .order('id', { ascending: false });

  if (error) {
    console.error('Files select error:', error.message);
    return [];
  }

  return (files || []).map(decorateFile);
}

async function getReportLogs(reportId) {
  const { data: logs, error } = await supabase
    .from('logs')
    .select('*')
    .eq('report_id', reportId)
    .order('id', { ascending: false });

  if (error) {
    console.error('Logs select error:', error.message);
    return [];
  }

  return logs || [];
}

async function getCounts() {
  const counts = {
    total: 0,
    with_files: 0,
    today: 0,
    new: 0,
    reviewing: 0,
    checked: 0,
    baseless: 0,
    closed: 0,
    urgent: 0
  };

  const { data: reports, error } = await supabase
    .from('reports')
    .select('id,status,priority,created_at');

  if (error) {
    console.error('Counts reports error:', error.message);
    return counts;
  }

  const safeReports = reports || [];
  const today = todayDate();

  counts.total = safeReports.length;

  for (const report of safeReports) {
    counts[report.status] = (counts[report.status] || 0) + 1;
    if (String(report.created_at || '').startsWith(today)) counts.today += 1;
    if ((report.priority || 'normal') === 'urgent') counts.urgent += 1;
  }

  const { data: fileRows, error: fileError } = await supabase
    .from('report_files')
    .select('report_id');

  if (!fileError && Array.isArray(fileRows)) {
    const reportIdsWithFiles = new Set(fileRows.map((file) => file.report_id));
    counts.with_files = reportIdsWithFiles.size;
  }

  return counts;
}

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_FILES,
    fileSize: MAX_FILE_MB * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (allowedMimeTypes.has(file.mimetype)) return cb(null, true);
    return cb(new Error('Фақат JPG, PNG, WEBP, GIF, MP4, MOV, WEBM ёки PDF файллар қабул қилинади.'));
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.set('trust proxy', 1);

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
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Жуда кўп уриниш. Илтимос, бироздан кейин қайта уриниб кўринг.'
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Жуда кўп уриниш. Илтимос, бироздан кейин қайта уриниб кўринг.'
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
    old: {}
  });
});

app.post('/submit', submitLimiter, (req, res) => {
  upload.array('evidence', MAX_FILES)(req, res, async (err) => {
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
        updated_at: createdAt
      };

      const { error: reportError } = await supabase
        .from('reports')
        .insert(report);

      if (reportError) {
        throw new Error(`Хабарни базада сақлашда хатолик: ${reportError.message}`);
      }

      for (const file of uploadedFiles) {
        const fileName = safeFileName(file.originalname);
        const storagePath = `${id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from(SUPABASE_BUCKET)
          .upload(storagePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false
          });

        if (uploadError) {
          throw new Error(`Файлни юклашда хатолик: ${uploadError.message}`);
        }

        const { error: fileInsertError } = await supabase
          .from('report_files')
          .insert({
            report_id: id,
            file_name: fileName,
            original_name: file.originalname,
            mime_type: file.mimetype,
            size_bytes: file.size,
            storage_path: storagePath,
            created_at: createdAt
          });

        if (fileInsertError) {
          throw new Error(`Файл маълумотини сақлашда хатолик: ${fileInsertError.message}`);
        }
      }

      await addLog(id, 'created', 'Фуқаро томонидан янги хабар юборилди.', 'system');

      return res.redirect(`/success/${encodeURIComponent(id)}`);
    } catch (e) {
      console.error('Submit error:', e);

      return res.status(400).render('index', {
        title: 'Коррупцион ҳолатлар бўйича аноним хабар бериш',
        error: e.message || 'Маълумот юборишда хатолик юз берди.',
        old: req.body || {}
      });
    }
  });
});

app.get('/success/:id', async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.redirect('/');

  res.render('success', {
    title: 'Хабар қабул қилинди',
    report
  });
});

app.get('/admin', requireAdmin, async (req, res) => {
  const status = String(req.query.status || '').trim();
  const q = String(req.query.q || '').trim();
  const priority = String(req.query.priority || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();

  const reports = await getReports({ status, q, priority, from, to });
  const counts = await getCounts();

  res.render('admin-dashboard', {
    title: 'Админ панел',
    reports,
    counts,
    filters: { status, q, priority, from, to },
    adminUsername: req.session.adminUsername
  });
});

app.get('/admin/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');

  res.render('admin-login', {
    title: 'Админ панелга кириш',
    error: null
  });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const { data: admin, error } = await supabase
    .from('admins')
    .select('*')
    .eq('username', username)
    .maybeSingle();

  if (error) {
    console.error('Admin login select error:', error.message);
  }

  const ok = admin ? await bcrypt.compare(password, admin.password_hash) : false;

  if (!ok) {
    return res.status(401).render('admin-login', {
      title: 'Админ панелга кириш',
      error: 'Логин ёки пароль нотўғри.'
    });
  }

  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;

  res.redirect('/admin');
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin/reports/:id', requireAdmin, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report) return res.status(404).send('Хабар топилмади.');

  const files = await getReportFiles(report.id);
  const logs = await getReportLogs(report.id);

  res.render('admin-report', {
    title: `Хабар ${report.id}`,
    report,
    files,
    logs,
    adminUsername: req.session.adminUsername
  });
});

app.post('/admin/reports/:id/update', requireAdmin, async (req, res) => {
  const status = String(req.body.status || '').trim();
  const priority = String(req.body.priority || 'normal').trim();
  const responsiblePerson = String(req.body.responsible_person || '').trim();
  const adminNote = String(req.body.admin_note || '').trim();

  const allowedStatuses = new Set(Object.keys(STATUSES));
  const allowedPriorities = new Set(Object.keys(PRIORITIES));

  if (!allowedStatuses.has(status)) return res.status(400).send('Нотўғри статус.');
  if (!allowedPriorities.has(priority)) return res.status(400).send('Нотўғри муҳимлик даражаси.');

  const { data: report, error: getError } = await supabase
    .from('reports')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (getError) {
    console.error('Report update select error:', getError.message);
    return res.status(500).send('Хабарни ўқишда хатолик.');
  }

  if (!report) return res.status(404).send('Хабар топилмади.');

  const changes = [];

  if (report.status !== status) {
    changes.push(`Статус: ${statusLabel(report.status)} → ${statusLabel(status)}`);
  }

  if ((report.priority || 'normal') !== priority) {
    changes.push(`Муҳимлик: ${priorityLabel(report.priority || 'normal')} → ${priorityLabel(priority)}`);
  }

  if ((report.responsible_person || '') !== responsiblePerson) {
    changes.push('Масъул ходим янгиланди');
  }

  if ((report.admin_note || '') !== adminNote) {
    changes.push('Ички изоҳ янгиланди');
  }

  const { error: updateError } = await supabase
    .from('reports')
    .update({
      status,
      priority,
      responsible_person: responsiblePerson,
      admin_note: adminNote,
      updated_at: now()
    })
    .eq('id', req.params.id);

  if (updateError) {
    console.error('Report update error:', updateError.message);
    return res.status(500).send('Маълумотни сақлашда хатолик.');
  }

  await addLog(
    report.id,
    'updated',
    changes.length ? changes.join('; ') : 'Маълумот қайта сақланди.',
    req.session.adminUsername
  );

  res.redirect(`/admin/reports/${encodeURIComponent(req.params.id)}`);
});

app.get('/admin/files/:filename', requireAdmin, async (req, res) => {
  const fileName = path.basename(req.params.filename);

  const { data: file, error } = await supabase
    .from('report_files')
    .select('*')
    .eq('file_name', fileName)
    .maybeSingle();

  if (error) {
    console.error('File select error:', error.message);
    return res.status(500).send('Файлни ўқишда хатолик.');
  }

  if (!file) return res.status(404).send('Файл топилмади.');

  const { data: signed, error: signedError } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(file.storage_path, 60);

  if (signedError || !signed?.signedUrl) {
    console.error('Signed URL error:', signedError?.message);
    return res.status(500).send('Файлни очишда хатолик.');
  }

  return res.redirect(signed.signedUrl);
});

app.get('/admin/export.csv', requireAdmin, async (req, res) => {
  const reports = await getReports({
    status: String(req.query.status || ''),
    q: String(req.query.q || ''),
    priority: String(req.query.priority || ''),
    from: String(req.query.from || ''),
    to: String(req.query.to || '')
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
    'Fayllar soni'
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
    r.file_count || 0
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
    old: {}
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
      console.log(`Admin username from env: ${ADMIN_USERNAME}`);
      console.log(`Supabase bucket: ${SUPABASE_BUCKET}`);
    });
  })
  .catch((err) => {
    console.error('Database init error:', err);
    process.exit(1);
  });