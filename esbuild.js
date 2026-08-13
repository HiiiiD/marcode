const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
		external: ['vscode'],
	});

	const webviewCtx = await esbuild.context({
		...common,
		entryPoints: ['src/webview/main.tsx'],
		format: 'iife',
		platform: 'browser',
		outfile: 'dist/webview.js',
		loader: { '.tsx': 'tsx', '.ts': 'ts' },
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
