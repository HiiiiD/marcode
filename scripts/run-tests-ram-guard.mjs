#!/usr/bin/env node
// Runs a test suite while polling the child process's real memory (RSS on
// posix, WorkingSet64 on Windows — a heap cap does not bound this, see
// CLAUDE.md-adjacent memory note "Heap cap is not an RSS cap") and kills it
// the moment it crosses a threshold, instead of letting a bad assertion
// (e.g. assert.strictEqual(someDomNode, null) — see
// scripts/check-dom-null-asserts.mjs) take the whole machine down.
//
// Usage:
//   node scripts/run-tests-ram-guard.mjs <unit|dom> [--limit-mb=2048] [--interval-ms=250]
//
// Exit code: the wrapped test process's own exit code, or 137 if killed for
// exceeding the RAM limit.

import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";

// Invoke mocha's JS entry point directly with `node` (not `npx`/the shell
// shim) so the spawned pid IS the process actually running the tests — an
// npx/cmd wrapper layer would leave us polling a near-empty shell process
// while the real memory sits in an unmonitored grandchild.
const MOCHA_BIN = path.join("node_modules", "mocha", "bin", "mocha.js");
const SUITES = {
    unit: {
        bin: process.execPath,
        args: [MOCHA_BIN, "--ui", "tdd", "--require", "tsx/cjs", "src/test/unit/**/*.test.ts"],
    },
    dom: {
        bin: process.execPath,
        args: [
            MOCHA_BIN,
            "--ui", "tdd",
            "--require", "tsx/cjs",
            "--require", "global-jsdom/register",
            "--require", "src/test/dom/setup.ts",
            "src/test/dom/**/*.test.tsx",
        ],
    },
};

function parseArgs(argv) {
    let parsed;
    try {
        parsed = nodeParseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                "limit-mb": { type: "string", default: "2048" },
                "interval-ms": { type: "string", default: "250" },
            },
        });
    } catch (err) {
        console.error(err.message);
        process.exit(2);
    }
    const suiteName = parsed.positionals[0];
    if (!suiteName || !SUITES[suiteName]) {
        console.error(`Usage: node scripts/run-tests-ram-guard.mjs <${Object.keys(SUITES).join("|")}> [--limit-mb=2048] [--interval-ms=250]`);
        process.exit(2);
    }
    const limitMb = Number(parsed.values["limit-mb"]);
    const intervalMs = Number(parsed.values["interval-ms"]);
    if (!Number.isFinite(limitMb) || !Number.isFinite(intervalMs)) {
        console.error("--limit-mb and --interval-ms must be numbers");
        process.exit(2);
    }
    return { suiteName, limitMb, intervalMs };
}

// Returns RSS/WorkingSet in bytes for a pid, or null if the process is gone
// or the read failed (transient — process just exited, permissions, etc).
function readMemoryBytes(pid) {
    try {
        if (process.platform === "win32") {
            const out = execSync(
                `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64"`,
                { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            ).trim();
            return out ? Number(out) : null;
        }
        if (process.platform === "linux") {
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            const line = status.split("\n").find((l) => l.startsWith("VmRSS:"));
            if (!line) return null;
            const kb = Number(line.replace(/\D+/g, ""));
            return kb * 1024;
        }
        // macOS / other posix: shell out to ps.
        const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return out ? Number(out) * 1024 : null;
    } catch {
        return null; // process likely exited between the tick and the read
    }
}

function killTree(pid) {
    try {
        if (process.platform === "win32") {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
        } else {
            process.kill(-pid, "SIGKILL"); // negative pid: whole process group (spawned detached)
        }
    } catch {
        // already gone
    }
}

const { suiteName, limitMb, intervalMs } = parseArgs(process.argv.slice(2));
const suite = SUITES[suiteName];
const limitBytes = limitMb * 1024 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

console.log(`[ram-guard] running ${suiteName} tests, limit=${limitMb}MB, poll=${intervalMs}ms`);

const child = spawn(suite.bin, suite.args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false, // direct node invocation — no shell/cmd wrapper layer to mis-track
    detached: process.platform !== "win32",
});

let killedForRam = false;
let peakBytes = 0;

const timer = setInterval(() => {
    const bytes = readMemoryBytes(child.pid);
    if (bytes == null) return;
    if (bytes > peakBytes) peakBytes = bytes;
    if (bytes > limitBytes) {
        killedForRam = true;
        console.error(
            `\n[ram-guard] KILLED: ${(bytes / 1024 / 1024).toFixed(0)}MB exceeds ${limitMb}MB limit. ` +
            `Likely a bad assertion on a DOM node/list (see scripts/check-dom-null-asserts.mjs) or a real leak.`,
        );
        clearInterval(timer);
        killTree(child.pid);
    }
}, intervalMs);

child.on("exit", (code, signal) => {
    clearInterval(timer);
    console.log(`[ram-guard] peak observed: ${(peakBytes / 1024 / 1024).toFixed(0)}MB`);
    if (killedForRam) {
        process.exit(137);
    }
    if (signal) {
        console.error(`[ram-guard] test process terminated by signal ${signal}`);
        process.exit(1);
    }
    process.exit(code ?? 1);
});
