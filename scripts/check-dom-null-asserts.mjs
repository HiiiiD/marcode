#!/usr/bin/env node
// Detects `assert.strictEqual(<dom query>, null)` (and deepStrictEqual/equal/
// deepEqual, either argument order). A failing assert of that shape calls
// util.inspect on the returned Element, which drags in its parents,
// ownerDocument and that document's window — 3.5GB / 4s on a real failure
// (see CLAUDE.md "Never pass a DOM node to an assertion").
//
// Not wired into `yarn lint` on purpose: it is a style/safety scan over test
// files, not a compile gate, and flips many pre-existing tests red the day
// it's added. Run it by hand, or from a pre-commit/CI step you opt into.
//
// Usage:
//   node scripts/check-dom-null-asserts.mjs [file-or-dir ...]
//   (defaults to src/test)

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const ASSERT_METHODS = /^(strictEqual|deepStrictEqual|equal|deepEqual)$/;
const DOM_QUERY_METHODS = /\.(querySelector|querySelectorAll|closest|queryBy\w+|queryAllBy\w+)\(/;

function collectFiles(target) {
    const st = statSync(target);
    if (st.isFile()) {
        return /\.(ts|tsx)$/.test(target) ? [target] : [];
    }
    const out = [];
    for (const entry of readdirSync(target)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        out.push(...collectFiles(path.join(target, entry)));
    }
    return out;
}

// Given source text and the index right after `assert.<method>(`, return the
// matching close-paren index (the call's own), respecting nested
// parens/brackets/braces/strings/template literals/regex-ish slashes.
function findCallEnd(src, openIdx) {
    let depth = 1;
    let i = openIdx + 1;
    while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === "'" || c === '"' || c === "`") {
            const quote = c;
            i++;
            while (i < src.length && src[i] !== quote) {
                if (src[i] === "\\") i++;
                i++;
            }
        }
        i++;
    }
    return i - 1; // index of the matching ')'
}

// Split top-level call arguments (depth 0), respecting the same nesting.
function splitTopLevelArgs(argsText) {
    const args = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < argsText.length; i++) {
        const c = argsText[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === "'" || c === '"' || c === "`") {
            const quote = c;
            i++;
            while (i < argsText.length && argsText[i] !== quote) {
                if (argsText[i] === "\\") i++;
                i++;
            }
        } else if (c === "," && depth === 0) {
            args.push(argsText.slice(start, i));
            start = i + 1;
        }
    }
    args.push(argsText.slice(start));
    return args.map((a) => a.trim());
}

function lineOf(src, index) {
    return src.slice(0, index).split("\n").length;
}

// Blank out // and /* */ comments (keep newlines, so line numbers still
// line up) so doc-comment examples of the bad pattern don't self-flag.
// Strings/template literals are left untouched.
function stripComments(src) {
    let out = "";
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const two = src.slice(i, i + 2);
        if (c === "'" || c === '"' || c === "`") {
            const quote = c;
            const start = i;
            i++;
            while (i < src.length && src[i] !== quote) {
                if (src[i] === "\\") i++;
                i++;
            }
            i++; // closing quote
            out += src.slice(start, i);
        } else if (two === "//") {
            while (i < src.length && src[i] !== "\n") {
                out += " ";
                i++;
            }
        } else if (two === "/*") {
            out += "  ";
            i += 2;
            while (i < src.length && src.slice(i, i + 2) !== "*/") {
                out += src[i] === "\n" ? "\n" : " ";
                i++;
            }
            out += "  ";
            i += 2;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

function scanFile(file) {
    const raw = readFileSync(file, "utf8");
    const src = stripComments(raw);
    const findings = [];
    const callRe = /assert\.(strictEqual|deepStrictEqual|equal|deepEqual)\(/g;
    let m;
    while ((m = callRe.exec(src))) {
        if (!ASSERT_METHODS.test(m[1])) continue;
        const openIdx = m.index + m[0].length - 1;
        const closeIdx = findCallEnd(src, openIdx);
        if (closeIdx < 0) continue;
        const argsText = src.slice(openIdx + 1, closeIdx);
        const args = splitTopLevelArgs(argsText);
        const hasNullArg = args.some((a) => a === "null");
        const domArg = args.find((a) => DOM_QUERY_METHODS.test(a));
        if (hasNullArg && domArg) {
            findings.push({ line: lineOf(src, m.index), snippet: `assert.${m[1]}(${argsText.replace(/\s+/g, " ").trim()})` });
        }
    }
    return findings;
}

const targets = process.argv.slice(2);
const files = (targets.length ? targets : ["src/test"]).flatMap(collectFiles);

let total = 0;
for (const file of files) {
    const findings = scanFile(file);
    if (findings.length === 0) continue;
    total += findings.length;
    console.log(file);
    for (const f of findings) {
        console.log(`  ${f.line}: ${f.snippet}`);
    }
}

if (total === 0) {
    console.log("No unsafe DOM-node null assertions found.");
    process.exit(0);
} else {
    console.log(`\n${total} unsafe assertion(s) found. Compare with \`=== null\` instead of passing the node/list straight to assert.`);
    process.exit(1);
}
