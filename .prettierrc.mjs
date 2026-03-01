import sapphirePrettierConfig from '@sapphire/prettier-config';

/** @type {import('prettier').Config} @satisfies {import("prettier").Config} */
export default {
	...sapphirePrettierConfig,
	printWidth: 100,
	trailingComma: 'none',
	bracketSpacing: true,
	bracketSameLine: false,
	singleQuote: true,
	overrides: [
		...sapphirePrettierConfig.overrides,
		{
			files: ['README.md'],
			options: {
				tabWidth: 2,
				useTabs: false,
				printWidth: 70,
				proseWrap: 'always'
			}
		}
	]
};
