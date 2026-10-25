import ExcelJS from 'exceljs';
import { ProfileService, profileSchema } from '../profile/profile.service';
import { overlappingPairs } from './report.service';
import { CONTENT_TYPE, ReportData, render, spreadsheetSafe } from './render';

const data = (over: Partial<ReportData> = {}): ReportData => ({
  title: 'Weekly summary',
  subtitle: 'Generated today · covers 7 days',
  sections: [
    { heading: 'Inbox overview', note: 'Last 7 days', bullets: ['12 conversations', '3 marked Urgent'] },
    { heading: 'Conversations', table: { columns: ['Last activity', 'From', 'Subject'], rows: [['1 Nov', 'Dana', 'Invoice 2417'], ['2 Nov', 'Marcus', '=HYPERLINK("http://evil.example","x")']] } },
  ],
  ...over,
});

describe('report files', () => {
  it('builds a real PDF', async () => {
    const f = await render('pdf', data());
    expect(f.subarray(0, 4).toString()).toBe('%PDF');
    expect(f.length).toBeGreaterThan(1000);
  });

  it('builds a real Word document (a zip with the document part)', async () => {
    const f = await render('docx', data());
    expect(f.subarray(0, 2).toString()).toBe('PK');
    expect(f.includes(Buffer.from('word/document.xml'))).toBe(true);
  });

  it('builds a real Excel workbook with a summary sheet and one sheet per table', async () => {
    const f = await render('xlsx', data());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Conversations']);
    expect(wb.getWorksheet('Conversations')!.getRow(1).values).toEqual([undefined, 'Last activity', 'From', 'Subject']);
    expect(wb.getWorksheet('Conversations')!.rowCount).toBe(3);
  });

  it('never lets message text run as a spreadsheet formula', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await render('xlsx', data())) as never);
    const cell = wb.getWorksheet('Conversations')!.getRow(3).getCell(3);
    expect(typeof cell.value).toBe('string');
    expect(String(cell.value).startsWith("'=")).toBe(true);
    expect(cell.formula).toBeUndefined();
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])('neutralises a value that starts with %j', (v) => {
    expect(spreadsheetSafe(v).startsWith("'")).toBe(true);
  });
  it('leaves ordinary text alone', () => expect(spreadsheetSafe('Invoice 2417')).toBe('Invoice 2417'));

  it('copes with an empty report and with long tables over several pages', async () => {
    expect((await render('pdf', data({ sections: [] }))).subarray(0, 4).toString()).toBe('%PDF');
    const rows = Array.from({ length: 300 }, (_, i) => [`${i}`, 'Sender '.repeat(5), 'Subject '.repeat(12)]);
    const big = await render('pdf', data({ sections: [{ heading: 'Many', table: { columns: ['#', 'From', 'Subject'], rows } }] }));
    expect(big.length).toBeGreaterThan(5000);
    expect((await render('xlsx', data({ sections: [{ heading: 'Many', table: { columns: ['#', 'From', 'Subject'], rows } }] }))).length).toBeGreaterThan(1000);
  });

  it('copes with awkward sheet names (forbidden characters, duplicates, long titles)', async () => {
    const t = { columns: ['A'], rows: [['1']] };
    const f = await render('xlsx', data({ sections: [{ heading: 'Q1/Q2: [plan]?', table: t }, { heading: 'Q1/Q2: [plan]?', table: t }, { heading: 'x'.repeat(60), table: t }] }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f as never);
    const names = wb.worksheets.map((w) => w.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.length <= 31 && !/[\\/?*[\]:]/.test(n))).toBe(true);
  });

  it('has a download type for every format', () => {
    expect(CONTENT_TYPE.pdf).toBe('application/pdf');
    expect(CONTENT_TYPE.docx).toContain('wordprocessingml');
    expect(CONTENT_TYPE.xlsx).toContain('spreadsheetml');
  });
});

