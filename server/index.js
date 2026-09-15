import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { getDbConfigStatus, getPool, sql } from './db.js';

const app = express();
const port = Number(process.env.API_PORT || 4000);
const marriageTable = process.env.HR_MARRIAGE_TABLE || 'dbo.HR_MarriageAnniversary';
const jwtSecret = process.env.JWT_SECRET;
const hrUsername = process.env.HR_USERNAME;
const hrPassword = process.env.HR_PASSWORD;
const devEmployeeAuthEnabled = String(process.env.DEV_EMPLOYEE_AUTH_ENABLED).toLowerCase() === 'true';
const devEmployeePaycode = process.env.DEV_EMPLOYEE_PAYCODE;
const devEmployeePassword = process.env.DEV_EMPLOYEE_PASSWORD;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(',').filter(Boolean) || true }));
app.use(express.json({ limit: '2mb' }));

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isoDate(date) { return date.toISOString().slice(0, 10); }

function parseDateRange(query, defaultDays = 31) {
  if (query.date) {
    return isValidIsoDate(query.date) ? { fromDate: query.date, toDate: query.date } : { error: 'Invalid date. Use YYYY-MM-DD.' };
  }
  if (query.month) {
    if (!/^\d{4}-\d{2}$/.test(query.month)) return { error: 'Invalid month. Use YYYY-MM.' };
    const [year, month] = query.month.split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1) return { error: 'Invalid month.' };
    return { fromDate: isoDate(start), toDate: isoDate(end) };
  }
  if (query.fromDate || query.toDate) {
    if (!isValidIsoDate(query.fromDate) || !isValidIsoDate(query.toDate) || query.fromDate > query.toDate) {
      return { error: 'fromDate and toDate must be valid and ordered.' };
    }
    return { fromDate: query.fromDate, toDate: query.toDate };
  }
  const days = Number(query.days || defaultDays);
  if (!Number.isInteger(days) || days < 1 || days > 366) return { error: 'days must be an integer from 1 to 366.' };
  const end = new Date();
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return { fromDate: isoDate(start), toDate: isoDate(end) };
}

function parseWeekRange(query) {
  if (query.fromDate || query.toDate) return parseDateRange(query, 7);
  if (query.week && /^\d{4}-W\d{2}$/.test(query.week)) {
    const [yearText, weekText] = query.week.split('-W');
    const year = Number(yearText), week = Number(weekText);
    if (week < 1 || week > 53) return { error: 'Invalid week.' };
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { fromDate: isoDate(monday), toDate: isoDate(sunday) };
  }
  return parseDateRange(query, 7);
}

// Current India calendar week (Monday 00:00 IST ... Sunday 23:59 IST).
function indiaWeekRange() {
  const today = indiaTodayISO();
  const p = today.split('-').map(Number);
  const dow = (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  const monday = new Date(Date.UTC(p[0], p[1] - 1, p[2] - dow));
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
  return { fromDate: isoDate(monday), toDate: isoDate(sunday) };
}

function requireDbConfig(_req, res, next) {
  if (!process.env.DB_SERVER || !process.env.DB_DATABASE || !process.env.DB_USER || !process.env.DB_PASSWORD) {
    return res.status(503).json({ success: false, message: 'Database connection unavailable.' });
  }
  next();
}

function databaseErrorMessage(error) {
  const code = String(error?.code || error?.originalError?.code || '').toUpperCase();
  if (code.includes('LOGIN') || code === 'ELOGIN' || code === 'EINVALID') return 'Database credentials are invalid.';
  if (code.includes('TABLE') || code.includes('INVALIDOBJECT')) return 'Required database table was not found.';
  return 'Database connection unavailable.';
}

function sendDbError(res, error) {
  console.error('[DB_ERROR]', error && (error.message || error).toString().slice(0, 500));
  return res.status(503).json({ success: false, message: databaseErrorMessage(error) });
}

function signUser(user) {
  if (!jwtSecret) throw new Error('JWT_SECRET is not configured.');
  return jwt.sign({ sub: user.id, role: user.role.toUpperCase(), paycode: user.paycode || null, devEmployee: user.devEmployee === true }, jwtSecret, { expiresIn: '8h' });
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  if (!token || !jwtSecret) return res.status(401).json({ success: false, message: 'Authentication required.' });
  try { req.user = jwt.verify(token, jwtSecret); next(); }
  catch { res.status(401).json({ success: false, message: 'Invalid or expired session.' }); }
}

function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ success: false, message: 'Forbidden.' });
}

function requireConfiguredAuth(_req, res, next) {
  if (!jwtSecret) return res.status(503).json({ success: false, message: 'Authentication is not configured on the server.' });
  next();
}

function validateRange(res, range) {
  if (!range.error) return true;
  res.status(400).json({ success: false, message: range.error });
  return false;
}

const attendanceFields = 'paycode, dateoffice, shift, in1, in2, out1, out2, hoursworked, otduration, latearrival, status, reason';

// Savior biometric register uses short codes (CHAR-padded): P=Present, A/ABS=Absent,
// MIS=Miss punch, HLF=Half day present, SRT=Short leave present, POW=Present on week-off,
// WO=Week off. Normalize once so backend + frontend agree.
function attendanceCode(status) {
  return String(status || '').trim().toUpperCase();
}

function attendanceStatus(code) {
  const c = attendanceCode(code);
  if (c === 'P' || c === 'PRESENT') return 'Present';
  if (c === 'A' || c === 'ABS' || c === 'ABSENT') return 'Absent';
  if (c === 'MIS' || c === 'MISS PUNCH' || c === 'MISS' || c === 'MISPUNCH') return 'Miss Punch';
  if (c === 'WO' || c === 'WEEK OFF' || c === 'WEEKOFF') return 'Week Off';
  if (c === 'HLF' || c === 'HALF' || c === 'HALF DAY') return 'Half Day';
  if (c === 'SRT' || c === 'SHORT') return 'Short Leave';
  if (c === 'POW' || c === 'PRESENT ON WEEK OFF') return 'Present (Week Off)';
  return c ? code : null;
}

