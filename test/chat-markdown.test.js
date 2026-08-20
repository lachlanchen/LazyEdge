import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import katex from "katex";

import { CHAT_MARKDOWN_JS } from "../src/chat-markdown.js";

class TestNode {
  constructor(tagName, value = "") {
    this.tagName = tagName;
    this.nodeValue = value;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
    this.href = "";
    this.rel = "";
    this.target = "";
  }

  appendChild(child) {
    if (child.tagName === "#fragment") {
      for (const entry of [...child.children]) this.appendChild(entry);
      child.children = [];
      return child;
    }
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  get textContent() {
    if (this.tagName === "#text") return this.nodeValue;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.children = [new TestNode("#text", String(value))];
  }
}

class TestDocument {
  createElement(name) {
    return new TestNode(name.toUpperCase());
  }

  createTextNode(value) {
    return new TestNode("#text", value);
  }

  createDocumentFragment() {
    return new TestNode("#fragment");
  }
}

function descendants(root) {
  const result = [];
  const visit = (current) => {
    result.push(current);
    current.children.forEach(visit);
  };
  root.children.forEach(visit);
  return result;
}

function markdownRuntime() {
  const document = new TestDocument();
  const calls = [];
  const katex = {
    render(source, target, options) {
      calls.push({ source, options });
      const math = document.createElement("math");
      math.setAttribute("data-expression", source);
      math.textContent = source;
      target.replaceChildren(math);
    },
  };
  const window = {
    location: {
      href: "https://llm.example.test/",
      origin: "https://llm.example.test",
    },
  };
  const context = vm.createContext({
    URL,
    __katex: katex,
    document,
    window,
  });
  const executable = CHAT_MARKDOWN_JS.replace(
    /^import katex from "\/assets\/katex\.mjs";\n/u,
    "const katex = globalThis.__katex;\n",
  );
  new vm.Script(executable).runInContext(context);
  return {
    calls,
    document,
    render(source) {
      const target = document.createElement("div");
      window.LazyEdgeMarkdown.render(target, source);
      return target;
    },
  };
}

test("Markdown runtime is pinned to same-origin KaTeX and has no dynamic HTML sink", async () => {
  const packageMetadata = JSON.parse(await readFile("node_modules/katex/package.json", "utf8"));
  assert.equal(packageMetadata.version, "0.16.47");
  assert.match(CHAT_MARKDOWN_JS, /^import katex from "\/assets\/katex\.mjs";/u);
  assert.doesNotMatch(CHAT_MARKDOWN_JS, /https?:\/\//iu);
  assert.doesNotMatch(CHAT_MARKDOWN_JS, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b/iu);
  assert.doesNotThrow(() => new vm.Script(CHAT_MARKDOWN_JS.replace(
    /^import katex[^\n]+\n/u,
    "const katex = { render() {} };\n",
  )));
});

test("Markdown renders headings, emphasis, lists, quotes, tables, safe links, and MathML", () => {
  const runtime = markdownRuntime();
  const output = runtime.render([
    "# A clear answer",
    "",
    "Use **strong reasoning**, *care*, and $x^2 + y^2 = z^2$.",
    "",
    "> A useful note",
    "",
    "- first",
    "- second",
    "",
    "| Item | Value |",
    "| :--- | ---: |",
    "| Link | [source](https://example.com/reference) |",
  ].join("\n"));
  const nodes = descendants(output);
  const tags = nodes.map((entry) => entry.tagName);
  for (const expected of ["H1", "P", "STRONG", "EM", "BLOCKQUOTE", "UL", "LI", "TABLE", "THEAD", "TBODY", "A", "MATH"]) {
    assert(tags.includes(expected), `missing ${expected}`);
  }
  const anchor = nodes.find((entry) => entry.tagName === "A");
  assert.equal(anchor.href, "https://example.com/reference");
  assert.equal(anchor.target, "_blank");
  assert.equal(anchor.rel, "noopener noreferrer");
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].source, "x^2 + y^2 = z^2");
  assert.equal(typeof runtime.calls[0].options.macros.hasOwnProperty, "function");
  assert.match(
    katex.renderToString("x_0", runtime.calls[0].options),
    /<math(?:\s|>)/u,
  );
  assert.deepEqual(
    {
      displayMode: runtime.calls[0].options.displayMode,
      output: runtime.calls[0].options.output,
      trust: runtime.calls[0].options.trust,
      throwOnError: runtime.calls[0].options.throwOnError,
      strict: runtime.calls[0].options.strict,
      maxExpand: runtime.calls[0].options.maxExpand,
      maxSize: runtime.calls[0].options.maxSize,
    },
    {
      displayMode: false,
      output: "mathml",
      trust: false,
      throwOnError: false,
      strict: "error",
      maxExpand: 500,
      maxSize: 10,
    },
  );
});

test("code remains verbatim and raw HTML, script URLs, and image syntax cannot create active nodes", () => {
  const runtime = markdownRuntime();
  const fenced = "<img src=x onerror=alert(1)>\n$x$\n[bad](javascript:alert(1))";
  const output = runtime.render([
    "\x60\x60\x60html",
    fenced,
    "\x60\x60\x60",
    "",
    "Inline \x60$y$ <script>alert(2)</script>\x60 stays code.",
    "",
    "Outside <img src=x onerror=alert(3)> and [bad](javascript:alert(4)).",
  ].join("\n"));
  const nodes = descendants(output);
  assert.equal(runtime.calls.length, 0);
  assert.equal(nodes.some((entry) => entry.tagName === "IMG" || entry.tagName === "SCRIPT"), false);
  assert.equal(nodes.some((entry) => entry.tagName === "A"), false);
  const fencedCode = nodes.find((entry) => entry.tagName === "PRE")?.children[0];
  assert.equal(fencedCode?.tagName, "CODE");
  assert.equal(fencedCode?.textContent, fenced);
  assert.match(output.textContent, /javascript:alert\(4\)/u);
});

test("display TeX uses KaTeX MathML while an unclosed delimiter has a readable fallback", () => {
  const runtime = markdownRuntime();
  const display = runtime.render("$$\\frac{1}{2} + \\sqrt{x}$$");
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].options.displayMode, true);
  assert.equal(runtime.calls[0].source, "\\frac{1}{2} + \\sqrt{x}");
  assert(descendants(display).some((entry) => entry.tagName === "MATH"));

  runtime.calls.length = 0;
  const malformed = runtime.render("$$\\frac{1}{2}");
  assert.equal(runtime.calls.length, 0);
  const fallback = descendants(malformed).find((entry) => entry.className === "math-fallback");
  assert(fallback);
  assert.equal(fallback.textContent, "$$\\frac{1}{2}");
});

test("a message has an aggregate KaTeX work budget with readable overflow", () => {
  const runtime = markdownRuntime();
  const source = Array.from({ length: 100 }, (_, index) => `$x_${index}$`).join(" ");
  const output = runtime.render(source);
  assert.equal(runtime.calls.length, 32);
  const limited = descendants(output).filter((entry) => entry.className.includes("math-limit"));
  assert.equal(limited.length, 68);
  assert.match(limited[0].textContent, /^\$x_32\$$/u);
  assert.match(output.textContent, /\$x_99\$/u);
});
