const esbuild = require("esbuild");
const { execFile } = require("child_process");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Rebuilds dist/webview.css after every webview build.
 *
 * Tailwind scans the .tsx sources for class names, so the CSS is only correct
 * once the sources it scans are current. Running it here rather than as a
 * separate watcher keeps one process and one set of completion markers — the
 * Tailwind CLI's own watch mode prints no per-rebuild marker, so a VS Code
 * background task cannot tell when it has finished.
 *
 * @type {import('esbuild').Plugin}
 */
const tailwindPlugin = {
	name: 'tailwind',

	setup(build) {
		// Resolve the CLI's JS entry rather than the node_modules/.bin shim:
		// on Windows the shim is a .cmd, and Node refuses to spawn .cmd without
		// a shell (spawn EINVAL). Running it under process.execPath is both
		// cross-platform and shell-free.
		const cliDir = path.dirname(require.resolve('@tailwindcss/cli/package.json'));
		const cli = path.join(cliDir, require('@tailwindcss/cli/package.json').bin.tailwindcss);
		const args = [cli, '-i', 'src/webview/index.css', '-o', 'dist/webview.css'];
		if (production) {
			args.push('--minify');
		}

		build.onEnd(() => new Promise((resolve) => {
			execFile(process.execPath, args, { cwd: __dirname }, (err, _stdout, stderr) => {
				if (err) {
					console.error(`✘ [ERROR] tailwind: ${stderr || err.message}`);
				}
				resolve();
			});
		}));
	},
};

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const common = {
		bundle: true,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	};

	const hostCtx = await esbuild.context({
		...common,
		entryPoints: ['src/extension.ts'],
		format: 'cjs',
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', '@anthropic-ai/claude-agent-sdk'],
		alias: { '@': require('path').resolve(__dirname, 'src/webview') },
	});

	const webviewCtx = await esbuild.context({
		...common,
		entryPoints: ['src/webview/main.tsx'],
		format: 'iife',
		platform: 'browser',
		outfile: 'dist/webview.js',
		loader: { '.tsx': 'tsx', '.ts': 'ts' },
		alias: { '@': require('path').resolve(__dirname, 'src/webview') },
		// tailwindPlugin is registered first so its onEnd is awaited before the
		// problem matcher logs "[watch] build finished" — the CSS is on disk by
		// the time anything downstream treats the build as complete.
		plugins: [tailwindPlugin, ...common.plugins],
	});

	if (watch) {
		await Promise.all([hostCtx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([hostCtx.rebuild(), webviewCtx.rebuild()]);
		await Promise.all([hostCtx.dispose(), webviewCtx.dispose()]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