function isPresentCode(code) {
  return ['P', 'HLF', 'SRT', 'POW'].includes(attendanceCode(code));
}

function isAbsentCode(code) {
  return ['A', 'ABS'].includes(attendanceCode(code));
}

function isMissCode(code) {
  return attendanceCode(code) === 'MIS';
}

function isLateRow(row) {
  if (!row) return false;
  if (attendanceCode(row.status) === 'LATE' || attendanceCode(row.statusCode) === 'LATE') return true;
  return Number(row.latearrival || 0) > 0;
}

// ---- ONE common attendance calculation (India local date is the truth) ----
// DB stores punch datetimes as local wall-clock (e.g. 10:02 IST stored as 10:02).
// The mssql driver serialises them as "...T10:02:00.000Z". So the UTC part of the
// ISO string IS the company-local wall time. Never apply a +5:30 shift on top,
// otherwise 10:57 AM becomes 04:27 PM. Display = UTC getters of the ISO value.
function indiaDateISO(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function indiaTodayISO() {
  return indiaDateISO(new Date());
}

// Range resolver shared by summary + category: daily | weekly (Mon-Sun, India) | monthly.
function resolveAttendanceRange(query = {}) {
  const mode = String(query.mode || query.range || 'daily').toLowerCase();
  if (query.date && isValidIsoDate(query.date)) return { mode: 'daily', fromDate: query.date, toDate: query.date };
  if (query.fromDate && query.toDate) {
    const r = parseDateRange(query, 31);
    if (r.error) return r;
    return { mode: mode === 'weekly' ? 'weekly' : mode === 'monthly' ? 'monthly' : 'daily', fromDate: r.fromDate, toDate: r.toDate };
  }
  if (mode === 'weekly' || query.week) {
    const r = parseWeekRange(query);
    if (r.error) return r;
    // No explicit bounds => the current India Mon-Sun week (never a rolling 7 days).
    if (!query.week && !query.fromDate && !query.toDate) {
      const w = indiaWeekRange();
      return { mode: 'weekly', fromDate: w.fromDate, toDate: w.toDate };
    }
    return { mode: 'weekly', fromDate: r.fromDate, toDate: r.toDate };
  }
  if (mode === 'monthly' || query.month) {
    if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
      const r = parseDateRange(query, 31);
      if (r.error) return r;
      return { mode: 'monthly', fromDate: r.fromDate, toDate: r.toDate };
    }
    const today = indiaTodayISO();
    return { mode: 'monthly', fromDate: today.slice(0, 7) + '-01', toDate: today };
  }
  const today = indiaTodayISO();
  return { mode: 'daily', fromDate: query.date || today, toDate: query.date || today };
}

// ONE attendance aggregation over an arbitrary [fromDate, toDate] (inclusive).
// Punched  = DISTINCT employees with >=1 real punch in range (IN-only counts).
// Complete = DISTINCT employees with >=1 complete (IN+OUT) row in range.
// Miss     = DISTINCT employees with >=1 incomplete row and zero complete rows.
// Absent   = staff - punched - weekoff-only (daily: staff with no punch row).
// Late     = DISTINCT employees with latearrival>0 or LATE status in range.
async function aggregateAttendance(pool, fromDate, toDate) {
  const [empResult, regResult, rawResult] = await Promise.all([
    pool.request().query('SELECT paycode FROM dbo.tblemployee'),
    pool.request().input('fromDate', sql.Date, fromDate).input('toDate', sql.Date, toDate).query(
      `SELECT ${attendanceFields} FROM dbo.tbltimeregister WHERE dateoffice >= @fromDate AND dateoffice < DATEADD(DAY, 1, @toDate)`),
    pool.request().input('fromDate', sql.Date, fromDate).input('toDate', sql.Date, toDate).query(
      `SELECT COUNT(1) AS rawPunchRecords FROM dbo.machinerawpunch WHERE CAST(officepunch AS date) >= @fromDate AND CAST(officepunch AS date) <= @toDate`)
  ]);
  const rowsByPay = new Map();
  for (const row of regResult.recordset) {
    const k = String(row.paycode).trim();
    if (!rowsByPay.has(k)) rowsByPay.set(k, []);
    rowsByPay.get(k).push(row);
  }
  let punched = 0, complete = 0, miss = 0, absent = 0, late = 0;
  for (const emp of empResult.recordset) {
    const rows = rowsByPay.get(String(emp.paycode).trim()) || [];
    const usable = rows.filter(r => classifyRow({ ...r, statusCode: attendanceCode(r.status) }) !== 'Week Off');
    const hasAnyPunch = usable.some(hasPunch);
    const hasComplete = usable.some(hasCompletePunch);
    const hasIncomplete = usable.some(r => hasPunch(r) && !hasCompletePunch(r));
    const isLate = usable.some(isLateRow);
    if (hasAnyPunch) punched += 1;
    else absent += 1;
    if (hasComplete) complete += 1;
    else if (hasIncomplete) miss += 1;
    if (isLate) late += 1;
  }
  return {
    totalstaff: empResult.recordset.length,
    punched, complete, miss, absent, late,
    rawPunchRecords: Number(rawResult.recordset[0]?.rawPunchRecords || 0)
  };
}

function formatPunchTimeIST(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.valueOf())) return null;
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

function hasPunch(row) {
  return Boolean(row && (row.in1 || row.in2 || row.out1 || row.out2));
}

function hasCompletePunch(row) {
  if (!row) return false;
  const hasIn = Boolean(row.in1 || row.in2);
  const hasOut = Boolean(row.out1 || row.out2);
  return hasIn && hasOut;
}

