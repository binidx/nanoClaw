import { dba } from './engine-access.js';
import type {
  CodeSearchIndexRecord,
  CodeSearchIndexFileRecord,
  CodeSearchIndexSymbolRecord,
  CodeSearchIndexTermRecord,
  CodeSearchSnapshotRecord,
  CodeSearchSnapshotUpsertInput,
} from './review.js';

export async function getCodeSearchIndexRecord(
  cacheKey: string,
): Promise<CodeSearchIndexRecord | undefined> {
  return await dba
    .prepare(`SELECT * FROM code_search_indexes WHERE cache_key = ? LIMIT 1`)
    .get(cacheKey) as CodeSearchIndexRecord | undefined;
}

export async function getCodeSearchSnapshot(
  cacheKey: string,
): Promise<CodeSearchSnapshotRecord | undefined> {
  const index = await getCodeSearchIndexRecord(cacheKey);
  if (!index) return undefined;
  return {
    index,
    files: await dba
      .prepare(
        `SELECT * FROM code_search_index_files
         WHERE cache_key = ?
         ORDER BY relative_path ASC`,
      )
      .all(cacheKey) as CodeSearchIndexFileRecord[],
    symbols: await dba
      .prepare(
        `SELECT * FROM code_search_index_symbols
         WHERE cache_key = ?
         ORDER BY relative_path ASC, ordinal ASC`,
      )
      .all(cacheKey) as CodeSearchIndexSymbolRecord[],
    terms: await dba
      .prepare(
        `SELECT * FROM code_search_index_terms
         WHERE cache_key = ?
         ORDER BY relative_path ASC, ordinal ASC`,
      )
      .all(cacheKey) as CodeSearchIndexTermRecord[],
  };
}

export async function saveCodeSearchSnapshot(
  input: CodeSearchSnapshotUpsertInput,
): Promise<CodeSearchIndexRecord> {
  const now = new Date().toISOString();
  const existing = await getCodeSearchIndexRecord(input.cache_key);
  const insertFile = dba.prepare(
    `INSERT INTO code_search_index_files (
      cache_key, relative_path, absolute_path, extension, language,
      byte_size, line_count, imports_json, previews_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSymbol = dba.prepare(
    `INSERT INTO code_search_index_symbols (
      cache_key, relative_path, ordinal, name, kind, line, column_number, signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTerm = dba.prepare(
    `INSERT INTO code_search_index_terms (
      cache_key, relative_path, ordinal, term
    ) VALUES (?, ?, ?, ?)`,
  );

  const save = dba.transaction(() => {
    dba
      .prepare(
        `INSERT OR REPLACE INTO code_search_indexes (
        cache_key, root_directory, manifest_hash, build_options_json,
        generated_at, file_count, symbol_count, term_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.cache_key,
        input.root_directory,
        input.manifest_hash,
        input.build_options_json,
        input.generated_at,
        input.file_count,
        input.symbol_count,
        input.term_count,
        existing?.created_at || now,
        now,
      );

    dba
      .prepare(`DELETE FROM code_search_index_terms WHERE cache_key = ?`)
      .run(input.cache_key);
    dba
      .prepare(`DELETE FROM code_search_index_symbols WHERE cache_key = ?`)
      .run(input.cache_key);
    dba
      .prepare(`DELETE FROM code_search_index_files WHERE cache_key = ?`)
      .run(input.cache_key);

    for (const file of input.files) {
      insertFile.run(
        input.cache_key,
        file.relative_path,
        file.absolute_path,
        file.extension,
        file.language,
        file.byte_size,
        file.line_count,
        file.imports_json || '[]',
        file.previews_json || '[]',
      );
      file.symbols.forEach((symbol, ordinal) => {
        insertSymbol.run(
          input.cache_key,
          file.relative_path,
          ordinal,
          symbol.name,
          symbol.kind,
          symbol.line,
          symbol.column_number,
          symbol.signature,
        );
      });
      file.terms.forEach((term, ordinal) => {
        insertTerm.run(input.cache_key, file.relative_path, ordinal, term);
      });
    }
  });

  save();
  return (await getCodeSearchIndexRecord(input.cache_key))!;
}

export async function deleteCodeSearchSnapshot(cacheKey: string): Promise<void> {
  dba.transaction(() => {
    dba
      .prepare(`DELETE FROM code_search_index_terms WHERE cache_key = ?`)
      .run(cacheKey);
    dba
      .prepare(`DELETE FROM code_search_index_symbols WHERE cache_key = ?`)
      .run(cacheKey);
    dba
      .prepare(`DELETE FROM code_search_index_files WHERE cache_key = ?`)
      .run(cacheKey);
    dba
      .prepare(`DELETE FROM code_search_indexes WHERE cache_key = ?`)
      .run(cacheKey);
  })();
}
