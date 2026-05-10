import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { renderMarkdownContent } from './markdown';

describe('renderMarkdownContent', () => {
  it('renders pipe table syntax as an HTML table', () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        renderMarkdownContent('| Name | Role |\n| --- | --- |\n| Ada | Admin |'),
      ),
    );

    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th>Role</th>');
    expect(html).toContain('<td>Ada</td>');
    expect(html).toContain('<td>Admin</td>');
  });

  it('keeps plain pipe-delimited text as a paragraph when no table separator exists', () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        renderMarkdownContent('Name | Role\nAda | Admin'),
      ),
    );

    expect(html).not.toContain('<table');
    expect(html).toContain('<p class="md-paragraph">Name | Role<br/>Ada | Admin</p>');
  });

  it('adds stable heading ids when a heading prefix is provided', () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        renderMarkdownContent('## Core Facts\n\n### Details', { headingIdPrefix: 'wiki' }),
      ),
    );

    expect(html).toContain('id="wiki-0-core-facts"');
    expect(html).toContain('id="wiki-1-details"');
  });
});