// Single row classifier used by EVERY endpoint. Late is orthogonal (a flag),
// never a separate status bucket.
function classifyRow(row) {
  if (!row) return 'Absent';
  const code = attendanceCode(row.statusCode || row.status);
  if (code === 'WO' || code === 'WEEK OFF' || code === 'WEEKOFF') return 'Week Off';
  if (code === 'HLF' || code === 'HALF' || code === 'HALF DAY') return 'Present';
  if (code === 'SRT' || code === 'SHORT') return 'Present';
  if (code === 'POW' || code === 'PRESENT ON WEEK OFF') return 'Present';
  if (code === 'P' || code === 'PRESENT') return 'Present';
  if (code === 'LATE') return 'Present';
  if (code === 'A' || code === 'ABS' || code === 'ABSENT') {
    // Real punch beats a stale Absent flag: IN without OUT = Miss Punch.
    if (row.in1 || row.in2) return 'Miss Punch';
    return 'Absent';
  }
  if (code === 'MIS' || code === 'MISS' || code === 'MISS PUNCH' || code === 'MISPUNCH') return 'Miss Punch';
  if (code === 'H' || code === 'HOLIDAY') return 'Week Off';
  // NULL / unknown status: derive from punches so IN-only rows never vanish.
  if (row.in1 || row.in2) return hasCompletePunch(row) ? 'Present' : 'Miss Punch';
  if (row.out1 || row.out2) return 'Miss Punch';
  return 'Absent';
}

function normalizeAttendance(row) {
  const normalized = {
    paycode: row.paycode, date: row.dateoffice, dateoffice: row.dateoffice, shift: row.shift,
    in1: row.in1, in2: row.in2, out1: row.out1, out2: row.out2,
    hoursworked: row.hoursworked, otduration: row.otduration ?? null, latearrival: Number(row.latearrival || 0),
    status: row.status, statusCode: attendanceCode(row.status),
    isLate: isLateRow(row), reason: row.reason
  };
  // DB datetime untouched; display-only IST wall-clock time (HH:MM AM/PM).
  normalized.inTime = formatPunchTimeIST(row.in1 || row.in2);
  normalized.outTime = formatPunchTimeIST(row.out1 || row.out2);
  normalized.statusLabel = attendanceStatus(row.status) || classifyRow(normalized);
  normalized.computedStatus = classifyRow({ ...normalized, status: normalized.status, statusCode: normalized.statusCode });
  normalized.punchedToday = hasPunch(normalized);
  return normalized;
}

function calculateStats(rows) {
  return rows.reduce((stats, row) => {
    const label = classifyRow({ ...row, status: row.statusCode || row.status, statusCode: row.statusCode || row.status });
    if (label === 'Week Off') return stats;
    if (label === 'Absent') stats.absent += 1;
    else if (label === 'Miss Punch') stats.miss += 1;
    else stats.present += 1;
    if (isLateRow(row)) stats.late += 1;
    stats.hours += Number(row.hoursworked || 0);
    return stats;
  }, { present: 0, absent: 0, miss: 0, late: 0, hours: 0 });
}

async function queryAttendance(pool, paycode, range) {
  const request = pool.request()
    .input('paycode', sql.VarChar(50), paycode || null)
    .input('fromDate', sql.Date, range.fromDate)
    .input('toDate', sql.Date, range.toDate);
  const result = await request.query(`
    SELECT ${attendanceFields}
    FROM dbo.tbltimeregister
    WHERE (@paycode IS NULL OR paycode = @paycode)
      AND dateoffice >= @fromDate
      AND dateoffice < DATEADD(DAY, 1, @toDate)
    ORDER BY dateoffice DESC`);
  return result.recordset;
}

app.get('/api/health', async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT DB_NAME() AS databaseName');
    res.json({ status: 'ok', source: 'Savior Biometric SQL Server', database: result.recordset[0]?.databaseName });
  } catch (error) { sendDbError(res, error); }
});

app.get('/api/diagnostics/db', async (_req, res) => {
  const config = getDbConfigStatus();
  if (!config.databaseConfigured || !config.userConfigured || !config.passwordConfigured) {
    return res.status(503).json({ success: false, status: 'not_configured', message: 'Database connection unavailable.', config });
  }
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT DB_NAME() AS databaseName, 1 AS connectionCheck');
    res.json({ success: true, status: 'connected', database: result.recordset[0]?.databaseName, connectionCheck: result.recordset[0]?.connectionCheck, config });
  } catch (error) {
    res.status(503).json({ success: false, status: 'unavailable', message: databaseErrorMessage(error), config });
  }
});

app.get('/api/diagnostics/schema', authenticate, requireRole('HR'), requireDbConfig, async (_req, res) => {
  try {
    const pool = await getPool();
    const [result, indexes, foreignKeys] = await Promise.all([
      pool.request().query(`
      SELECT DB_NAME() AS databaseName, s.name AS schemaName, t.name AS tableName,
        c.name AS columnName, ty.name AS dataType, c.max_length AS maxLength, c.is_nullable AS isNullable
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE s.name = 'dbo' AND t.name IN ('tblemployee', 'tbltimeregister', 'machinerawpunch')
      ORDER BY t.name, c.column_id`),
      pool.request().query(`
        SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schemaName, OBJECT_NAME(i.object_id) AS tableName,
          i.name AS indexName, i.is_primary_key AS isPrimaryKey, i.is_unique AS isUnique
        FROM sys.indexes i
        WHERE OBJECT_SCHEMA_NAME(i.object_id) = 'dbo'
          AND OBJECT_NAME(i.object_id) IN ('tblemployee', 'tbltimeregister', 'machinerawpunch')
          AND i.name IS NOT NULL ORDER BY tableName, indexName`),
      pool.request().query(`
        SELECT OBJECT_SCHEMA_NAME(parent_object_id) AS parentSchema, OBJECT_NAME(parent_object_id) AS parentTable,
          name AS constraintName, OBJECT_SCHEMA_NAME(referenced_object_id) AS referencedSchema,
          OBJECT_NAME(referenced_object_id) AS referencedTable
        FROM sys.foreign_keys WHERE OBJECT_SCHEMA_NAME(parent_object_id) = 'dbo'
          AND (OBJECT_NAME(parent_object_id) IN ('tblemployee', 'tbltimeregister', 'machinerawpunch')
            OR OBJECT_NAME(referenced_object_id) IN ('tblemployee', 'tbltimeregister', 'machinerawpunch'))`)
    ]);
    const required = {
      tblemployee: ['paycode', 'empname', 'presentcardno', 'companycode'],
      tbltimeregister: ['paycode', 'dateoffice', 'shift', 'in1', 'in2', 'out1', 'out2', 'hoursworked', 'status', 'reason'],
      machinerawpunch: ['cardno', 'mc_no', 'officepunch', 'inout', 'ismanual']
    };
    const tables = Object.fromEntries(Object.entries(required).map(([table, columns]) => {
      const found = result.recordset.filter(row => row.tableName === table);
      const names = new Set(found.map(row => row.columnName.toLowerCase()));
      return [table, { present: found.length > 0, columns: found, missing: columns.filter(column => !names.has(column)) }];
    }));
    res.json({ database: result.recordset[0]?.databaseName || null, tables, indexes: indexes.recordset, foreignKeys: foreignKeys.recordset });
  } catch (error) { sendDbError(res, error); }
});

