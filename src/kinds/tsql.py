#!/usr/bin/env python3
"""T-SQL (Microsoft SQL Server) runner for the UIP sandbox.

There is no SQL Server in the sandbox image, so this runs a practical SUBSET of T-SQL on an in-memory SQLite database:
GO batches, PRINT, DECLARE / SET / SELECT @var, IF / ELSE, WHILE, BEGIN..END, TRY..CATCH, RAISERROR / THROW, temp tables (#t),
table variables, TOP / OFFSET-FETCH, IDENTITY, CONVERT, dbo. prefixes, [brackets], N'strings', GETDATE / ISNULL / LEN / DATEADD ...
Output looks like sqlcmd. Stored procedures, functions, triggers, cursors and the sys.* catalog are NOT supported.
"""
import re
import sqlite3
import sys
import math
import uuid
import datetime as dt

# ───────────────────────── errors ─────────────────────────
class TsqlError(Exception):
    def __init__(self, msg, num=50000, level=16, state=1):
        super().__init__(msg)
        self.msg, self.num, self.level, self.state = msg, num, level, state

class Return_(Exception): pass
class Break_(Exception): pass
class Continue_(Exception): pass

# ───────────────────────── lexing helpers ─────────────────────────
STARTERS = {'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'PRINT', 'DECLARE', 'SET', 'IF', 'ELSE',
            'WHILE', 'BEGIN', 'END', 'EXEC', 'EXECUTE', 'RETURN', 'BREAK', 'CONTINUE', 'WITH', 'USE', 'RAISERROR', 'THROW',
            'COMMIT', 'ROLLBACK', 'GRANT', 'MERGE', 'WAITFOR'}
