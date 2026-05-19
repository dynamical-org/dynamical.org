// Generic scroll-spy TOC for markdown-rendered HTML.
//
// Given HTML already produced by a markdown renderer, annotateHeadings()
// adds id="…" to every <h2> and <h3> and returns the heading list in
// document order. buildTocHtml() turns that list into a nested <ul>
// with H3s grouped under their preceding H2. CSS + JS provide the
// visual + interaction layer: nested children collapse until their
// parent H2 is the active section, and a ▸ indicator marks the heading
// currently in view as the page scrolls.
//
// Page templates that consume this module are expected to:
//   - put the rendered article body inside an element with class
//     `md-toc-content`
//   - put the TOC inside an element with class `md-toc`
//
// Both selectors are baked into the JS so multiple instances on a
// single page Just Work and the public API stays minimal.

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function plainText(htmlFragment) {
  return htmlFragment.replace(/<[^>]+>/g, "").trim();
}

// Annotate every <h2> and <h3> in `html` with an id derived from its
// plain-text content. Returns the updated html and a flat list of
// { level, slug, title } in document order.
function annotateHeadings(html) {
  const headings = [];
  const out = html.replace(/<(h2|h3)>([\s\S]*?)<\/\1>/g, (_full, tag, inner) => {
    const title = plainText(inner);
    const slug = slugify(title);
    headings.push({ level: tag === "h2" ? 2 : 3, slug, title });
    return `<${tag} id="${slug}">${inner}</${tag}>`;
  });
  return { html: out, headings };
}

// Build the nested TOC. H3s are grouped under the most recent preceding
// H2. H3s that appear before any H2 are emitted at the top level so
// nothing silently disappears.
function buildTocHtml(headings) {
  let html = `<ul class="toc-tree">`;
  let openH2 = false;
  let openH3List = false;

  const closeH2 = () => {
    if (openH3List) {
      html += `</ul>`;
      openH3List = false;
    }
    if (openH2) {
      html += `</li>`;
      openH2 = false;
    }
  };

  for (const h of headings) {
    if (h.level === 2) {
      closeH2();
      html += `<li class="toc-h2"><a href="#${h.slug}">${h.title}</a>`;
      openH2 = true;
    } else if (h.level === 3) {
      if (!openH2) {
        // Stray H3 before any H2 — emit at top level.
        html += `<li class="toc-h3"><a href="#${h.slug}">${h.title}</a></li>`;
        continue;
      }
      if (!openH3List) {
        html += `<ul>`;
        openH3List = true;
      }
      html += `<li class="toc-h3"><a href="#${h.slug}">${h.title}</a></li>`;
    }
  }
  closeH2();
  html += `</ul>`;
  return html;
}

// Styles for both the toc tree itself and the rail that floats it into
// the left margin of the content. Consumer just needs to give the body
// the class `md-toc-content` and drop a `<div class="md-toc-rail">
// <nav class="md-toc">…</nav></div>` inside it.
const CSS = `
.md-toc-content { position: relative; }

.md-toc-rail {
  position: absolute;
  top: 0;
  right: calc(100% + 4rem);
  width: 22rem;
  height: 100%;
}
.md-toc {
  position: sticky;
  top: 2rem;
  font-size: 1.2rem;
  max-height: calc(100vh - 4rem);
  overflow-y: auto;
  padding-right: 2rem;
  /* Fainter than --border-muted-color so the rail reads as a quiet
     divider rather than a hard rule against the article body. */
  border-right: 1px solid var(--popup-border);
}

.md-toc .toc-tree,
.md-toc .toc-tree ul {
  display: block;
  list-style: none;
  padding: 0;
  margin: 0;
}
.md-toc .toc-h2,
.md-toc .toc-h3 {
  display: list-item;
  margin: 0.2rem 0;
  /* Override 'nav ul li:first-child' font-weight:700 leaking from site CSS. */
  font-weight: inherit;
}
.md-toc .toc-h3 { padding-left: 1em; }

.md-toc .toc-h2 > ul { display: none; }
.md-toc .toc-h2.expanded > ul { display: block; }

/* Reserve 1.2em on the left of every link for the ▸ indicator so
   toggling .active doesn't reflow neighbours. The indicator lives
   inside the link's box because the TOC is a scroll container
   (overflow-y: auto), which clips horizontal overflow in most browsers.
   Long headings ellipsis-truncate. */
.md-toc a {
  position: relative;
  display: block;
  padding-left: 1.2em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.md-toc a::before {
  content: "▸";
  position: absolute;
  left: 0;
  opacity: 0;
  transition: opacity 120ms;
}
.md-toc a.active::before { opacity: 1; }

/* Narrow viewports: rail collapses out of the left margin and renders
   in document flow. No indicator, no nested H3s — the TOC is just a
   flat list of section links, and once scrolled past it's off-screen
   so scroll-spy is useless. */
@media (max-width: 1180px) {
  .md-toc-rail {
    position: static;
    width: auto;
    height: auto;
    margin: 0 0 2.4rem;
  }
  .md-toc {
    position: static;
    max-height: none;
    overflow: visible;
    padding: 0;
    border-right: none;
  }
  .md-toc a { padding-left: 0; }
  .md-toc a::before { display: none; }
  .md-toc .toc-h3 { display: none; }
  .md-toc .toc-h2 > ul { display: none; }
}
`;

// Scroll-spy. Tracks which headings inside `.md-toc-content` have
// crossed the top-30% "active line" and marks the deepest such heading
// active. If the active heading is an H3, its containing H2's TOC <li>
// also gets `expanded` so the children list stays visible.
const JS = String.raw`
(function () {
  var content = document.querySelector('.md-toc-content');
  var toc = document.querySelector('.md-toc');
  if (!content || !toc) return;

  var headings = [].slice.call(content.querySelectorAll('h2[id], h3[id]'));
  if (!headings.length) return;

  var entriesById = {};
  toc.querySelectorAll('a[href^="#"]').forEach(function (a) {
    var id = a.getAttribute('href').slice(1);
    var li = a.closest('li');
    entriesById[id] = {
      link: a,
      li: li,
      parentH2Li: li.closest('.toc-h2'),
    };
  });

  var passed = {};

  function update() {
    var activeId = null;
    for (var i = 0; i < headings.length; i++) {
      if (passed[headings[i].id]) activeId = headings[i].id;
    }
    if (!activeId) activeId = headings[0].id;

    for (var id in entriesById) {
      entriesById[id].link.classList.remove('active');
      if (entriesById[id].parentH2Li) {
        entriesById[id].parentH2Li.classList.remove('expanded');
      }
    }

    var active = entriesById[activeId];
    if (!active) return;
    active.link.classList.add('active');
    if (active.parentH2Li) active.parentH2Li.classList.add('expanded');
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        passed[e.target.id] = true;
      } else if (e.boundingClientRect.top < 0) {
        passed[e.target.id] = true;
      } else {
        delete passed[e.target.id];
      }
    });
    update();
  }, { rootMargin: '0px 0px -70% 0px', threshold: 0 });

  headings.forEach(function (h) { io.observe(h); });
  update();
})();
`;

module.exports = { annotateHeadings, buildTocHtml, CSS, JS };