app.post('/api/auth/employee/login', requireConfiguredAuth, async (req, res) => {
  const paycode = String(req.body?.paycode || '').trim();
  const password = String(req.body?.password || '');
  if (!paycode || !password) return res.status(400).json({ success: false, message: 'Employee paycode and password are required.' });
  if (devEmployeeAuthEnabled && paycode === devEmployeePaycode) {
    if (password !== devEmployeePassword) return res.status(401).json({ success: false, message: 'Invalid employee credentials.' });
    return res.json({ success: true, token: signUser({ id: paycode, role: 'EMPLOYEE', paycode, devEmployee: true }), role: 'EMPLOYEE', employee: { paycode, empname: 'Development Employee', presentcardno: null, companycode: null } });
  }
  if (!process.env.DB_SERVER || !process.env.DB_DATABASE || !process.env.DB_USER || !process.env.DB_PASSWORD) return res.status(503).json({ success: false, message: 'Database connection unavailable.' });
  try {
    const pool = await getPool();
    const result = await pool.request().input('paycode', sql.VarChar(50), paycode).query('SELECT TOP 1 paycode, empname, presentcardno, companycode FROM dbo.tblemployee WHERE paycode = @paycode');
    const employee = result.recordset[0];
    if (!employee) return res.status(401).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, token: signUser({ id: employee.paycode, role: 'EMPLOYEE', paycode: employee.paycode }), role: 'EMPLOYEE', employee });
  } catch (error) { sendDbError(res, error); }
});

app.post('/api/auth/hr/login', requireConfiguredAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ success: false, message: 'HR username and password are required.' });
  if (!hrUsername || !hrPassword) return res.status(503).json({ success: false, message: 'HR authentication is not configured.' });
  if (username !== hrUsername || password !== hrPassword) return res.status(401).json({ success: false, message: 'Invalid HR credentials.' });
  res.json({ success: true, token: signUser({ id: username, role: 'HR' }), role: 'HR' });
});

app.get('/api/me', authenticate, async (req, res) => {
  if (req.user.role === 'HR') return res.json({ role: 'HR' });
  if (req.user.role === 'EMPLOYEE' && req.user.devEmployee === true && devEmployeeAuthEnabled && req.user.paycode === devEmployeePaycode) return res.json({ role: 'EMPLOYEE', employee: { paycode: devEmployeePaycode, empname: 'Development Employee', presentcardno: null, companycode: null } });
  if (!process.env.DB_SERVER || !process.env.DB_DATABASE || !process.env.DB_USER || !process.env.DB_PASSWORD) return res.status(503).json({ success: false, message: 'Database connection unavailable.' });
  try {
    const pool = await getPool();
    const result = await pool.request().input('paycode', sql.VarChar(50), req.user.paycode).query('SELECT TOP 1 paycode, empname, presentcardno, companycode FROM dbo.tblemployee WHERE paycode = @paycode');
    if (!result.recordset[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ role: 'EMPLOYEE', employee: result.recordset[0] });
  } catch (error) { sendDbError(res, error); }
});

async function employeeAttendance(req, res, parser = parseDateRange) {
  const range = parser(req.query);
  if (!validateRange(res, range)) return;
  try {
    const rows = await queryAttendance(await getPool(), req.user.paycode, range);
    res.json(rows.map(normalizeAttendance));
  } catch (error) { sendDbError(res, error); }
}

app.get('/api/employee/daily', authenticate, requireRole('EMPLOYEE'), requireDbConfig, (req, res) => employeeAttendance(req, res));
app.get('/api/employee/weekly', authenticate, requireRole('EMPLOYEE'), requireDbConfig, (req, res) => employeeAttendance(req, res, parseWeekRange));
app.get('/api/employee/monthly', authenticate, requireRole('EMPLOYEE'), requireDbConfig, (req, res) => employeeAttendance(req, res));

app.get('/api/employee/dashboard', authenticate, requireRole('EMPLOYEE'), requireDbConfig, async (req, res) => {
  const range = parseDateRange(req.query, 31);
  if (!validateRange(res, range)) return;
  try {
    const rows = await queryAttendance(await getPool(), req.user.paycode, range);
    const stats = calculateStats(rows), total = stats.present + stats.absent + stats.miss;
    res.json({ ...stats, attendancePercentage: total ? Number((stats.present / total * 100).toFixed(1)) : 0, records: rows.length });
  } catch (error) { sendDbError(res, error); }
});

app.get('/api/attendance', authenticate, requireDbConfig, async (req, res) => {
  const range = parseDateRange(req.query, 31);
  if (!validateRange(res, range)) return;
  if (req.user.role === 'EMPLOYEE' && req.query.paycode && req.query.paycode !== req.user.paycode) return res.status(403).json({ success: false, message: 'Forbidden.' });
  try {
    const paycode = req.user.role === 'EMPLOYEE' ? req.user.paycode : req.query.paycode || null;
    const rows = await queryAttendance(await getPool(), paycode, range);
    res.json(rows.map(normalizeAttendance));
  } catch (error) { sendDbError(res, error); }
});

