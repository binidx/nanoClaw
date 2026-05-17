import { describe, expect, it } from 'vitest';

import {
  detectFileType,
  extractFromXLSX,
  isSupportedFile,
} from './file-extractors.js';

describe('knowledge file extractors', () => {
  it('extracts text from xlsx workbooks without the vulnerable xlsx package', async () => {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const first = workbook.addWorksheet('Summary');
    first.addRow(['Name', 'Score']);
    first.addRow(['Alice', 42]);
    const second = workbook.addWorksheet('Notes');
    second.addRow(['Hello, world']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(extractFromXLSX(buffer)).resolves.toContain('## Summary');
    await expect(extractFromXLSX(buffer)).resolves.toContain('Name,Score');
    await expect(extractFromXLSX(buffer)).resolves.toContain('Alice,42');
    await expect(extractFromXLSX(buffer)).resolves.toContain('## Notes');
  });

  it('accepts .xlsx files and rejects legacy .xls uploads', () => {
    expect(detectFileType('report.xlsx')).toBe('xlsx');
    expect(detectFileType('report.xls')).toBe('unknown');
    expect(isSupportedFile('report.xlsx')).toBe(true);
    expect(isSupportedFile('report.xls')).toBe(false);
  });
});
