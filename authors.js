/*
 * Author Profiles page
 * ---------------------------------------------------
 * 1. Loads authors.json and papers.json (made by build_data.py).
 * 2. While you type, shows matching author names. A name matches when every
 *    word you typed is the START of one of its words ("ta" finds "Tanja",
 *    "Tan Li" and "Mary Tate").
 * 3. Clicking a name shows the profile: points, rank, affiliations and all
 *    of that author's papers (title, year, venue, DOI).
 * 4. The page address holds the author (authors.html?name=...), so profile
 *    links from the map popups work and pages can be bookmarked.
 */

const AUTHORS_PATH = "authors.json";
const PAPERS_PATH = "papers.json";
const EXTRA_DATA_PATH = "institution_extra.json"; // only used to know which institutions are on the map

// How many names the drop-down list shows at most.
const MAX_SUGGESTIONS = 15;

const authorInput = document.getElementById("author-input");
const suggestionList = document.getElementById("author-suggestions");
const statusLine = document.getElementById("author-status");
const profileBox = document.getElementById("profile");

let authors = [];                    // every author (from authors.json)
let papers = [];                     // every paper (from papers.json)
let rankedCount = 0;                 // how many authors have points
let mapInstitutions = new Set();     // institutions that have a node on the map
let shownAuthors = [];               // authors currently in the drop-down list
let highlightedIndex = -1;           // which list entry the arrow keys are on

/* ---------- Small helpers ---------- */

/**
 * Lower-cases text and removes accents, so "andre" finds "André".
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Splits text into words (hyphens and dots also separate words).
 */