async function listEmployees(req, res) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize || 25), 1), 100);
  const offset = (page - 1) * pageSize;
  const search = String(req.query.search || '').trim() || null;
  // All roster filters are applied SERVER-SIDE against real dbo.tblemployee values
  // (trim() on both sides because master columns are CHAR-padded, e.g. "EXECUTIVE   ").
  const companycode = String(req.query.companycode || '').trim() || null;
  const departmentcode = String(req.query.departmentcode || '').trim() || null;
  const sex = String(req.query.sex || '').trim() || null;
  const cat = String(req.query.cat || '').trim() || null;
  const designation = String(req.query.designation || '').trim() || null;
  const ismarried = String(req.query.ismarried || '').trim() || null;
  const active = String(req.query.active || '').trim() || null;
  const request = (await getPool()).request()
    .input('offset', sql.Int, offset).input('pageSize', sql.Int, pageSize)
    .input('search', sql.VarChar(100), search).input('companycode', sql.VarChar(50), companycode)
    .input('departmentcode', sql.VarChar(50), departmentcode).input('sex', sql.VarChar(50), sex)
    .input('cat', sql.VarChar(50), cat).input('designation', sql.VarChar(100), designation)
    .input('ismarried', sql.VarChar(50), ismarried).input('active', sql.VarChar(50), active);
  const result = await request.query(`
    SELECT COUNT(1) OVER() AS totalcount, LTRIM(RTRIM(e.paycode)) AS paycode, LTRIM(RTRIM(e.empname)) AS empname, LTRIM(RTRIM(e.presentcardno)) AS presentcardno,
      LTRIM(RTRIM(e.companycode)) AS companycode, LTRIM(RTRIM(e.departmentcode)) AS departmentcode,
      LTRIM(RTRIM(d.departmentname)) AS departmentname, LTRIM(RTRIM(c.companyname)) AS companyname, LTRIM(RTRIM(e.designation)) AS designation,
      e.dateofbirth, e.dateofjoin, LTRIM(RTRIM(e.sex)) AS sex, LTRIM(RTRIM(e.cat)) AS cat,
      LTRIM(RTRIM(e.ismarried)) AS ismarried, LTRIM(RTRIM(e.active)) AS active,
      COALESCE(a.presentCount, 0) AS presentCount, COALESCE(a.absentCount, 0) AS absentCount,
      COALESCE(a.missCount, 0) AS missCount, COALESCE(a.lateCount, 0) AS lateCount, COALESCE(a.totalHours, 0) AS totalHours
    FROM dbo.tblemployee e
    LEFT JOIN dbo.tbldepartment d ON LTRIM(RTRIM(d.departmentcode)) = LTRIM(RTRIM(e.departmentcode))
    LEFT JOIN dbo.tblcompany c ON LTRIM(RTRIM(c.companycode)) = LTRIM(RTRIM(e.companycode))
    OUTER APPLY (
      SELECT SUM(CASE WHEN LTRIM(RTRIM(tr.status)) IN ('P', 'HLF', 'SRT', 'POW', 'Present', 'Late') OR (tr.status IS NULL AND tr.in1 IS NOT NULL AND (tr.out1 IS NOT NULL OR tr.out2 IS NOT NULL)) THEN 1 ELSE 0 END) AS presentCount,
        SUM(CASE WHEN LTRIM(RTRIM(tr.status)) IN ('A', 'ABS', 'Absent') THEN 1 ELSE 0 END) AS absentCount,
        SUM(CASE WHEN LTRIM(RTRIM(tr.status)) IN ('MIS', 'Miss Punch') OR (tr.status IS NULL AND tr.in1 IS NOT NULL AND tr.out1 IS NULL AND tr.out2 IS NULL) THEN 1 ELSE 0 END) AS missCount,
        SUM(CASE WHEN (COALESCE(tr.latearrival, 0) > 0 OR LTRIM(RTRIM(tr.status)) = 'LATE')
          AND LTRIM(RTRIM(COALESCE(tr.status, ''))) NOT IN ('WO', 'WEEK OFF', 'WEEKOFF', 'H', 'HOLIDAY') THEN 1 ELSE 0 END) AS lateCount, SUM(COALESCE(tr.hoursworked, 0)) AS totalHours
      FROM dbo.tbltimeregister tr WHERE tr.paycode = e.paycode
        AND tr.dateoffice >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
        AND tr.dateoffice < DATEADD(MONTH, 1, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
    ) a
    WHERE (@search IS NULL OR e.empname LIKE '%' + @search + '%' OR e.paycode LIKE '%' + @search + '%' OR e.presentcardno LIKE '%' + @search + '%')
      AND (@companycode IS NULL OR LTRIM(RTRIM(e.companycode)) = @companycode)
      AND (@departmentcode IS NULL OR LTRIM(RTRIM(e.departmentcode)) = @departmentcode)
      AND (@sex IS NULL OR LTRIM(RTRIM(e.sex)) = @sex)
      AND (@cat IS NULL OR LTRIM(RTRIM(e.cat)) = @cat)
      AND (@designation IS NULL OR LTRIM(RTRIM(e.designation)) = @designation)
      AND (@ismarried IS NULL OR LTRIM(RTRIM(e.ismarried)) = @ismarried)
      AND (@active IS NULL OR LTRIM(RTRIM(e.active)) = @active)
    ORDER BY e.empname OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`);
  const rows = result.recordset.map(({ totalcount, ...row }) => ({ ...row, attendanceStats: { present: Number(row.presentCount), absent: Number(row.absentCount), miss: Number(row.missCount), late: Number(row.lateCount), hours: Number(row.totalHours) } }));
  res.json({ rows, page, pageSize, total: Number(result.recordset[0]?.totalcount || 0) });
}

app.get('/api/hr/employees', authenticate, requireRole('HR'), requireDbConfig, async (req, res) => { try { await listEmployees(req, res); } catch (error) { sendDbError(res, error); } });
app.get('/api/employees', authenticate, requireRole('HR'), requireDbConfig, async (req, res) => { try { await listEmployees(req, res); } catch (error) { sendDbError(res, error); } });

// CHAR-padded master columns (sex, designation, cat...) must be trimmed before
// they reach the UI; dates/numbers pass through untouched.
function trimEmployeeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