describe('calendar clashes in reports', () => {
  const ev = (title: string, s: string, e: string) => ({ title, start_at: s, end_at: e });
  it('finds overlapping events and ignores events that only touch', () => {
    const pairs = overlappingPairs([ev('Call', '2026-11-02T15:00:00Z', '2026-11-02T15:45:00Z'), ev('Dentist', '2026-11-02T15:30:00Z', '2026-11-02T16:30:00Z'), ev('Lunch', '2026-11-02T16:30:00Z', '2026-11-02T17:00:00Z')]);
    expect(pairs).toEqual([['Call', 'Dentist']]);
  });
  it('reports every clash in a chain and handles an empty list', () => {
    expect(overlappingPairs([])).toEqual([]);
    expect(overlappingPairs([ev('A', '2026-11-02T10:00:00Z', '2026-11-02T12:00:00Z'), ev('B', '2026-11-02T10:30:00Z', '2026-11-02T11:00:00Z'), ev('C', '2026-11-02T11:30:00Z', '2026-11-02T12:30:00Z')]).length).toBe(2);
  });
});

describe('profile and preferences', () => {
  it('has careful defaults', () => {
    const p = profileSchema.parse({});
    expect(p).toMatchObject({ tone: 'neutral', language: 'en', timezone: 'UTC', workDays: [1, 2, 3, 4, 5], workStart: 9, workEnd: 17, autoRepliesEnabled: false });
    expect(p.escalationRules).toEqual({ urgentSenders: [], keywords: [], notifyOutsideHours: false });
    expect(p.responsePolicies).toEqual({});
  });

  it.each([
    ['a working day that ends before it starts', { workStart: 17, workEnd: 9 }],
    ['an hour out of range', { workStart: 25 }],
    ['a day of the week out of range', { workDays: [7] }],
    ['a bad language code', { language: 'english please' }],
    ['an unknown time zone', { timezone: 'Mars/Base' }],
    ['an over-long signature', { signature: 'x'.repeat(501) }],
    ['a channel policy for an unknown channel', { responsePolicies: { fax: { allowAuto: true } } }],
    ['too many escalation keywords', { escalationRules: { keywords: Array.from({ length: 51 }, (_, i) => `k${i}`) } }],
  ])('refuses %s', (_n, bad) => expect(profileSchema.safeParse(bad).success).toBe(false));

  it('accepts regional language codes', () => {
    for (const l of ['en', 'pt-BR', 'zh-Hant-TW', 'fil']) expect(profileSchema.safeParse({ language: l }).success).toBe(true);
  });

  describe('working hours', () => {
    const svc = new ProfileService({} as never, {} as never);
    const p = profileSchema.parse({ timezone: 'Asia/Singapore', workDays: [1, 2, 3, 4, 5], workStart: 9, workEnd: 17 });

    it('uses the person\'s time zone, working days and hours', () => {
      expect(svc.inWorkingHours(p, new Date('2026-10-27T02:00:00Z'))).toBe(true); // Tue 10:00 in Singapore
      expect(svc.inWorkingHours(p, new Date('2026-10-27T10:00:00Z'))).toBe(false); // Tue 18:00 in Singapore
      expect(svc.inWorkingHours(p, new Date('2026-10-31T02:00:00Z'))).toBe(false); // Saturday
      expect(svc.inWorkingHours(p, new Date('2026-10-27T01:00:00Z'))).toBe(true); // 09:00 is the first working hour
      expect(svc.inWorkingHours(p, new Date('2026-10-27T09:00:00Z'))).toBe(false); // 17:00 is already after
    });

    it('a full-day profile is always working time on its days', () => {
      const all = profileSchema.parse({ workDays: [0, 1, 2, 3, 4, 5, 6], workStart: 0, workEnd: 24 });
      expect(svc.inWorkingHours(all, new Date('2026-10-25T03:00:00Z'))).toBe(true);
    });
  });
});
