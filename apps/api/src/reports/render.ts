import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export type ReportFormat = 'pdf' | 'docx' | 'xlsx';

export interface Section {
  heading: string;
  note?: string;
  bullets?: string[];
  table?: { columns: string[]; rows: string[][] };
}
/** Format-neutral content. The renderers only lay it out; they never fetch anything. */
export interface ReportData {
  title: string;
  subtitle: string;
  sections: Section[];
}

export const CONTENT_TYPE: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const INK = '#0f2a40';
const MUTED = '#546a80';
const ACCENT = '#1f7bc4';

/** Excel and many viewers treat a leading = + - @ as a formula. Values from messages must never run as one. */
export const spreadsheetSafe = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function renderPdf(d: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: d.title, Producer: 'Unified Inbox' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 96;
    const room = (h: number) => {
      if (doc.y + h > doc.page.height - 56) doc.addPage();
    };

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(d.title);
    doc.moveDown(0.2).fillColor(MUTED).font('Helvetica').fontSize(10).text(d.subtitle);
    doc.moveDown(1);

    for (const s of d.sections) {
      room(60);
      doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(13).text(s.heading);
      doc.moveDown(0.3);
      if (s.note) doc.fillColor(MUTED).font('Helvetica').fontSize(9.5).text(s.note, { width }).moveDown(0.3);
      for (const b of s.bullets ?? []) {
        room(20);
        doc.fillColor(INK).font('Helvetica').fontSize(10).text(`•  ${b}`, { width, indent: 4 });
      }
      if (s.table) {
        const cols = s.table.columns.length;
        const w = width / cols;
        const row = (cells: string[], bold: boolean) => {
          const h = Math.max(...cells.map((c) => doc.heightOfString(c, { width: w - 8 }))) + 8;
          room(h);
          const y = doc.y;
          if (bold) doc.rect(48, y, width, h).fill('#e3f0fb');
          doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
          cells.forEach((c, i) => doc.text(c, 48 + i * w + 4, y + 4, { width: w - 8, lineBreak: true }));
          doc.y = y + h;
          doc.moveTo(48, doc.y).lineTo(48 + width, doc.y).strokeColor('#d9e8f5').lineWidth(0.5).stroke();
        };
        row(s.table.columns, true);
        for (const r of s.table.rows) row(r, false);
      }
      doc.moveDown(1);
    }
    doc.end();
  });
}

export async function renderDocx(d: ReportData): Promise<Buffer> {
  const cell = (text: string, bold = false) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold, size: 18 })] })], width: { size: 100, type: WidthType.PERCENTAGE } });
  const body: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: d.title })] }),
    new Paragraph({ children: [new TextRun({ text: d.subtitle, color: '546A80', size: 20 })], spacing: { after: 240 } }),
  ];
  for (const s of d.sections) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: s.heading })], spacing: { before: 240, after: 80 } }));
    if (s.note) body.push(new Paragraph({ children: [new TextRun({ text: s.note, color: '546A80', size: 19 })] }));
    for (const b of s.bullets ?? []) body.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: b, size: 21 })] }));
    if (s.table) {
      body.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ tableHeader: true, children: s.table.columns.map((c) => cell(c, true)) }), ...s.table.rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))],
        }),
      );
    }
  }
  const doc = new Document({ creator: 'Unified Inbox', title: d.title, sections: [{ children: body }] });
  return Packer.toBuffer(doc);
}

export async function renderXlsx(d: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Unified Inbox';
  const cover = wb.addWorksheet('Summary');
  cover.columns = [{ width: 100 }];
  cover.addRow([d.title]).font = { bold: true, size: 16 };
  cover.addRow([d.subtitle]).font = { color: { argb: 'FF546A80' } };
  cover.addRow([]);
  const used = new Set<string>(['Summary']);
  for (const s of d.sections) {
    cover.addRow([s.heading]).font = { bold: true, color: { argb: 'FF1F7BC4' } };
    if (s.note) cover.addRow([s.note]);
    for (const b of s.bullets ?? []) cover.addRow([`• ${spreadsheetSafe(b)}`]);
    cover.addRow([]);
    if (s.table) {
      // Sheet names: 31 characters, no \ / ? * [ ] :, unique.
      let name = s.heading.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
      for (let i = 2; used.has(name); i++) name = `${name.slice(0, 28)} ${i}`;
      used.add(name);
      const ws = wb.addWorksheet(name);
      ws.columns = s.table.columns.map((c) => ({ header: c, width: Math.min(60, Math.max(14, c.length + 6)) }));
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F0FB' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      for (const r of s.table.rows) ws.addRow(r.map(spreadsheetSafe));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function render(format: ReportFormat, d: ReportData): Promise<Buffer> {
  return format === 'pdf' ? renderPdf(d) : format === 'docx' ? renderDocx(d) : renderXlsx(d);
}