async function getEmployee(req, res) {
  try {
    const result = await (await getPool()).request().input('paycode', sql.VarChar(50), req.params.paycode).query(`
      SELECT TOP 1 e.paycode, e.empname, e.presentcardno, e.companycode, e.departmentcode, e.designation,
        e.dateofbirth, e.dateofjoin, e.sex, e.cat, e.ismarried, e.active,
        COALESCE(LTRIM(RTRIM(d.departmentname)), '') AS departmentname
      FROM dbo.tblemployee e
      LEFT JOIN dbo.tbldepartment d ON LTRIM(RTRIM(d.departmentcode)) = LTRIM(RTRIM(e.departmentcode))
      WHERE e.paycode = @paycode`);
    if (!result.recordset[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json(trimEmployeeRow(result.recordset[0]));
  } catch (error) { sendDbError(res, error); }
}

app.get('/api/hr/employee/:paycode', authenticate, requireRole('HR'), requireDbConfig, getEmployee);
app.get('/api/employees/:paycode', authenticate, requireRole('HR'), requireDbConfig, getEmployee);

async function hrSummary(req, res, includePercentage = false) {
  try {
    // ONE source of truth via aggregateAttendance; mode-aware (daily/weekly/monthly).
    const range = resolveAttendanceRange(req?.query || {});
    if (range.error) return res.status(400).json({ success: false, message: range.error });
    const pool = await getPool();
    const agg = await aggregateAttendance(pool, range.fromDate, range.toDate);
    const summary = {
      indiaToday: indiaTodayISO(),
      mode: range.mode, fromDate: range.fromDate, toDate: range.toDate,
      totalstaff: agg.totalstaff,
      punchedtoday: agg.punched,
      punched: agg.punched,
      presenttoday: agg.complete,
      complete: agg.complete,
      absenttoday: agg.absent,
      misstoday: agg.miss,
      latetoday: agg.late,
      rawPunchRecordsToday: agg.rawPunchRecords
    };
    if (includePercentage) {
      // Punched is the authoritative daily attendance metric (>=1 real punch).
      const total = Number(summary.totalstaff || 0);
      summary.attendancePercentage = total ? Number((Number(summary.punchedtoday || 0) / total * 100).toFixed(1)) : 0;
    }
    res.json(summary);
  } catch (error) { sendDbError(res, error); }
}

app.get('/api/hr/dashboard', authenticate, requireRole('HR'), requireDbConfig, (req, res) => hrSummary(req, res, true));
app.get('/api/hr/summary', authenticate, requireRole('HR'), requireDbConfig, (req, res) => hrSummary(req, res));

async function dailyMaster(req, res) {
  const range = parseDateRange(req.query);
  if (!validateRange(res, range)) return;
  try {
    const result = await (await getPool()).request().input('date', sql.Date, range.fromDate).query(`
      SELECT e.paycode, e.empname, e.companycode, tr.dateoffice, tr.in1, tr.in2, tr.out1, tr.out2, tr.hoursworked, tr.latearrival, tr.status, tr.reason
      FROM dbo.tblemployee e OUTER APPLY (
        SELECT TOP 1 ${attendanceFields}
        FROM dbo.tbltimeregister tr WHERE tr.paycode = e.paycode AND tr.dateoffice >= @date AND tr.dateoffice < DATEADD(DAY, 1, @date)
        ORDER BY tr.dateoffice DESC
      ) tr ORDER BY e.empname`);
    res.json(result.recordset.map(row => {
      const n = normalizeAttendance(row);
      const computed = n.computedStatus || 'Absent';
      const hasRow = Boolean(row.dateoffice);
      return {
        paycode: row.paycode, empname: row.empname, companycode: row.companycode,
        date: row.dateoffice, in1: row.in1, in2: row.in2, out1: row.out1, out2: row.out2,
        hoursworked: row.hoursworked, latearrival: Number(row.latearrival || 0),
        status: row.status, statusCode: n.statusCode, statusLabel: hasRow ? computed : 'No Record',
        computedStatus: hasRow ? computed : 'No Record',
        inTime: n.inTime, outTime: n.outTime,
        isLate: n.isLate, reason: row.reason
      };
    }));
  } catch (error) { sendDbError(res, error); }
}

app.get('/api/hr/daily-master', authenticate, requireRole('HR'), requireDbConfig, dailyMaster);
app.get('/api/hr/daily', authenticate, requireRole('HR'), requireDbConfig, dailyMaster);

app.get('/api/hr/audit/:paycode', authenticate, requireRole('HR'), requireDbConfig, async (req, res) => {
  const range = parseDateRange(req.query, 31);
  if (!validateRange(res, range)) return;
  try {
    const pool = await getPool();
    const employeeResult = await pool.request().input('paycode', sql.VarChar(50), req.params.paycode).query(`
      SELECT TOP 1 e.paycode, e.empname, e.presentcardno,
        LTRIM(RTRIM(e.companycode)) AS companycode, LTRIM(RTRIM(c.companyname)) AS companyname,
        LTRIM(RTRIM(e.departmentcode)) AS departmentcode, LTRIM(RTRIM(d.departmentname)) AS departmentname,
        LTRIM(RTRIM(e.designation)) AS designation, e.dateofbirth, e.dateofjoin,
        LTRIM(RTRIM(e.sex)) AS sex, LTRIM(RTRIM(e.cat)) AS cat,
        LTRIM(RTRIM(e.ismarried)) AS ismarried, LTRIM(RTRIM(e.active)) AS active
      FROM dbo.tblemployee e
      LEFT JOIN dbo.tbldepartment d ON LTRIM(RTRIM(d.departmentcode)) = LTRIM(RTRIM(e.departmentcode))
      LEFT JOIN dbo.tblcompany c ON LTRIM(RTRIM(c.companycode)) = LTRIM(RTRIM(e.companycode))
      WHERE e.paycode = @paycode`);
    if (!employeeResult.recordset[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });
    const rows = await queryAttendance(pool, req.params.paycode, range), stats = calculateStats(rows), total = stats.present + stats.absent + stats.miss;
    res.json({ employee: employeeResult.recordset[0], stats: { ...stats, attendancePercentage: total ? Number((stats.present / total * 100).toFixed(1)) : 0 }, attendance: rows.map(normalizeAttendance) });
  } catch (error) { sendDbError(res, error); }
});

app.get('/api/hr/category-analytics', authenticate, requireRole('HR'), requireDbConfig, async (req, res) => {
  const range = resolveAttendanceRange({ ...(req.query || {}), days: undefined });
  if (range.error) return res.status(400).json({ success: false, message: range.error });
  // Weekly/monthly without explicit bounds still need a real range: resolveAttendanceRange handles it.
  const effective = (req.query?.fromDate && req.query?.toDate)
    ? { mode: range.mode, fromDate: range.fromDate, toDate: range.toDate }
    : range;
  try {
    const pool = await getPool();
    const [empResult, regResult] = await Promise.all([
      pool.request().query('SELECT paycode, companycode, departmentcode FROM dbo.tblemployee'),
      pool.request().input('fromDate', sql.Date, effective.fromDate).input('toDate', sql.Date, effective.toDate).query(
        `SELECT ${attendanceFields} FROM dbo.tbltimeregister WHERE dateoffice >= @fromDate AND dateoffice < DATEADD(DAY, 1, @toDate)`)
    ]);
    // SAME aggregateAttendance definitions, split per company. Mutually exclusive
    // status buckets: complete / miss / absent. Punched is reported separately
    // (detection metric) and must NOT be a pie slice next to miss.
    const regByPaycode = new Map();
    for (const row of regResult.recordset) {
      const k = String(row.paycode).trim();
      if (!regByPaycode.has(k)) regByPaycode.set(k, []);
      regByPaycode.get(k).push(row);
    }
    const byCompany = new Map(), byDepartment = new Map();
    let punchedTotal = 0, completeTotal = 0, missTotal = 0, absentTotal = 0, lateTotal = 0;
    for (const emp of empResult.recordset) {
      const rows = (regByPaycode.get(String(emp.paycode).trim()) || [])
        .filter(r => classifyRow({ ...r, statusCode: attendanceCode(r.status) }) !== 'Week Off');
      const comp = String(emp.companycode || '—').trim() || '—';
      if (!byCompany.has(comp)) byCompany.set(comp, { companycode: comp, complete: 0, miss: 0, absent: 0, late: 0, punched: 0 });
      const bucket = byCompany.get(comp);
      const hasAnyPunch = rows.some(hasPunch);
      const hasComplete = rows.some(hasCompletePunch);
      const hasIncomplete = rows.some(r => hasPunch(r) && !hasCompletePunch(r));
      if (hasAnyPunch) { bucket.punched += 1; punchedTotal += 1; }
      else { bucket.absent += 1; absentTotal += 1; }
      if (hasComplete) { bucket.complete += 1; completeTotal += 1; }
      else if (hasIncomplete) { bucket.miss += 1; missTotal += 1; }
      if (rows.some(isLateRow)) { bucket.late += 1; lateTotal += 1; }
      // SAME mutually exclusive status buckets, split per department (real master codes).
      const deptKey = String(emp.departmentcode || '').trim() || '—';
      if (!byDepartment.has(deptKey)) byDepartment.set(deptKey, { departmentcode: deptKey, complete: 0, miss: 0, absent: 0, late: 0, punched: 0 });
      const dbucket = byDepartment.get(deptKey);
      if (hasAnyPunch) dbucket.punched += 1;
      else dbucket.absent += 1;
      if (hasComplete) dbucket.complete += 1;
      else if (hasIncomplete) dbucket.miss += 1;
      if (rows.some(isLateRow)) dbucket.late += 1;
    }
    res.json({
      indiaToday: indiaTodayISO(), mode: effective.mode, fromDate: effective.fromDate, toDate: effective.toDate,
      punched: punchedTotal, complete: completeTotal, miss: missTotal, absent: absentTotal, late: lateTotal,
      punchedToday: punchedTotal,
      companies: [...byCompany.values()].sort((a, b) => String(a.companycode).localeCompare(String(b.companycode))),
      departments: [...byDepartment.values()].sort((a, b) => String(a.departmentcode).localeCompare(String(b.departmentcode)))
    });
  } catch (error) { sendDbError(res, error); }
});

// DISTINCT master-data filter values straight from dbo.tblemployee (+ department /
// company / category name lookups). Read-only; no schema change, no invented values.
app.get('/api/hr/filters', authenticate, requireRole('HR'), requireDbConfig, async (req, res) => {
  try {
    const result = await (await getPool()).request().batch(`
      SELECT DISTINCT LTRIM(RTRIM(e.departmentcode)) AS code, LTRIM(RTRIM(d.departmentname)) AS name
      FROM dbo.tblemployee e
      LEFT JOIN dbo.tbldepartment d ON LTRIM(RTRIM(d.departmentcode)) = LTRIM(RTRIM(e.departmentcode))
      WHERE LTRIM(RTRIM(e.departmentcode)) <> ''
      ORDER BY code;
      SELECT DISTINCT LTRIM(RTRIM(e.companycode)) AS code, LTRIM(RTRIM(c.companyname)) AS name
      FROM dbo.tblemployee e
      LEFT JOIN dbo.tblcompany c ON LTRIM(RTRIM(c.companycode)) = LTRIM(RTRIM(e.companycode))
      WHERE LTRIM(RTRIM(e.companycode)) <> ''
      ORDER BY code;
      SELECT DISTINCT LTRIM(RTRIM(cat)) AS code FROM dbo.tblemployee WHERE LTRIM(RTRIM(cat)) <> '' ORDER BY code;
      SELECT * FROM dbo.tblcategory;
      SELECT DISTINCT LTRIM(RTRIM(sex)) AS sex FROM dbo.tblemployee WHERE LTRIM(RTRIM(sex)) <> '' ORDER BY sex;
      SELECT DISTINCT LTRIM(RTRIM(designation)) AS designation FROM dbo.tblemployee WHERE LTRIM(RTRIM(designation)) <> '' ORDER BY designation;
      SELECT DISTINCT LTRIM(RTRIM(ismarried)) AS ismarried FROM dbo.tblemployee WHERE LTRIM(RTRIM(ismarried)) <> '' ORDER BY ismarried;
      SELECT DISTINCT LTRIM(RTRIM(active)) AS active FROM dbo.tblemployee WHERE LTRIM(RTRIM(active)) <> '' ORDER BY active;`);
    const rs = result.recordsets || [];
    const clean = v => String(v == null ? '' : v).trim();
    // tblcategory column names are not assumed: pick the code/name keys generically.
    const categories = (rs[3] || []).map(row => {
      const keys = Object.keys(row);
      const codeKey = keys.find(k => /code/i.test(k)) || keys[0];
      const nameKey = keys.find(k => /name/i.test(k) && !/code/i.test(k));
      return { code: clean(row[codeKey]), name: nameKey ? clean(row[nameKey]) : '' };
    }).filter(c => c.code);
    res.json({
      departments: (rs[0] || []).map(r => ({ code: clean(r.code), name: clean(r.name) })),
      companies: (rs[1] || []).map(r => ({ code: clean(r.code), name: clean(r.name) })),
      categories,
      genders: (rs[4] || []).map(r => clean(r.sex)).filter(Boolean),
      designations: (rs[5] || []).map(r => clean(r.designation)).filter(Boolean),
      maritalStatuses: (rs[6] || []).map(r => clean(r.ismarried)).filter(Boolean),
      statuses: (rs[7] || []).map(r => clean(r.active)).filter(Boolean)
    });
  } catch (error) { sendDbError(res, error); }
});

app.get('/api/hr/celebrations', authenticate, requireRole('HR'), requireDbConfig, async (_req, res) => {
  try {
    const pool = await getPool();
    const employees = await pool.request().query('SELECT paycode, empname, presentcardno, companycode FROM dbo.tblemployee ORDER BY empname');
    const marriages = await pool.request().query(`SELECT id, paycode, presentcardno, anniversarydate, createddate, updateddate, importedby FROM ${marriageTable}`);
    res.json({ employees: employees.recordset, marriages: marriages.recordset });
  } catch (error) { sendDbError(res, error); }
});

app.get('/api/marriage-anniversary', requireDbConfig, authenticate, requireRole('HR', 'EMPLOYEE'), async (req, res) => {
  try {
    const request = (await getPool()).request().input('paycode', sql.VarChar(50), req.user.role === 'EMPLOYEE' ? req.user.paycode : null);
    const result = await request.query(`SELECT id, paycode, presentcardno, anniversarydate, createddate, updateddate, importedby FROM ${marriageTable} WHERE (@paycode IS NULL OR paycode = @paycode) ORDER BY anniversarydate`);
    res.json(result.recordset);
  } catch (error) { sendDbError(res, error); }
});

app.get('/api/raw-punches', requireDbConfig, authenticate, async (req, res) => {
  const range = parseDateRange(req.query, 7);
  if (!validateRange(res, range)) return;
  try {
    const request = (await getPool()).request().input('fromDate', sql.Date, range.fromDate).input('toDate', sql.Date, range.toDate);
    let filter = '';
    if (req.user.role === 'EMPLOYEE' || req.query.paycode) {
      request.input('paycode', sql.VarChar(50), req.user.role === 'EMPLOYEE' ? req.user.paycode : String(req.query.paycode));
      filter = 'AND e.paycode = @paycode';
    }
    const result = await request.query(`SELECT p.cardno, p.mc_no, p.officepunch, p.inout, p.ismanual FROM dbo.machinerawpunch p JOIN dbo.tblemployee e ON e.presentcardno = p.cardno WHERE p.officepunch >= @fromDate AND p.officepunch < DATEADD(DAY, 1, @toDate) ${filter} ORDER BY p.officepunch DESC`);
    res.json(result.recordset);
  } catch (error) { sendDbError(res, error); }
});

app.post('/api/marriage-anniversary/validate', authenticate, requireRole('HR'), requireDbConfig, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [], pool = await getPool(), validated = [];
    for (const row of rows) {
      const result = await pool.request().input('employeeCode', sql.VarChar(50), String(row.employeeCode || '').trim() || null).input('biometricCode', sql.VarChar(50), String(row.biometricCode || '').trim() || null).query('SELECT TOP 1 paycode, presentcardno, empname, companycode FROM dbo.tblemployee WHERE (@employeeCode IS NOT NULL AND paycode = @employeeCode) OR (@biometricCode IS NOT NULL AND presentcardno = @biometricCode)');
      validated.push({ ...row, employee: result.recordset[0] || null });
    }
    res.json({ rows: validated });
  } catch (error) { sendDbError(res, error); }
});

