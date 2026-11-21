/*
 * Author Ranking page
 * ---------------------------------------------------
 * Loads authors.json (made by build_data.py), keeps the authors that have
 * points, and lists them from best to worst. Authors with equal points
 * share a rank. Clicking a name opens that author's profile.
 */

const AUTHORS_PATH = "authors.json";

const statusLine = document.getElementById("ranking-status");
const table = document.getElementById("ranking-table");

/**
 * Creates a table cell with optional CSS class and text.
 */
function createCell(text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

/**
 * Creates one table row for an author. The name is a link to the profile page.
 */
function buildRow(author) {
  const row = document.createElement("tr");

  const nameCell = document.createElement("td");
  const link = document.createElement("a");
  link.textContent = author.name;
  link.href = `authors.html?name=${encodeURIComponent(author.name)}`;
  nameCell.append(link);

  row.append(
    createCell(`#${author.rank}`),
    nameCell,
    createCell(author.points, "number"),
    createCell(author.first, "number"),
    createCell(author.middle, "number"),
    createCell(author.last, "number")
  );
  return row;
}

/**
 * Keeps the ranked authors, best first (equal points: alphabetical).
 */
function getRankedAuthors(authors) {
  return authors
    .filter((author) => author.points !== undefined)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

function loadRanking() {
  fetch(AUTHORS_PATH, { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load ${AUTHORS_PATH} (HTTP ${response.status}).`);
      return response.json();
    })
    .then((data) => {
      const ranked = getRankedAuthors(data.authors);
      table.tBodies[0].append(...ranked.map(buildRow));
      table.hidden = false;
      statusLine.textContent = `${ranked.length} ranked authors. Click a name to see the profile.`;
    })
    .catch((err) => {
      console.error(err);
      statusLine.textContent = err.message;
    });
}

loadRanking();