function splitWords(text) {
  return text.split(/[\s\-.'’]+/).filter(Boolean);
}

/**
 * Creates an element with optional CSS class and text. Using textContent
 * (instead of HTML) means names can never break the page.
 */
function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/* ---------- Searching ---------- */

/**
 * Prepares every author for fast searching.
 */
function prepareSearch() {
  for (const author of authors) {
    author.words = splitWords(normalizeText(author.name));
    author.key = author.words.join(" ");
  }
}

/**
 * Returns the best-matching authors for what is typed: names that START
 * with the text first, then higher points, then alphabetical.
 */
function findAuthors(query) {
  const queryWords = splitWords(normalizeText(query));
  if (queryWords.length === 0) return [];

  const queryText = queryWords.join(" ");
  const startsWithQuery = (author) => (author.key.startsWith(queryText) ? 0 : 1);

  return authors
    .filter((author) => queryWords.every((q) => author.words.some((w) => w.startsWith(q))))
    .sort(
      (a, b) =>
        startsWithQuery(a) - startsWithQuery(b) ||
        (b.points || 0) - (a.points || 0) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, MAX_SUGGESTIONS);
}

/* ---------- Drop-down list ---------- */

function hideSuggestions() {
  suggestionList.hidden = true;
  shownAuthors = [];
  highlightedIndex = -1;
}

/**
 * Marks one list entry as highlighted (used by the arrow keys).
 */
function highlight(index) {
  highlightedIndex = index;
  [...suggestionList.children].forEach((item, i) => {
    item.classList.toggle("highlighted", i === index);
  });
}

/**
 * Draws one list entry: the name, and below it the points and first affiliation.
 */
function buildSuggestion(author) {
  const item = createElement("li");
  item.append(createElement("div", "", author.name));

  const details = [];
  if (author.points !== undefined) details.push(`${author.points} points · rank ${author.rank}`);
  if (author.affiliations.length > 0) details.push(author.affiliations[0]);
  if (details.length > 0) item.append(createElement("div", "meta", details.join(" · ")));

  item.addEventListener("click", () => showProfile(author));
  return item;
}

/**
 * Redraws the drop-down list for what is typed right now.
 */
function renderSuggestions() {
  shownAuthors = findAuthors(authorInput.value);
  suggestionList.innerHTML = "";
  highlightedIndex = -1;

  if (shownAuthors.length === 0) {
    suggestionList.hidden = true;
    return;
  }
  shownAuthors.forEach((author) => suggestionList.append(buildSuggestion(author)));
  suggestionList.hidden = false;
}

/**
 * Arrow keys move through the list, Enter opens the highlighted (or first) name.
 */
function handleKeys(event) {
  if (shownAuthors.length === 0) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlight(Math.min(highlightedIndex + 1, shownAuthors.length - 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlight(Math.max(highlightedIndex - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    showProfile(shownAuthors[Math.max(highlightedIndex, 0)]);
  } else if (event.key === "Escape") {
    hideSuggestions();
  }
}

/* ---------- Profile ---------- */

/**
 * One box with a big value and a small label, e.g. "96" / "points".
 */
function buildStat(value, label) {
  const stat = createElement("div", "stat");
  stat.append(createElement("div", "value", value), createElement("div", "label", label));
  return stat;
}

/**
 * The row of boxes at the top: points, rank, number of papers.
 */
function buildStats(author) {
  const stats = createElement("div", "stats");
  const ranked = author.points !== undefined;

  stats.append(
    buildStat(ranked ? author.points : "–", "points"),
    buildStat(ranked ? `#${author.rank} of ${rankedCount}` : "not ranked", "rank among all authors"),
    buildStat(author.papers.length, author.papers.length === 1 ? "paper" : "papers")
  );
  return stats;
}

/**
 * The affiliation chips. Institutions that are on the map link to it.
 */
function buildAffiliations(author) {
  const section = createElement("div");
  section.append(createElement("h3", "", "Affiliations"));

  if (author.affiliations.length === 0) {
    section.append(createElement("p", "profile-note", "No affiliation data for this author."));
    return section;
  }

  const chips = createElement("ul", "chips");
  for (const institution of author.affiliations) {
    const item = createElement("li");
    if (mapInstitutions.has(institution)) {
      const link = createElement("a", "chip", institution);
      link.href = `index.html?institution=${encodeURIComponent(institution)}`;
      link.title = "Show on the map";
      item.append(link);
    } else {
      item.append(createElement("span", "chip", institution));
    }
    chips.append(item);
  }
  section.append(chips);
  return section;
}

/**
 * One paper: title, then year · venue · DOI.
 */
function buildPaper(paper) {
  const item = createElement("li");
  item.append(createElement("div", "paper-title", paper.title));

  const meta = createElement("div", "paper-meta", `${paper.year} · ${paper.venue}`);
  if (paper.doi) {
    const link = createElement("a", "", `doi:${paper.doi}`);
    link.href = `https://doi.org/${encodeURI(paper.doi)}`;
    link.target = "_blank";
    link.rel = "noopener";
    meta.append(" · ", link);
  }
  item.append(meta);
  return item;
}

/**
 * The list of all the author's papers, newest first.
 */
function buildPaperList(author) {
  const section = createElement("div");
  section.append(createElement("h3", "", `Papers (${author.papers.length})`));

  const list = createElement("ul");
  list.id = "paper-list";
  author.papers
    .map((index) => papers[index])
    .sort((a, b) => b.year - a.year || a.title.localeCompare(b.title))
    .forEach((paper) => list.append(buildPaper(paper)));

  section.append(list);
  return section;
}

/**
 * Shows the whole profile of one author.
 */
function showProfile(author) {
  hideSuggestions();
  authorInput.value = author.name;
  window.history.replaceState(null, "", `?name=${encodeURIComponent(author.name)}`);

  profileBox.innerHTML = "";
  profileBox.append(createElement("h2", "", author.name), buildStats(author));

  if (author.points !== undefined) {
    profileBox.append(
      createElement(
        "p",
        "profile-note",
        `Authorship: ${author.first} first, ${author.middle} middle, ${author.last} last.`
      )
    );
  }
  if (author.uncertain) {
    profileBox.append(
      createElement(
        "p",
        "profile-note",
        "Several people share this name in the affiliation data, so the affiliations below may be mixed up."
      )
    );
  }

  profileBox.append(buildAffiliations(author), buildPaperList(author));
  profileBox.hidden = false;
}

/* ---------- Loading ---------- */

/**
 * Loads a JSON file.
 */
function fetchJson(path) {
  return fetch(path).then((response) => {
    if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
    return response.json();
  });
}

/**
 * Opens the author named in the page address (?name=...), if there is one.
 */
function openAuthorFromUrl() {
  const name = new URLSearchParams(window.location.search).get("name");
  if (!name) return;

  const author = authors.find((a) => a.name === name);
  if (author) showProfile(author);
  else statusLine.textContent = `No author called "${name}" was found.`;
}

function loadData() {
  // The map file is optional: without it the affiliations are just not clickable.
  const mapData = fetchJson(EXTRA_DATA_PATH).catch(() => ({ institutions: {} }));

  Promise.all([fetchJson(AUTHORS_PATH), fetchJson(PAPERS_PATH), mapData])
    .then(([authorData, paperData, extraData]) => {
      authors = authorData.authors;
      rankedCount = authorData.rankedCount;
      papers = paperData;
      mapInstitutions = new Set(Object.keys(extraData.institutions));

      prepareSearch();
      authorInput.disabled = false;
      authorInput.focus();
      statusLine.textContent = `${authors.length} authors available.`;
      openAuthorFromUrl();
    })
    .catch((err) => {
      console.error(err);
      statusLine.textContent = err.message;
    });
}

authorInput.addEventListener("input", renderSuggestions);
authorInput.addEventListener("keydown", handleKeys);
authorInput.addEventListener("focus", () => {
  if (authorInput.value.trim() !== "") renderSuggestions();
});

// Clicking anywhere outside the search box closes the drop-down list.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-wrap")) hideSuggestions();
});

loadData();