app.post('/api/marriage-anniversary/import', authenticate, requireRole('HR'), requireDbConfig, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  try {
    const transaction = new sql.Transaction(await getPool());
    await transaction.begin();
    try {
      for (const row of rows) {
        if (!row.employee || !isValidIsoDate(row.anniversaryDate)) continue;
        const request = new sql.Request(transaction);
        request.input('paycode', sql.VarChar(50), row.employee.paycode).input('presentcardno', sql.VarChar(50), row.employee.presentcardno || null).input('anniversarydate', sql.Date, row.anniversaryDate).input('importedby', sql.VarChar(50), String(req.user?.sub || 'HR').slice(0, 50));
        await request.query(`UPDATE ${marriageTable} SET presentcardno = @presentcardno, anniversarydate = @anniversarydate, updateddate = GETDATE(), importedby = @importedby WHERE paycode = @paycode; IF @@ROWCOUNT = 0 INSERT INTO ${marriageTable} (paycode, presentcardno, anniversarydate, createddate, updateddate, importedby) VALUES (@paycode, @presentcardno, @anniversarydate, GETDATE(), GETDATE(), @importedby);`);
      }
      await transaction.commit();
    } catch (error) { await transaction.rollback(); throw error; }
    res.json({ imported: rows.filter(row => row.employee && isValidIsoDate(row.anniversaryDate)).length });
  } catch (error) { sendDbError(res, error); }
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  res.status(error.statusCode === 400 ? 400 : 500).json({ success: false, message: error.statusCode === 400 ? 'Invalid JSON request.' : 'Server error.' });
});

app.listen(port, () => console.log(`Attendance API listening on port ${port}`));
