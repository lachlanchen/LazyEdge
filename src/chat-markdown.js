// Browser-side Markdown is deliberately emitted as a separate same-origin
// module. KaTeX is served from the exact package version installed with
// LazyEdge; nothing is loaded from a CDN.
export const CHAT_MARKDOWN_JS = String.raw`import katex from "/assets/katex.mjs";

const MAX_MARKDOWN_CHARACTERS = 32000;
const MAX_INLINE_DEPTH = 12;
const MAX_BLOCK_DEPTH = 8;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_ROWS = 200;
const MAX_MATH_EXPRESSIONS = 32;
const MAX_TEX_CHARACTERS = 8192;
const MAX_TEX_EXPRESSION_CHARACTERS = 4096;

function node(name, className) {
  const value = document.createElement(name);
  if (className) value.className = className;
  return value;
}

function appendText(parent, value) {
  parent.appendChild(document.createTextNode(value));
}

function escapedAt(value, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function closingDelimiter(value, delimiter, start) {
  let index = start;
  while ((index = value.indexOf(delimiter, index)) !== -1) {
    if (!escapedAt(value, index)) return index;
    index += delimiter.length;
  }
  return -1;
}

function safeHref(value) {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  if (value[0] === "#" && /^#[A-Za-z0-9_.:-]{1,200}$/u.test(value)) return value;
  let parsed;
  try {
    parsed = new URL(value, window.location.href);
  } catch (_) {
    return null;
  }
  if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) return null;
  if ((parsed.protocol === "https:" || parsed.protocol === "http:") && (parsed.username || parsed.password)) {
    return null;
  }
  return parsed.href;
}

function mathNode(source, displayMode, budget) {
  const container = node(displayMode ? "div" : "span", displayMode ? "math-display" : "math-inline");
  const bounded = source.slice(0, MAX_TEX_EXPRESSION_CHARACTERS);
  if (
    source.length > MAX_TEX_EXPRESSION_CHARACTERS
    || budget.mathExpressions >= MAX_MATH_EXPRESSIONS
    || budget.texCharacters + bounded.length > MAX_TEX_CHARACTERS
  ) {
    const fallback = node("code", "math-fallback math-limit");
    fallback.textContent = (displayMode ? "$$" : "$") + source + (displayMode ? "$$" : "$");
    container.replaceChildren(fallback);
    return container;
  }
  budget.mathExpressions += 1;
  budget.texCharacters += bounded.length;
  try {
    katex.render(bounded, container, {
      displayMode,
      output: "mathml",
      trust: false,
      throwOnError: false,
      strict: "error",
      maxExpand: 500,
      maxSize: 10,
      // KaTeX's Namespace implementation calls hasOwnProperty on this object.
      // Keep it empty, but use a normal own object so the pinned browser build
      // can render instead of falling back for every expression.
      macros: {},
    });
  } catch (_) {
    const fallback = node("code", "math-fallback");
    fallback.textContent = (displayMode ? "$$" : "$") + bounded + (displayMode ? "$$" : "$");
    container.replaceChildren(fallback);
  }
  return container;
}

function appendLink(parent, label, rawHref, depth, budget) {
  const href = safeHref(rawHref);
  if (href === null) {
    appendText(parent, "[" + label + "](" + rawHref + ")");
    return;
  }
  const anchor = node("a");
  anchor.href = href;
  anchor.rel = "noopener noreferrer";
  if (/^https?:/u.test(href)) anchor.target = "_blank";
  appendInline(anchor, label, depth + 1, budget);
  parent.appendChild(anchor);
}

function appendInline(parent, source, depth = 0, budget) {
  if (depth > MAX_INLINE_DEPTH) {
    appendText(parent, source);
    return;
  }
  let cursor = 0;
  while (cursor < source.length) {
    const remaining = source.slice(cursor);

    if (remaining.startsWith("\\(") && !escapedAt(source, cursor)) {
      const end = closingDelimiter(source, "\\)", cursor + 2);
      if (end !== -1 && end > cursor + 2) {
        parent.appendChild(mathNode(source.slice(cursor + 2, end), false, budget));
        cursor = end + 2;
        continue;
      }
    }

    if (source[cursor] === "$" && source[cursor + 1] !== "$" && !escapedAt(source, cursor)) {
      const end = closingDelimiter(source, "$", cursor + 1);
      if (
        end > cursor + 1
        && !/\s/u.test(source[cursor + 1])
        && !/\s/u.test(source[end - 1])
      ) {
        parent.appendChild(mathNode(source.slice(cursor + 1, end), false, budget));
        cursor = end + 1;
        continue;
      }
    }

    if (source.charCodeAt(cursor) === 96) {
      let run = 1;
      while (source.charCodeAt(cursor + run) === 96) run += 1;
      const delimiter = String.fromCharCode(96).repeat(run);
      const end = source.indexOf(delimiter, cursor + run);
      if (end !== -1) {
        const code = node("code", "inline-code");
        code.textContent = source.slice(cursor + run, end);
        parent.appendChild(code);
        cursor = end + run;
        continue;
      }
    }

    const link = /^\[([^\]\n]{1,500})\]\(([^\s()]{1,2048})\)/u.exec(remaining);
    if (link) {
      appendLink(parent, link[1], link[2], depth, budget);
      cursor += link[0].length;
      continue;
    }

    const autoLink = /^<(https?:\/\/[^<>\s]{1,2048}|mailto:[^<>\s]{1,2048})>/iu.exec(remaining);
    if (autoLink) {
      appendLink(parent, autoLink[1], autoLink[1], depth, budget);
      cursor += autoLink[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/u.exec(remaining);
    if (strong) {
      const value = node("strong");
      appendInline(value, strong[2], depth + 1, budget);
      parent.appendChild(value);
      cursor += strong[0].length;
      continue;
    }

    const strike = /^~~(?=\S)([\s\S]*?\S)~~/u.exec(remaining);
    if (strike) {
      const value = node("del");
      appendInline(value, strike[1], depth + 1, budget);
      parent.appendChild(value);
      cursor += strike[0].length;
      continue;
    }

    const emphasis = /^(\*|_)(?=\S)([^\n]*?\S)\1/u.exec(remaining);
    if (emphasis) {
      const value = node("em");
      appendInline(value, emphasis[2], depth + 1, budget);
      parent.appendChild(value);
      cursor += emphasis[0].length;
      continue;
    }

    if (source[cursor] === "\\" && /[\\\x60*_[\]{}()#+.!$~-]/u.test(source[cursor + 1] || "")) {
      appendText(parent, source[cursor + 1]);
      cursor += 2;
      continue;
    }

    if (source[cursor] === "\n") {
      const hardBreak = cursor >= 2 && source.slice(cursor - 2, cursor) === "  ";
      parent.appendChild(hardBreak ? node("br") : document.createTextNode(" "));
      cursor += 1;
      continue;
    }

    let next = cursor + 1;
    while (next < source.length && !/[\\\x60*$\[<_~\n]/u.test(source[next])) next += 1;
    appendText(parent, source.slice(cursor, next));
    cursor = next;
  }
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !escapedAt(value, value.length - 1)) value = value.slice(0, -1);
  const cells = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "|" && !escapedAt(value, index)) {
      cells.push(current.trim());
      current = "";
    } else {
      current += value[index];
    }
  }
  cells.push(current.trim());
  return cells.slice(0, MAX_TABLE_COLUMNS);
}

function tableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function beginsBlock(lines, index) {
  const line = lines[index] || "";
  if (!line.trim()) return true;
  if (/^ {0,3}(?:#{1,6})\s+/u.test(line)) return true;
  if (/^ {0,3}(?:[-+*]|\d+[.)])\s+/u.test(line)) return true;
  if (/^ {0,3}>/u.test(line)) return true;
  if (/^ {0,3}(?:\x60{3,}|~{3,})/u.test(line)) return true;
  if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) return true;
  if (line.trim().startsWith("$$") || line.trim().startsWith("\\[")) return true;
  return index + 1 < lines.length && line.includes("|") && tableSeparator(lines[index + 1]);
}

function renderBlocks(target, lines, depth, budget) {
  if (depth > MAX_BLOCK_DEPTH) {
    const fallback = node("pre", "markdown-fallback");
    fallback.textContent = lines.join("\n");
    target.appendChild(fallback);
    return;
  }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^ {0,3}(\x60{3,}|~{3,})([^\n]*)$/u.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const minimum = fence[1].length;
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp("^ {0,3}" + (marker.charCodeAt(0) === 96 ? "\\x60" : "~") + "{" + minimum + ",}\\s*$", "u").test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = node("pre", "code-block");
      const code = node("code");
      const language = fence[2].trim().split(/\s+/u, 1)[0].toLowerCase();
      if (/^[a-z0-9_+-]{1,32}$/u.test(language)) code.className = "language-" + language;
      code.textContent = body.join("\n");
      pre.appendChild(code);
      target.appendChild(pre);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const open = trimmed.startsWith("$$") ? "$$" : "\\[";
      const close = open === "$$" ? "$$" : "\\]";
      let expression = trimmed.slice(open.length);
      let closed = expression.endsWith(close) && expression.length > close.length;
      if (closed) expression = expression.slice(0, -close.length);
      index += 1;
      while (!closed && index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim().endsWith(close)) {
          expression += (expression ? "\n" : "") + candidate.slice(0, candidate.lastIndexOf(close));
          closed = true;
          index += 1;
          break;
        }
        expression += (expression ? "\n" : "") + candidate;
        index += 1;
      }
      if (closed && expression.trim()) target.appendChild(mathNode(expression.trim(), true, budget));
      else {
        const fallback = node("pre", "math-fallback");
        fallback.textContent = open + expression;
        target.appendChild(fallback);
      }
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading) {
      const value = node("h" + heading[1].length);
      appendInline(value, heading[2], 0, budget);
      target.appendChild(value);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      target.appendChild(node("hr"));
      index += 1;
      continue;
    }

    if (/^ {0,3}>/u.test(line)) {
      const quoted = [];
      while (index < lines.length && /^ {0,3}>/u.test(lines[index])) {
        quoted.push(lines[index].replace(/^ {0,3}> ?/u, ""));
        index += 1;
      }
      const quote = node("blockquote");
      renderBlocks(quote, quoted, depth + 1, budget);
      target.appendChild(quote);
      continue;
    }

    const listMatch = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u.exec(line);
    if (listMatch) {
      const ordered = /^\d/u.test(listMatch[1]);
      const list = node(ordered ? "ol" : "ul");
      let rows = 0;
      while (index < lines.length && rows < 500) {
        const item = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/u.exec(lines[index]);
        if (!item || /^\d/u.test(item[1]) !== ordered) break;
        const entry = node("li");
        appendInline(entry, item[2], 0, budget);
        list.appendChild(entry);
        index += 1;
        rows += 1;
      }
      target.appendChild(list);
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && tableSeparator(lines[index + 1])) {
      const headings = splitTableRow(line);
      const alignments = splitTableRow(lines[index + 1]).map((cell) => ({
        left: cell.startsWith(":"),
        right: cell.endsWith(":"),
      }));
      const wrapper = node("div", "table-scroll");
      const table = node("table");
      const thead = node("thead");
      const headerRow = node("tr");
      headings.forEach((headingText, column) => {
        const cell = node("th");
        const alignment = alignments[column];
        if (alignment) cell.dataset.align = alignment.left && alignment.right ? "center" : (alignment.right ? "right" : "left");
        appendInline(cell, headingText, 0, budget);
        headerRow.appendChild(cell);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);
      const tbody = node("tbody");
      index += 2;
      let rows = 0;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() && rows < MAX_TABLE_ROWS) {
        const tableRow = node("tr");
        const cells = splitTableRow(lines[index]);
        headings.forEach((_, column) => {
          const cell = node("td");
          const alignment = alignments[column];
          if (alignment) cell.dataset.align = alignment.left && alignment.right ? "center" : (alignment.right ? "right" : "left");
          appendInline(cell, cells[column] || "", 0, budget);
          tableRow.appendChild(cell);
        });
        tbody.appendChild(tableRow);
        index += 1;
        rows += 1;
      }
      table.appendChild(tbody);
      wrapper.appendChild(table);
      target.appendChild(wrapper);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && !beginsBlock(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = node("p");
    appendInline(paragraph, paragraphLines.join("\n"), 0, budget);
    target.appendChild(paragraph);
  }
}

function renderMarkdown(target, source) {
  if (!target || typeof target.replaceChildren !== "function") return;
  const normalized = typeof source === "string"
    ? source.slice(0, MAX_MARKDOWN_CHARACTERS).replace(/\r\n?|\u2028|\u2029/gu, "\n")
    : "";
  const fragment = document.createDocumentFragment();
  const budget = { mathExpressions: 0, texCharacters: 0 };
  try {
    renderBlocks(fragment, normalized.split("\n"), 0, budget);
  } catch (_) {
    const fallback = node("pre", "markdown-fallback");
    fallback.textContent = normalized;
    fragment.replaceChildren(fallback);
  }
  target.replaceChildren(fragment);
}

window.LazyEdgeMarkdown = Object.freeze({ render: renderMarkdown });
if (typeof window.dispatchEvent === "function" && typeof Event === "function") {
  window.dispatchEvent(new Event("lazyedge-markdown-ready"));
}
`;
