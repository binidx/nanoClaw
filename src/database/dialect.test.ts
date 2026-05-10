import { describe, expect, it } from 'vitest';

import { buildLikeContainsSql, likeEscapeSql } from './dialect.js';

describe('SQL LIKE dialect helpers', () => {
  it('uses a doubled backslash escape literal for mysql', () => {
    expect(likeEscapeSql('mysql')).toBe("ESCAPE '\\\\'");
    expect(buildLikeContainsSql('mysql', 'username')).toBe(
      "username LIKE ? ESCAPE '\\\\'",
    );
  });

  it('uses a single backslash escape literal for sqlite and postgres', () => {
    expect(likeEscapeSql('sqlite')).toBe("ESCAPE '\\'");
    expect(likeEscapeSql('postgres')).toBe("ESCAPE '\\'");
    expect(buildLikeContainsSql('sqlite', 'display_name')).toBe(
      "display_name LIKE ? ESCAPE '\\'",
    );
    expect(buildLikeContainsSql('postgres', 'meta.name')).toBe(
      "meta.name LIKE ? ESCAPE '\\'",
    );
  });
});