CONT_PREV = {'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'AS', 'EXISTS', 'IN', 'ANY', 'SOME', 'AND', 'OR', 'NOT', 'ON', 'INTO'}

def strip_comments(s):
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == "'":
            j = i + 1
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'": j += 2; continue
                    break
                j += 1
            out.append(s[i:j + 1]); i = j + 1
        elif s.startswith('--', i):
            j = s.find('\n', i); j = n if j < 0 else j
            i = j
        elif s.startswith('/*', i):
            j = s.find('*/', i + 2); j = n if j < 0 else j + 2
            out.append('\n' * s.count('\n', i, j)); i = j
        else:
            out.append(c); i += 1
    return ''.join(out)

def split_batches(src):
    batches, cur, start = [], [], 1
    for no, line in enumerate(src.split('\n'), 1):
        m = re.match(r'^\s*GO(?:\s+(\d+))?\s*$', line, re.I)
        if m:
            batches.append((start, '\n'.join(cur), int(m.group(1) or 1))); cur = []; start = no + 1
        else:
            cur.append(line)
    batches.append((start, '\n'.join(cur), 1))
    return [b for b in batches if b[1].strip()]

def split_statements(batch, first_line):
    """-> [(text, line)] — splits on ';' and on statement-starting keywords at paren depth 0."""
    out = []
    S, line_of_S = [], first_line
    depth = case = 0
    i, n, line = 0, len(batch), first_line

    def flush():
        nonlocal S
        t = ''.join(S).strip()
        if t: out.append((t, line_of_S))
        S = []

    while i < n:
        c = batch[i]
        if c == '\n': line += 1
        if c == "'":
            j = i + 1
            while j < n:
                if batch[j] == "'":
                    if j + 1 < n and batch[j + 1] == "'": j += 2; continue
                    break
                j += 1
            S.append(batch[i:j + 1]); i = j + 1; continue
        if c == '[':
            j = batch.find(']', i); j = n - 1 if j < 0 else j
            S.append(batch[i:j + 1]); i = j + 1; continue
        if c == '(': depth += 1
        elif c == ')': depth -= 1
        elif c == ';' and depth <= 0:
            flush(); i += 1; line_of_S = line; continue
        elif (c.isalpha() or c == '_') and (i == 0 or not (batch[i - 1].isalnum() or batch[i - 1] in '_@#$.')):
            m = re.match(r'[A-Za-z_][A-Za-z_0-9]*', batch[i:]); w = m.group(0); W = w.upper()
            if depth <= 0:
                cur = ''.join(S).strip(); CU = cur.upper()
                if W == 'CASE': case += 1
                elif W == 'END' and case > 0: case -= 1; S.append(w); i += len(w); continue
                if case == 0 and cur:
                    split = False
                    last = re.findall(r'[A-Za-z_]+|[^\s\w]', CU)[-1] if CU else ''
                    if CU in ('BEGIN', 'END', 'ELSE', 'BEGIN TRY', 'END TRY', 'BEGIN CATCH', 'END CATCH'):
                        split = not (CU in ('BEGIN', 'END') and W in ('TRY', 'CATCH', 'TRAN', 'TRANSACTION'))
                    elif CU.startswith(('IF', 'WHILE')):
                        split = W in STARTERS and W not in ('END',) and last not in CONT_PREV
                        if CU.startswith('IF') and W == 'ELSE': split = True
                    elif W in STARTERS and last not in CONT_PREV and last not in ('(', ',', '=', '+', '-', '*', '/', '<', '>'):
                        split = True
                        if W == 'SELECT' and CU.startswith('INSERT') and 'VALUES' not in CU and 'SELECT' not in CU: split = False
                        if W == 'SET' and CU.startswith(('UPDATE', 'MERGE')): split = False
                        if W == 'DELETE' and CU.startswith('MERGE'): split = False
                        if W in ('INSERT', 'UPDATE', 'DELETE') and CU.startswith('MERGE'): split = False
                        if W == 'WITH' and CU.startswith('SELECT'): split = False
                        if W == 'SELECT' and CU.startswith('CREATE') and last == 'AS': split = False
                    if split:
                        flush(); line_of_S = line
            S.append(w); i += len(w); continue
        S.append(c); i += 1
    flush()
    return out

# ───────────────────────── translation T-SQL → SQLite ─────────────────────────
STRFUNCS = {'LTRIM', 'RTRIM', 'TRIM', 'UPPER', 'LOWER', 'REPLICATE', 'SUBSTRING', 'SUBSTR', 'LEFT', 'RIGHT', 'SPACE', 'REVERSE', 'STR', 'CHAR',
            'CONCAT', 'FORMAT', 'REPLACE', 'STUFF', 'NCHAR'}
STRTYPES = re.compile(r'\b(N?VARCHAR|N?CHAR|TEXT|NTEXT|SYSNAME)\b', re.I)

def tokenize(s):
    toks, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c.isspace(): j = i
        elif c == "'":
            j = i + 1
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'": j += 2; continue
                    break
                j += 1
            j += 1; toks.append(s[i:j]); i = j; continue
        elif c == '"':
            j = s.find('"', i + 1); j = n - 1 if j < 0 else j
            toks.append(s[i:j + 1]); i = j + 1; continue
        elif c == '[':
            j = s.find(']', i); j = n - 1 if j < 0 else j
            toks.append('"' + s[i + 1:j].replace('"', '""') + '"'); i = j + 1; continue
        elif c.isalnum() or c in '_@#$':
            j = i
            while j < n and (s[j].isalnum() or s[j] in '_@#$'): j += 1
            toks.append(s[i:j]); i = j; continue
        elif c.isspace():
            pass
        else:
            two = s[i:i + 2]
            if two in ('<>', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '||', '::'): toks.append(two); i += 2; continue
            toks.append(c); i += 1; continue
        # whitespace run
        j = i
        while j < n and s[j].isspace(): j += 1
        toks.append(' '); i = j
    return toks

def match_paren(toks, i):
    d = 0
    for j in range(i, len(toks)):
        if toks[j] == '(': d += 1
        elif toks[j] == ')':
            d -= 1
            if d == 0: return j
    return len(toks) - 1

def is_stringy_call(toks, i):
    """toks[i] is a name followed by '(' — is the call known to return text?"""
    name = toks[i].upper()
    if name in STRFUNCS: return True
    j = i + 1
    while j < len(toks) and toks[j] == ' ': j += 1
    if j >= len(toks) or toks[j] != '(': return False
    e = match_paren(toks, j)
    inner = ''.join(toks[j + 1:e])
    if name == 'CAST': return bool(STRTYPES.search(inner.rsplit(' AS ', 1)[-1] if ' AS ' in inner.upper() else ''))
    if name == 'CONVERT': return bool(STRTYPES.match(inner.strip()))
    return False

def fix_concat(toks):
    """'a' + CAST(x AS VARCHAR) + 'b'  →  with || (only where an operand is clearly text)."""
    ns = [k for k, t in enumerate(toks) if t != ' ']          # non-space token indexes
    pos = {k: p for p, k in enumerate(ns)}
    chain_end = -1
    def left_stringy(p):
        k = ns[p - 1] if p > 0 else None
        if k is None: return False
        t = toks[k]
        if t.startswith("'"): return True
        if t == ')':
            d = 0
            for q in range(k, -1, -1):
                if toks[q] == ')': d += 1
                elif toks[q] == '(':
                    d -= 1
                    if d == 0:
                        r = q - 1
                        while r >= 0 and toks[r] == ' ': r -= 1
                        return r >= 0 and is_stringy_call(toks, r)
        return False
    for p, k in enumerate(ns):
        if toks[k] != '+' or p == 0 or p + 1 >= len(ns): continue
        nk = ns[p + 1]; nt = toks[nk]
        right_end = nk
        right = nt.startswith("'")
        if re.match(r'[A-Za-z_]', nt) and p + 2 < len(ns) and toks[ns[p + 2]] == '(':
            right_end = match_paren(toks, ns[p + 2])
            right = is_stringy_call(toks, nk)
        left = left_stringy(p) or (ns[p - 1] == chain_end)
        if left or right:
            toks[k] = '||'; chain_end = right_end
    return toks

def replace_calls(s, name, fn):
    """Replace NAME( args ) by fn(args_list) — arguments split on top-level commas."""
    out, i = [], 0
    rx = re.compile(r'\b' + name + r'\s*\(', re.I)
    while True:
        m = rx.search(s, i)
        if not m: out.append(s[i:]); break
        # skip when inside a string — cheap check: odd number of quotes before
        if s.count("'", 0, m.start()) % 2: out.append(s[i:m.end()]); i = m.end(); continue
        j, d, args, cur = m.end(), 1, [], []
        while j < len(s) and d:
            c = s[j]
            if c == "'":
                k = j + 1
                while k < len(s):
                    if s[k] == "'":
                        if k + 1 < len(s) and s[k + 1] == "'": k += 2; continue
                        break
                    k += 1
                cur.append(s[j:k + 1]); j = k + 1; continue
            if c == '(': d += 1
            elif c == ')':
                d -= 1
                if d == 0: break
            if c == ',' and d == 1: args.append(''.join(cur)); cur = []
            else: cur.append(c)
            j += 1
        args.append(''.join(cur))
        out.append(s[i:m.start()]); out.append(fn([a.strip() for a in args])); i = j + 1
    return ''.join(out)

def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, bool): return '1' if v else '0'
    if isinstance(v, (int, float)): return repr(v)
    return "'" + str(v).replace("'", "''") + "'"

