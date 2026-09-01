import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

function extractTopLevelFunction(name) {
  const start = appSource.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist.`);
  const next = appSource.indexOf('\n  function ', start + 1);
  return appSource.slice(start, next === -1 ? appSource.length : next);
}

const helperNames = [
  'escapeHTML',
  'escapeAttr',
  'externalLinkUrl',
  'renderPublicationExternalLink',
  'publicationYear',
  'comparePublicationYears',
  'publicationYearGroups',
  'publicationYears',
  'filterPublicationItems',
  'renderPublicationYearFilters',
  'publicationYearHeadingId',
  'patentDisplayNumber',
];
const helpers = new Function(
  `${helperNames.map(extractTopLevelFunction).join('\n')}\nreturn { ${helperNames.join(', ')} };`,
)();

const fixtures = [
  { id: '2025-A', number: 1, year: '2025', title: 'Surface study', authors: 'Jane Kim', journal: 'Electrochemistry', note: '', link_url: '' },
  { id: '2027-B', number: 2, year: '2027', title: 'Lithium interface', authors: 'Min Lee', journal: 'Energy', note: '', link_url: 'https://example.com/paper' },
  { id: '2025-C', number: 3, year: '2025', title: 'Operando analysis', authors: 'Jin Park', journal: 'Advanced Materials', note: '', link_url: '' },
  { id: '2027-D', number: 4, year: '2027', title: 'Phase dynamics', authors: 'Jane Kim', journal: 'Chemistry', note: '', link_url: '' },
  { id: 'unknown', number: 5, year: '   ', title: 'Accepted manuscript', authors: 'Team', journal: 'In press', note: '', link_url: '' },
];
const originalSnapshot = JSON.stringify(fixtures);

const groups = helpers.publicationYearGroups(fixtures);
assert.deepEqual(groups.map((group) => group.year), ['2027', '2025', 'Unspecified']);
assert.deepEqual(groups[0].items.map((item) => item.id), ['2027-B', '2027-D']);
assert.deepEqual(groups[1].items.map((item) => item.id), ['2025-A', '2025-C']);
assert.equal(JSON.stringify(fixtures), originalSnapshot, 'Grouping must not mutate the CMS data order.');

assert.deepEqual(
  helpers.publicationYears([{ year: '2024' }, { year: '2032' }, { year: '2024' }, { year: '2029' }]),
  ['2032', '2029', '2024'],
  'A newly added year must automatically become the first filter and section.',
);
assert.equal(helpers.publicationYear(null), 'Unspecified');
assert.equal(helpers.publicationYear(' 2028 '), '2028');
assert.deepEqual(helpers.publicationYearGroups(null), []);

assert.deepEqual(
  helpers.filterPublicationItems(fixtures, 'all', ' lithium ').map((item) => item.id),
  ['2027-B'],
  'All years plus search must search the complete active tab.',
);
assert.deepEqual(
  helpers.filterPublicationItems(fixtures, '2027', 'jane').map((item) => item.id),
  ['2027-D'],
  'A selected year and search term must be combined as an intersection.',
);
assert.deepEqual(
  helpers.filterPublicationItems(fixtures, '2025', '').map((item) => item.id),
  ['2025-A', '2025-C'],
  'An empty search must return every item from the selected year in source order.',
);
assert.deepEqual(helpers.filterPublicationItems(fixtures, '2024', 'missing'), []);

const patentFixtures = [
  { year: '2026', title: 'Electrode patent', inventors: 'Alpha Inventor', number: 'KR-100', link_url: 'https://example.com/patent' },
  { year: '2025', title: 'Foam structure', inventors: 'Beta Inventor', number: 'US-200', link_url: '' },
];
assert.equal(helpers.patentDisplayNumber(patentFixtures[1], patentFixtures), 1);
assert.equal(
  helpers.patentDisplayNumber(helpers.filterPublicationItems(patentFixtures, '2025', '')[0], patentFixtures),
  1,
  'A patent badge number must remain based on the original data order after filtering.',
);
assert.equal(helpers.patentDisplayNumber({ year: '2025' }, patentFixtures), '');
assert.deepEqual(
  helpers.filterPublicationItems(patentFixtures, '2025', 'us-200').map((item) => item.number),
  ['US-200'],
  'Patent numbers and other patent fields must use the same case-insensitive search.',
);

const rendererFactory = new Function(
  'data',
  'publicationYearGroups',
  'publicationYearHeadingId',
  'patentDisplayNumber',
  'renderPublicationExternalLink',
  'escapeAttr',
  'escapeHTML',
  'publicationYear',
  `${extractTopLevelFunction('renderPaperList')}\n${extractTopLevelFunction('renderPatentList')}\nreturn { renderPaperList, renderPatentList };`,
);
const renderers = rendererFactory(
  { patents: patentFixtures },
  helpers.publicationYearGroups,
  helpers.publicationYearHeadingId,
  helpers.patentDisplayNumber,
  helpers.renderPublicationExternalLink,
  helpers.escapeAttr,
  helpers.escapeHTML,
  helpers.publicationYear,
);

function renderedSections(html) {
  return [...html.matchAll(/<section class="publication-year-section"[^>]*>([\s\S]*?)<\/section>/g)]
    .map((match) => {
      const content = match[1];
      return {
        year: content.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1],
        countLabel: content.match(/<div class="publication-year-heading">[\s\S]*?<span>([^<]+)<\/span>/)?.[1],
        cardCount: (content.match(/class="publication-card(?:\s|")/g) || []).length,
        badges: [...content.matchAll(/class="year-badge"><small>[^<]*<\/small>([^<]*)<\/div>/g)].map((item) => item[1]),
        titles: [...content.matchAll(/class="publication-card-content">[\s\S]*?<h3>([^<]*)<\/h3>/g)].map((item) => item[1]),
      };
    });
}

const renderedPapers = renderers.renderPaperList(fixtures);
const paperSections = renderedSections(renderedPapers);
assert.deepEqual(paperSections.map((section) => section.year), ['2027', '2025', 'Unspecified']);
assert.deepEqual(paperSections[0].titles, ['Lithium interface', 'Phase dynamics']);
assert.deepEqual(paperSections[1].titles, ['Surface study', 'Operando analysis']);
paperSections.forEach((section) => {
  assert.equal(section.cardCount, Number(section.countLabel.split(' ')[0]), `${section.year} heading count must match its cards.`);
  assert.ok(section.badges.every((year) => year === section.year), `${section.year} cards must stay in the matching year section.`);
});
assert.match(renderedPapers, /href="https:\/\/example\.com\/paper" target="_blank" rel="noopener noreferrer"/);

const renderedPatents = renderers.renderPatentList(patentFixtures);
const patentSections = renderedSections(renderedPatents);
assert.deepEqual(patentSections.map((section) => section.year), ['2026', '2025']);
assert.deepEqual(patentSections.map((section) => section.cardCount), [1, 1]);
assert.match(renderedPatents, /href="https:\/\/example\.com\/patent" target="_blank" rel="noopener noreferrer"/);
const filteredPatentHtml = renderers.renderPatentList([patentFixtures[1]]);
assert.match(filteredPatentHtml, /class="year-badge"><small>#1<\/small>2025<\/div>/);
assert.equal((renderers.renderPaperList([]).match(/class="empty-state"/g) || []).length, 1);
assert.doesNotMatch(renderers.renderPaperList([]), /publication-year-section/);

const filterHtml = helpers.renderPublicationYearFilters(fixtures, '2025');
assert.equal((filterHtml.match(/data-publication-year=/g) || []).length, 4);
assert.match(filterHtml, /data-publication-year="all" aria-pressed="false">All<\/button>/);
assert.match(filterHtml, /data-publication-year="2027" aria-pressed="false">2027<\/button>/);
assert.match(filterHtml, /data-publication-year="2025" aria-pressed="true">2025<\/button>/);
assert.match(filterHtml, /data-publication-year="Unspecified" aria-pressed="false">Unspecified<\/button>/);
const escapedFilterHtml = helpers.renderPublicationYearFilters([{ year: '<script>alert(1)</script>' }]);
assert.doesNotMatch(escapedFilterHtml, /<script>/i);

const filterPosition = appSource.indexOf('data-publication-year-filters');
const searchPosition = appSource.indexOf('data-publication-search');
const bodyPosition = appSource.indexOf('data-publication-body');
assert.ok(filterPosition > -1 && filterPosition < searchPosition && searchPosition < bodyPosition,
  'The DOM order must be year filter, search, then grouped results.');
assert.match(appSource, /class="publication-year-filters" role="group"[^>]*data-publication-year-filters/);
assert.match(appSource, /class="publication-year-section" aria-labelledby=/);
assert.match(appSource, /class="publication-year-heading"[\s\S]*?<h2 id=/);
assert.match(appSource, /function renderPatentList\(list = data\.patents \|\| \[\]\)/);
assert.match(appSource, /filterPublicationItems\(activeItems\(\), state\[active\]\.year, state\[active\]\.query\)/);
assert.match(appSource, /body\.innerHTML = active === 'patents' \? renderPatentList\(filtered\) : renderPaperList\(filtered\)/);
assert.match(appSource, /papers: \{ year: 'all', query: '' \}[\s\S]*?patents: \{ year: 'all', query: '' \}/);
assert.match(appSource, /yearFilters\.innerHTML = renderPublicationYearFilters\(items, state\[active\]\.year\)/);
assert.doesNotMatch(appSource, /controls\.hidden = active !== 'papers'/);
assert.match(appSource, /Search title, inventor, patent number/);
assert.match(appSource, /renderPublicationExternalLink\(pub, '논문'\)/);
assert.match(appSource, /renderPublicationExternalLink\(patent, '특허'\)/);

assert.match(
  stylesSource,
  /\.publication-year-filter\s*\{[^}]*min-height:\s*44px[^}]*white-space:\s*nowrap/s,
  'Year filters must retain an accessible touch size without clipped labels.',
);
assert.match(stylesSource, /\.publication-year-filter\[aria-pressed="true"\]\s*\{/);
assert.match(stylesSource, /\.publication-year-heading h2\s*\{/);
assert.match(
  stylesSource,
  /@media \(max-width: 620px\)[\s\S]*?\.publication-year-filters\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s,
  'Mobile year filters must own their horizontal overflow.',
);

console.log('Publication year grouping, dynamic filters, and combined search contract passed.');
