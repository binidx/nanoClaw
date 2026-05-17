import path from 'path';
import { createModuleLogger } from '../logger.js';
import { t } from '../i18n/index.js';

const logger = createModuleLogger('file-extractors');

const BINARY_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.log',
  '.yml', '.yaml', '.xml', '.html', '.htm',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export type FileType = 'pdf' | 'docx' | 'xlsx' | 'image' | 'text' | 'unknown';

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/**
 * Strips directory components and rejects dangerous names.
 * Returns the sanitized basename, or throws if the name is invalid.
 */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(raw).replace(/[\x00-\x1f]/g, '');
  if (!base || base === '.' || base === '..') {
    throw new Error(t('knowledge.invalidFilename', { filename: raw }, undefined));
  }
  return base;
}

/**
 * Normalize a ZIP-internal relative path: convert backslashes, strip leading
 * slashes, reject `..` traversal and absolute paths. Returns null when the
 * input is empty / single-segment (no useful hierarchy).
 */
export function sanitizeRelativePath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\\/g, '/').replace(/[\x00-\x1f]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('/')) return null;
  const segments = cleaned.split('/').filter((s) => s.length > 0);
  if (segments.length <= 1) return null;
  if (segments.some((s) => s === '..' || s === '.')) return null;
  return segments.join('/');
}

export function detectFileType(filename: string): FileType {
  const ext = getExtension(filename);
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unknown';
}

export function isSupportedFile(filename: string): boolean {
  const ext = getExtension(filename);
  return BINARY_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

export function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(filename));
}

export function isBinaryFile(filename: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(filename));
}

export async function extractFromPDF(buffer: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  logger.debug({ bytes: buffer.length, textLen: text.length }, 'PDF text extracted');
  return text;
}

export async function extractFromDOCX(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.default.extractRawText({ buffer });
  logger.debug({ bytes: buffer.length, textLen: result.value.length }, 'DOCX text extracted');
  return result.value;
}

const MAX_XLSX_ROWS = 5000;
const MAX_XLSX_SHEETS = 20;

function stringifySpreadsheetCell(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifySpreadsheetCell(item)).join(', ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          return typeof (part as { text?: unknown }).text === 'string'
            ? ((part as { text: string }).text)
            : '';
        })
        .join('');
    }
    if (typeof record.text === 'string') return record.text;
    if ('result' in record) return stringifySpreadsheetCell(record.result);
    if (typeof record.hyperlink === 'string') return record.hyperlink;
    if (typeof record.formula === 'string') return record.formula;
    if (typeof record.sharedFormula === 'string') return record.sharedFormula;
    if (typeof record.error === 'string') return record.error;
    try {
      return JSON.stringify(record);
    } catch {
      return '';
    }
  }
  return '';
}

function toCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function extractFromXLSX(buffer: Buffer): Promise<string> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheets = workbook.worksheets.slice(0, MAX_XLSX_SHEETS);
  const parts = sheets.map((sheet) => {
    const rows: string[] = [];
    let seenRows = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (seenRows >= MAX_XLSX_ROWS) return;
      seenRows += 1;
      const cells = Array.from({ length: row.cellCount }, (_, index) =>
        toCsvCell(stringifySpreadsheetCell(row.getCell(index + 1).value)),
      );
      if (cells.every((cell) => cell.length === 0)) return;
      rows.push(cells.join(','));
    });
    if (rows.length === 0) return '';
    return `## ${sheet.name}\n${rows.join('\n')}`;
  }).filter(Boolean);
  const text = parts.join('\n\n');
  logger.debug({ bytes: buffer.length, sheets: sheets.length, textLen: text.length }, 'XLSX text extracted');
  return text;
}

export async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const fileType = detectFileType(filename);
  switch (fileType) {
    case 'pdf':
      return extractFromPDF(buffer);
    case 'docx':
      return extractFromDOCX(buffer);
    case 'xlsx':
      return extractFromXLSX(buffer);
    case 'image':
      return t('knowledge.imageFilePlaceholder', { filename }, undefined);
    case 'text':
      return buffer.toString('utf-8');
    default:
      throw new Error(t('knowledge.unsupportedFileFormat', { filename }, undefined));
  }
}