class Session:
    def __init__(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.vars = {}
        self.tablevars = set()
        self.types = {}
        self.rowcount = 0
        self.nocount = False
        self.try_depth = 0
        self.errors = 0
        self.last_err = None
        self.line = 1
        self._funcs()

    # ---- SQL Server functions, registered into SQLite ----
    def _funcs(self):
        d = self.db
        def reg(name, fn, n=-1): d.create_function(name, n, fn)
        now = lambda: dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
        for nm in ('GETDATE', 'SYSDATETIME', 'GETUTCDATE', 'SYSUTCDATETIME', 'CURRENT_TIMESTAMP_'): reg(nm, now, 0)
        reg('ISNULL', lambda a, b: b if a is None else a, 2)
        reg('LEN', lambda s: None if s is None else len(str(s).rstrip(' ')), 1)
        reg('DATALENGTH', lambda s: None if s is None else len(str(s).encode()), 1)
        reg('LEFT', lambda s, n: None if s is None else str(s)[:int(n)], 2)
        reg('RIGHT', lambda s, n: None if s is None else (str(s)[-int(n):] if int(n) > 0 else ''), 2)
        reg('SPACE', lambda n: ' ' * int(n), 1)
        reg('REPLICATE', lambda s, n: None if s is None else str(s) * int(n), 2)
        reg('REVERSE', lambda s: None if s is None else str(s)[::-1], 1)
        reg('CHARINDEX', lambda sub, s, start=1: 0 if s is None else str(s).find(str(sub), max(int(start) - 1, 0)) + 1)
        reg('STUFF', lambda s, st, ln, rep: None if s is None else str(s)[:int(st) - 1] + (rep or '') + str(s)[int(st) - 1 + int(ln):], 4)
        reg('CEILING', lambda x: None if x is None else math.ceil(x), 1)
        reg('FLOOR', lambda x: None if x is None else math.floor(x), 1)
        reg('POWER', lambda a, b: None if a is None else a ** b, 2)
        reg('SQRT', lambda x: None if x is None else math.sqrt(x), 1)
        reg('SQUARE', lambda x: None if x is None else x * x, 1)
        reg('NEWID', lambda: str(uuid.uuid4()).upper(), 0)
        reg('CHAR', lambda n: None if n is None else chr(int(n)), 1)
        reg('ASCII', lambda s: None if not s else ord(str(s)[0]), 1)
        reg('ISNUMERIC', lambda s: 1 if re.fullmatch(r'\s*[-+]?(\d+\.?\d*|\.\d+)\s*', str(s)) else 0, 1)
        reg('STR', lambda x, ln=10, dec=0: None if x is None else ('%*.*f' % (int(ln), int(dec), float(x))), -1)
        reg('OBJECT_ID', lambda name, typ=None: self._object_id(name), -1)
        reg('DB_NAME', lambda *a: 'master', -1)
        reg('SCOPE_IDENTITY', lambda: self.db.execute('select last_insert_rowid()').fetchone()[0], 0)
        reg('PARSENAME', lambda s, n: (str(s).split('.')[::-1] + [None] * 4)[int(n) - 1], 2)
        def parse(v):
            if isinstance(v, dt.datetime): return v
            s = str(v).strip().replace('T', ' ')
            for f in ('%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d', '%Y%m%d'):
                try: return dt.datetime.strptime(s, f)
                except ValueError: pass
            raise TsqlError('Conversion failed when converting date and/or time from character string.', 241)
        def fmt(x): return x.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3] if (x.hour or x.minute or x.second or x.microsecond) else x.strftime('%Y-%m-%d')
        def dateadd(part, n, v):
            if v is None: return None
            x = parse(v); n = int(n); p = str(part).lower()
            if p in ('year', 'yy', 'yyyy'): y = x.year + n; x = x.replace(year=y, day=min(x.day, 28 if x.month == 2 else x.day))
            elif p in ('month', 'mm', 'm'):
                mo = x.month - 1 + n; y = x.year + mo // 12; mo = mo % 12 + 1
                import calendar; x = x.replace(year=y, month=mo, day=min(x.day, calendar.monthrange(y, mo)[1]))
            elif p in ('quarter', 'qq', 'q'): return dateadd('month', n * 3, v)
            elif p in ('week', 'wk', 'ww'): x += dt.timedelta(weeks=n)
            elif p in ('day', 'dd', 'd', 'dayofyear', 'dy', 'y'): x += dt.timedelta(days=n)
            elif p in ('hour', 'hh'): x += dt.timedelta(hours=n)
            elif p in ('minute', 'mi', 'n'): x += dt.timedelta(minutes=n)
            elif p in ('second', 'ss', 's'): x += dt.timedelta(seconds=n)
            else: raise TsqlError("'%s' is not a recognized dateadd option." % part, 155)
            return fmt(x)
        def datediff(part, a, b):
            if a is None or b is None: return None
            x, y = parse(a), parse(b); p = str(part).lower()
            if p in ('year', 'yy', 'yyyy'): return y.year - x.year
            if p in ('month', 'mm', 'm'): return (y.year - x.year) * 12 + y.month - x.month
            if p in ('quarter', 'qq', 'q'): return ((y.year - x.year) * 12 + y.month - x.month) // 3
            if p in ('day', 'dd', 'd'): return (y.date() - x.date()).days
            if p in ('week', 'wk', 'ww'): return (y.date() - x.date()).days // 7
            sec = int((y - x).total_seconds())
            return {'hour': sec // 3600, 'hh': sec // 3600, 'minute': sec // 60, 'mi': sec // 60, 'n': sec // 60, 'second': sec, 'ss': sec, 's': sec}.get(p, sec)
        def datepart(part, v):
            if v is None: return None
            x = parse(v); p = str(part).lower()
            return {'year': x.year, 'yy': x.year, 'yyyy': x.year, 'month': x.month, 'mm': x.month, 'm': x.month, 'day': x.day, 'dd': x.day, 'd': x.day,
                    'hour': x.hour, 'hh': x.hour, 'minute': x.minute, 'mi': x.minute, 'n': x.minute, 'second': x.second, 'ss': x.second, 's': x.second,
                    'quarter': (x.month - 1) // 3 + 1, 'qq': (x.month - 1) // 3 + 1, 'q': (x.month - 1) // 3 + 1,
                    'weekday': (x.weekday() + 1) % 7 + 1, 'dw': (x.weekday() + 1) % 7 + 1, 'dayofyear': x.timetuple().tm_yday, 'dy': x.timetuple().tm_yday,
                    'week': int(x.strftime('%U')) + 1, 'wk': int(x.strftime('%U')) + 1}.get(p)
        def datename(part, v):
            x = parse(v); p = str(part).lower()
            if p in ('month', 'mm', 'm'): return x.strftime('%B')
            if p in ('weekday', 'dw'): return x.strftime('%A')
            return str(datepart(part, v))
        reg('DATEADD', dateadd, 3); reg('DATEDIFF', datediff, 3); reg('DATEPART', datepart, 2); reg('DATENAME', datename, 2)
        reg('YEAR', lambda v: None if v is None else parse(v).year, 1)
        reg('MONTH', lambda v: None if v is None else parse(v).month, 1)
        reg('DAY', lambda v: None if v is None else parse(v).day, 1)
        reg('EOMONTH', lambda v, k=0: None if v is None else fmt(parse(dateadd('month', k + 1, parse(v).replace(day=1))) - dt.timedelta(days=1)), -1)
        reg('ISDATE', lambda v: 1 if _ok(parse, v) else 0, 1)
        reg('FORMAT', lambda v, f, *a: _format(v, f), -1)

    def _object_id(self, name):
        if name is None: return None
        n = re.sub(r'^(?:\w+\.)*', '', str(name)).strip('[]"').replace('#', '_tmp_')
        r = self.db.execute("select rowid from sqlite_master where lower(name)=lower(?) union all select rowid from sqlite_temp_master where lower(name)=lower(?)", (n, n)).fetchone()
        return r[0] if r else None

    # ---- text translation ----
    def translate(self, sql):
        s = sql
        # variables → literals (done first: the text of a string variable then makes '+' → '||' detectable)
        def var(m):
            name = m.group(0).lower()
            if name in self.tablevars: return 'tv_' + name[1:]
            if name not in self.vars: raise TsqlError('Must declare the scalar variable "%s".' % m.group(0), 137)
            return lit(self.vars[name])
        s = _outside_strings(s, lambda t: re.sub(r'(?<![@\w])@(?!@)\w+', var, t))
        s = _outside_strings(s, lambda t: re.sub(r'@@ROWCOUNT\b', str(self.rowcount), t, flags=re.I))
        s = _outside_strings(s, lambda t: re.sub(r'@@IDENTITY\b', 'last_insert_rowid()', t, flags=re.I))
        s = _outside_strings(s, lambda t: re.sub(r'@@VERSION\b', "'UIP T-SQL (SQLite engine)'", t, flags=re.I))
        s = _outside_strings(s, lambda t: re.sub(r'@@(SERVERNAME|SERVICENAME)\b', "'UIP'", t, flags=re.I))
        s = _outside_strings(s, lambda t: re.sub(r'@@ERROR\b', '0', t, flags=re.I))
        if self.last_err:
            e = self.last_err
            for nm, v in (('ERROR_MESSAGE', e.msg), ('ERROR_NUMBER', e.num), ('ERROR_SEVERITY', e.level), ('ERROR_STATE', e.state), ('ERROR_LINE', self.line), ('ERROR_PROCEDURE', None)):
                s = _outside_strings(s, lambda t, nm=nm, v=v: re.sub(r'\b' + nm + r'\s*\(\s*\)', lit(v), t, flags=re.I))
        s = re.sub(r"\bN'", "'", s)
        s = _outside_strings(s, lambda t: re.sub(r'\bISNULL\s*\(', 'IFNULL(', t, flags=re.I))
        s = _outside_strings(s, lambda t: re.sub(r'(?<!\w)#{1,2}(?=\w)', '_tmp_', t))
        s = _outside_strings(s, lambda t: re.sub(r'\b(?:\[?dbo\]?|\[?sys\]?)\s*\.\s*(?=[\w"\[])', '', t, flags=re.I))
        s = re.sub(r'\bSCOPE_IDENTITY\s*\(\s*\)', 'last_insert_rowid()', s, flags=re.I)
        # CONVERT(type, expr [, style]) → CAST(expr AS type)
        s = replace_calls(s, 'CONVERT', lambda a: 'CAST(%s AS %s)' % (a[1], re.sub(r'\((?:max|\d+(?:\s*,\s*\d+)?)\)', '', a[0], flags=re.I)) if len(a) >= 2 else 'CONVERT(%s)' % ','.join(a))
        s = replace_calls(s, 'TRY_CAST', lambda a: 'CAST(%s)' % ','.join(a))
        s = replace_calls(s, 'TRY_CONVERT', lambda a: 'CAST(%s AS %s)' % (a[1], a[0]))
        s = replace_calls(s, 'CHOOSE', lambda a: 'CASE ' + a[0] + ' ' + ' '.join('WHEN %d THEN %s' % (k, v) for k, v in enumerate(a[1:], 1)) + ' END')
        s = re.sub(r'\b(N?VARCHAR|N?CHAR|VARBINARY)\s*\(\s*MAX\s*\)', 'TEXT', s, flags=re.I)
        s = re.sub(r'\b(N?TEXT|NTEXT)\b(?=\s*[,)])', 'TEXT', s, flags=re.I)
        s = re.sub(r'\bDECIMAL\s*\(\s*\d+\s*,\s*\d+\s*\)|\bNUMERIC\s*\(\s*\d+\s*,\s*\d+\s*\)', 'REAL', s, flags=re.I)
        # IDENTITY column
        s = re.sub(r'((?:"[^"]+"|\w+)\s+)(?:BIG|SMALL|TINY)?INT\s+IDENTITY(?:\s*\(\s*\d+\s*,\s*\d+\s*\))?(?:\s+NOT\s+NULL)?(?:\s+PRIMARY\s+KEY(?:\s+(?:NON)?CLUSTERED)?)?',
                   r'\1INTEGER PRIMARY KEY AUTOINCREMENT', s, flags=re.I)
        s = re.sub(r'\bPRIMARY\s+KEY\s+(?:NON)?CLUSTERED\b', 'PRIMARY KEY', s, flags=re.I)
        s = re.sub(r'\b(?:NON)?CLUSTERED\s+(?=\()', '', s, flags=re.I)
        s = re.sub(r'\bDEFAULT\s+((?:\w+)\s*\([^()]*\))', r'DEFAULT (\1)', s, flags=re.I)
        s = re.sub(r'\bWITH\s*\(\s*NOLOCK\s*\)', '', s, flags=re.I)
        s = re.sub(r'\bTRUNCATE\s+TABLE\b', 'DELETE FROM', s, flags=re.I)
        # SELECT … INTO #t FROM …
        m = re.match(r'\s*SELECT\b(.*?)\bINTO\s+("?[#\w]+"?)\s+(FROM\b.*)$', s, re.I | re.S)
        if m: s = 'CREATE TEMP TABLE %s AS SELECT %s %s' % (m.group(2), m.group(1), m.group(3))
        # TOP n  →  LIMIT n
        tops = re.findall(r'\bTOP\s*\(?\s*(\d+)\s*\)?(?:\s+PERCENT)?', s, re.I)
        if len(tops) == 1 and not re.search(r'\bLIMIT\b', s, re.I):
            s = re.sub(r'\bTOP\s*\(?\s*\d+\s*\)?(?:\s+PERCENT)?\s*', '', s, count=1, flags=re.I).rstrip().rstrip(';') + ' LIMIT ' + tops[0]
        # OFFSET n ROWS FETCH NEXT m ROWS ONLY
        s = re.sub(r'\bOFFSET\s+(\d+)\s+ROWS?\s+FETCH\s+(?:NEXT|FIRST)\s+(\d+)\s+ROWS?\s+ONLY', r'LIMIT \2 OFFSET \1', s, flags=re.I)
        s = re.sub(r'\bOFFSET\s+(\d+)\s+ROWS?\b(?!\s+FETCH)', r'LIMIT -1 OFFSET \1', s, flags=re.I)
        # string concatenation with '+'
        s = ''.join(fix_concat(tokenize(s)))
        return s

    # ---- execution ----
    def run_sql(self, sql, show=True):
        t = self.translate(sql)
        try:
            cur = self.db.execute(t)
        except sqlite3.Error as e:
            raise self.map_error(e, sql)
        if cur.description:
            rows = cur.fetchall()
            self.rowcount = len(rows)
            if show: self.show(cur.description, rows)
            return rows
        self.rowcount = cur.rowcount if cur.rowcount >= 0 else 0
        head = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ''
        if show and not self.nocount and head in ('INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE'):
            print('(%d row%s affected)\n' % (self.rowcount, '' if self.rowcount == 1 else 's'))
        return []

    def map_error(self, e, sql):
        m = str(e)
        r = re.match(r'no such table: (?:main\.)?(\S+)', m)
        if r: return TsqlError("Invalid object name '%s'." % r.group(1).replace('_tmp_', '#'), 208)
        r = re.match(r'no such column: (\S+)', m)
        if r: return TsqlError("Invalid column name '%s'." % r.group(1).split('.')[-1].strip('"'), 207)
        r = re.match(r'table (\S+) already exists', m)
        if r: return TsqlError("There is already an object named '%s' in the database." % r.group(1).strip('"').replace('_tmp_', '#'), 2714)
        r = re.match(r'no such function: (\S+)', m)
        if r: return TsqlError("'%s' is not a recognized built-in function name." % r.group(1), 195)
        if 'UNIQUE constraint failed' in m or 'PRIMARY KEY' in m.upper() and 'constraint' in m:
            return TsqlError('Violation of PRIMARY KEY / UNIQUE constraint. Cannot insert duplicate key. (%s)' % m, 2627)
        if 'NOT NULL constraint failed' in m:
            return TsqlError("Cannot insert the value NULL into column '%s'; column does not allow nulls." % m.rsplit('.', 1)[-1], 515)
        if 'FOREIGN KEY' in m: return TsqlError('The statement conflicted with a FOREIGN KEY constraint.', 547)
        if 'CHECK constraint failed' in m: return TsqlError('The statement conflicted with a CHECK constraint.', 547)
        if 'syntax error' in m or 'near' in m: return TsqlError('Incorrect syntax. (%s)' % m, 102, 15)
        return TsqlError(m, 50000)

    def show(self, desc, rows):
        names = []
        for d in desc:
            n = d[0]
            names.append('(No column name)' if (re.fullmatch(r'[-\d.\s]+', n) or '(' in n or n.startswith("'")) else n)
        cells = [[('NULL' if v is None else _fmt(v)) for v in r] for r in rows]
        w = [max([len(names[i])] + [len(c[i]) for c in cells]) for i in range(len(names))]
        num = [all(isinstance(r[i], (int, float)) for r in rows if r[i] is not None) and rows != [] for i in range(len(names))]
        print('  '.join(names[i].ljust(w[i]) for i in range(len(names))).rstrip())
        print('  '.join('-' * w[i] for i in range(len(names))))
        for c in cells:
            print('  '.join((c[i].rjust(w[i]) if num[i] else c[i].ljust(w[i])) for i in range(len(c))).rstrip())
        print('\n(%d row%s affected)\n' % (len(rows), '' if len(rows) == 1 else 's') if not self.nocount else '')

    def eval(self, expr):
        rows = self.run_sql('SELECT ' + expr, show=False)
        return rows[0][0] if rows else None

    def cond(self, expr):
        rows = self.run_sql('SELECT CASE WHEN (%s) THEN 1 ELSE 0 END' % expr, show=False)
        return bool(rows and rows[0][0])

    def exec_one(self, text, line):
        self.line = line
        t = text.strip().rstrip(';').strip()
        w = re.match(r'[A-Za-z]+', t)
        W = w.group(0).upper() if w else ''
        rest = t[len(W):].strip() if w else t
        if W == 'PRINT':
            v = self.eval(rest)
            print('' if v is None else _fmt(v))
            return
        if W == 'DECLARE':
            for part in _split_top(rest):
                m = re.match(r'(@\w+)\s+(?:AS\s+)?(TABLE\b.*)$', part, re.I | re.S)
                if m:
                    nm = m.group(1).lower(); self.tablevars.add(nm)
                    self.run_sql('CREATE TEMP TABLE tv_%s %s' % (nm[1:], m.group(2)[5:].strip()), show=False); continue
                m = re.match(r'(@\w+)\s+(?:AS\s+)?([A-Za-z_]+(?:\s*\([^)]*\))?)\s*(?:=\s*(.*))?$', part, re.I | re.S)
                if not m: raise TsqlError('Incorrect syntax near DECLARE.', 102, 15)
                nm = m.group(1).lower(); self.types[nm] = m.group(2).upper()
                self.vars[nm] = self.eval(m.group(3)) if m.group(3) else None
            return
        if W == 'SET':
            m = re.match(r'(@\w+)\s*([-+*/]?=)\s*(.*)$', rest, re.S)
            if m:
                nm = m.group(1).lower()
                if nm not in self.vars: raise TsqlError('Must declare the scalar variable "%s".' % m.group(1), 137)
                op = m.group(2)[0] if m.group(2) != '=' else ''
                self.vars[nm] = self.eval('%s %s (%s)' % (lit(self.vars[nm]), op, m.group(3))) if op else self.eval(m.group(3))
                return
            return   # SET NOCOUNT ON / XACT_ABORT / ANSI_NULLS …
        if W in ('USE', 'GRANT', 'WAITFOR'): return
        if W in ('CREATE', 'ALTER', 'DROP') and re.match(r'(DATABASE|SCHEMA|LOGIN|USER)\b', rest, re.I): return
        if W == 'CREATE' and re.match(r'(OR\s+ALTER\s+)?(PROC|PROCEDURE|FUNCTION|TRIGGER)\b', rest, re.I):
            raise TsqlError('CREATE PROCEDURE / FUNCTION / TRIGGER is not supported by the UIP T-SQL runner (it runs a subset of T-SQL on SQLite).', 50001)
        if W == 'RETURN': raise Return_()
        if W == 'BREAK': raise Break_()
        if W == 'CONTINUE': raise Continue_()
        if W in ('COMMIT', 'ROLLBACK'):
            try: self.db.execute(W)
            except sqlite3.Error: pass
            return
        if W == 'BEGIN' and re.match(r'TRAN', rest, re.I):
            try: self.db.execute('BEGIN')
            except sqlite3.Error: pass
            return
        if W == 'RAISERROR':
            a = _split_top(re.sub(r'^\s*\(|\)\s*$', '', rest.strip()) if rest.strip().startswith('(') else rest)
            msg = self.eval(a[0]); sev = int(self.eval(a[1])) if len(a) > 1 else 16; st = int(self.eval(a[2])) if len(a) > 2 else 1
            raise TsqlError(str(msg), 50000, sev, st)
        if W == 'THROW':
            a = _split_top(rest)
            if len(a) >= 2: raise TsqlError(str(self.eval(a[1])), int(self.eval(a[0])), 16, int(self.eval(a[2])) if len(a) > 2 else 1)
            if self.last_err: raise self.last_err
            raise TsqlError('Incorrect syntax near THROW.', 102, 15)
        if W in ('EXEC', 'EXECUTE'):
            m = re.match(r'(?:sp_executesql\s+)?\(?\s*(N?\'(?:[^\']|\'\')*\')', rest, re.I)
            if m:
                code = self.eval(m.group(1))
                self.run_script(code, self.line); return
            raise TsqlError("Could not find stored procedure '%s'." % rest.split()[0], 2812)
        if W == 'SELECT':
            m = re.match(r'SELECT\s+(@\w+\s*[-+*/]?=.*?)(\bFROM\b.*|\bWHERE\b.*)?$', t, re.I | re.S)
            if m:
                items = _split_top(m.group(1)); names, exprs = [], []
                for it in items:
                    mm = re.match(r'(@\w+)\s*([-+*/]?)=\s*(.*)$', it.strip(), re.S)
                    if not mm: raise TsqlError('A SELECT statement that assigns a value to a variable must not be combined with data-retrieval operations.', 141)
                    nm = mm.group(1).lower()
                    if nm not in self.vars: raise TsqlError('Must declare the scalar variable "%s".' % mm.group(1), 137)
                    names.append(nm); exprs.append(mm.group(3) if not mm.group(2) else '%s %s (%s)' % (lit(self.vars[nm]), mm.group(2), mm.group(3)))
                rows = self.run_sql('SELECT ' + ', '.join(exprs) + ' ' + (m.group(2) or ''), show=False)
                if rows:
                    for nm, v in zip(names, rows[-1]): self.vars[nm] = v
                return
        self.run_sql(t)

    # ---- block structure ----
    def run_script(self, src, first_line=1):
        for line0, body, times in split_batches(strip_comments(src)):
            if first_line != 1: line0 = first_line
            for _ in range(times):
                stmts = split_statements(body, line0)
                try:
                    self.exec_block(*self.parse_seq(stmts, 0, ()))
                except Return_:
                    pass
                except TsqlError as e:
                    self.report(e)

    def report(self, e):
        self.errors += 1
        print('Msg %d, Level %d, State %d, Line %d' % (e.num, e.level, e.state, self.line))
        print(e.msg + '\n')

    def parse_seq(self, stmts, i, stops):
        """-> (nodes, next_index). stops = upper-case statements that end this sequence (END, END TRY …)."""
        nodes = []
        while i < len(stmts):
            t, ln = stmts[i]; U = re.sub(r'\s+', ' ', t.strip().upper())
            if U in stops: return nodes, i
            node, i = self.parse_one(stmts, i)
            nodes.append(node)
        return nodes, i

    def parse_one(self, stmts, i):
        t, ln = stmts[i]; U = re.sub(r'\s+', ' ', t.strip().upper())
        if U == 'BEGIN TRY':
            body, j = self.parse_seq(stmts, i + 1, ('END TRY',)); j += 1
            handler = []
            if j < len(stmts) and re.sub(r'\s+', ' ', stmts[j][0].strip().upper()) == 'BEGIN CATCH':
                handler, j = self.parse_seq(stmts, j + 1, ('END CATCH',)); j += 1
            return ('try', body, handler), j
        if U == 'BEGIN':
            body, j = self.parse_seq(stmts, i + 1, ('END',))
            return ('block', body), j + 1
        m = re.match(r'(IF|WHILE)\b\s*(.*)$', t.strip(), re.I | re.S)
        if m:
            kind = m.group(1).upper(); cnd = m.group(2)
            body, j = self.parse_one(stmts, i + 1) if i + 1 < len(stmts) else (('block', []), i + 1)
            if kind == 'IF':
                els = None
                if j < len(stmts) and stmts[j][0].strip().upper() == 'ELSE':
                    els, j = self.parse_one(stmts, j + 1)
                return ('if', cnd, body, els, ln), j
            return ('while', cnd, body, ln), j
        return ('stmt', t, ln), i + 1

    def exec_block(self, nodes, _i=0):
        for n in nodes:
            try:
                self.exec_node(n)
            except TsqlError as e:
                # like SQL Server: a runtime error ends that statement only — the batch goes on (a syntax error ends the batch)
                if self.try_depth or e.num == 102: raise
                self.report(e)

    def exec_node(self, n):
        k = n[0]
        if k == 'stmt': self.exec_one(n[1], n[2])
        elif k == 'block': self.exec_block(n[1])
        elif k == 'if':
            self.line = n[4]
            if self.cond(n[1]): self.exec_node(n[2])
            elif n[3] is not None: self.exec_node(n[3])
        elif k == 'while':
            self.line = n[3]; guard = 0
            while self.cond(n[1]):
                guard += 1
                if guard > 1000000: raise TsqlError('WHILE loop stopped after 1,000,000 iterations (possible infinite loop).', 50002)
                try: self.exec_node(n[2])
                except Break_: break
                except Continue_: continue
        elif k == 'try':
            self.try_depth += 1
            try: self.exec_block(n[1])
            except TsqlError as e:
                self.try_depth -= 1
                self.last_err = e
                try: self.exec_block(n[2])
                finally: self.last_err = None
            else:
                self.try_depth -= 1

# ───────────────────────── small utilities ─────────────────────────
def _ok(f, *a):
    try: f(*a); return True
    except Exception: return False

def _fmt(v):
    if isinstance(v, float):
        return ('%.6f' % v).rstrip('0').rstrip('.') if v != int(v) or abs(v) < 1e15 else repr(v)
    return str(v)

def _format(v, f):
    try:
        if isinstance(v, (int, float)):
            f = str(f)
            m = re.fullmatch(r'[nNfF](\d*)', f)
            if m: return ('{:,.%df}' % int(m.group(1) or 2)).format(v)
            if f.lower() == 'c': return '${:,.2f}'.format(v)
        x = v if isinstance(v, dt.datetime) else dt.datetime.strptime(str(v)[:19].replace('T', ' '), '%Y-%m-%d %H:%M:%S' if len(str(v)) > 10 else '%Y-%m-%d')
        f = str(f)
        for a, b in (('yyyy', '%Y'), ('MM', '%m'), ('dd', '%d'), ('HH', '%H'), ('mm', '%M'), ('ss', '%S')): f = f.replace(a, b)
        return x.strftime(f)
    except Exception:
        return str(v)

def _outside_strings(s, fn):
    parts = re.split(r"('(?:[^']|'')*')", s)
    return ''.join(p if i % 2 else fn(p) for i, p in enumerate(parts))

def _split_top(s):
    out, cur, d, i = [], [], 0, 0
    while i < len(s):
        c = s[i]
        if c == "'":
            j = i + 1
            while j < len(s):
                if s[j] == "'":
                    if j + 1 < len(s) and s[j + 1] == "'": j += 2; continue
                    break
                j += 1
            cur.append(s[i:j + 1]); i = j + 1; continue
        if c == '(': d += 1
        elif c == ')': d -= 1
        if c == ',' and d == 0: out.append(''.join(cur)); cur = []
        else: cur.append(c)
        i += 1
    out.append(''.join(cur))
    return [x.strip() for x in out if x.strip()]

def main():
    if len(sys.argv) < 2: print('usage: tsql.py file.tsql'); return 2
    with open(sys.argv[1], encoding='utf-8-sig', errors='replace') as f: src = f.read()
    sess = Session()
    sys.stdout.reconfigure(line_buffering=True)
    sess.run_script(src)
    return 1 if sess.errors else 0

if __name__ == '__main__':
    sys.exit(main())
