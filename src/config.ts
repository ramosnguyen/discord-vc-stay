import type {
	ChannelId,
	CliResolution,
	ConfigSources,
	DiscordToken,
	GuildId,
	LogLevel,
	OptionSource,
	RuntimeConfig,
	Snowflake,
	ValidationIssue
} from './types';

const HELP_TEXT = `discord-vc-stay (selfbot)

Usage:
  npm run dev -- --token <USER_TOKEN> --guild-id <GUILD_ID> --channel-id <CHANNEL_ID>
  npm run start -- --token <USER_TOKEN> --guild-id <GUILD_ID> --channel-id <CHANNEL_ID>

Required options:
  --token, -t        Discord user token
  --guild-id, -g     Target guild (server) ID
  --channel-id, -c   Target voice/stage channel ID

Optional:
  --log-level, -l    debug | info | warn | error (default: info)
  --help, -h         Show this help

Environment variable alternatives:
  DISCORD_TOKEN
  DISCORD_GUILD_ID
  DISCORD_CHANNEL_ID
  LOG_LEVEL
`;

type CliOptionName = 'token' | 'guildId' | 'channelId' | 'logLevel' | 'help';
type ValueOptionName = Exclude<CliOptionName, 'help'>;

interface ParsedArgv {
	readonly values: Partial<Record<ValueOptionName, string>>;
	readonly helpRequested: boolean;
	readonly issues: readonly ValidationIssue[];
}

type OptionAliasMap = Record<string, CliOptionName>;

const OPTION_ALIASES: OptionAliasMap = {
	'--token': 'token',
	'-t': 'token',
	'--guild-id': 'guildId',
	'-g': 'guildId',
	'--channel-id': 'channelId',
	'-c': 'channelId',
	'--log-level': 'logLevel',
	'-l': 'logLevel',
	'--help': 'help',
	'-h': 'help'
};

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

const SNOWFLAKE_PATTERN = /^\d{16,22}$/;

function parseArgv(argv: readonly string[]): ParsedArgv {
	const values: Partial<Record<ValueOptionName, string>> = {};
	const issues: ValidationIssue[] = [];
	let helpRequested = false;

	for (let index = 0; index < argv.length; index += 1) {
		const rawArgument = argv[index];
		if (rawArgument === undefined) {
			continue;
		}

		if (!rawArgument.startsWith('-')) {
			issues.push({
				code: 'unknown_option',
				field: 'argv',
				message: `Unexpected positional argument: ${rawArgument}`
			});
			continue;
		}

		const equalIndex = rawArgument.indexOf('=');
		const hasInlineValue = equalIndex > -1;
		const alias = hasInlineValue ? rawArgument.slice(0, equalIndex) : rawArgument;
		const optionName = OPTION_ALIASES[alias];

		if (optionName === undefined) {
			issues.push({
				code: 'unknown_option',
				field: 'argv',
				message: `Unknown option: ${alias}`
			});
			continue;
		}

		if (optionName === 'help') {
			helpRequested = true;
			continue;
		}

		const valueOptionName = optionName;

		if (values[valueOptionName] !== undefined) {
			issues.push({
				code: 'duplicate_option',
				field: mapOptionNameToField(valueOptionName),
				message: `Duplicate option: ${alias}`
			});
			continue;
		}

		let optionValue = hasInlineValue ? rawArgument.slice(equalIndex + 1) : '';
		if (!hasInlineValue) {
			const nextArg = argv[index + 1];
			if (nextArg === undefined || nextArg.startsWith('-')) {
				issues.push({
					code: 'missing_value',
					field: mapOptionNameToField(valueOptionName),
					message: `Missing value for option: ${alias}`
				});
				continue;
			}
			optionValue = nextArg;
			index += 1;
		}

		values[valueOptionName] = optionValue;
	}

	return {
		values,
		helpRequested,
		issues
	};
}

function mapOptionNameToField(optionName: ValueOptionName): ValidationIssue['field'] {
	switch (optionName) {
		case 'token':
			return 'token';
		case 'guildId':
			return 'guildId';
		case 'channelId':
			return 'channelId';
		case 'logLevel':
			return 'logLevel';
	}
}

function resolveStringValue(
	argvValue: string | undefined,
	envValue: string | undefined,
	defaultValue: string | undefined
): { value: string | undefined; source: OptionSource } {
	if (argvValue !== undefined) {
		return { value: argvValue, source: 'argv' };
	}
	if (envValue !== undefined) {
		return { value: envValue, source: 'env' };
	}
	return { value: defaultValue, source: 'default' };
}

function validateToken(rawToken: string | undefined): DiscordToken | undefined {
	if (rawToken === undefined) {
		return undefined;
	}
	const normalized = rawToken.trim();
	if (normalized.length === 0) {
		return undefined;
	}
	return normalized as DiscordToken;
}

function validateSnowflake(rawValue: string | undefined): Snowflake | undefined {
	if (rawValue === undefined) {
		return undefined;
	}
	const normalized = rawValue.trim();
	if (!SNOWFLAKE_PATTERN.test(normalized)) {
		return undefined;
	}
	return normalized as Snowflake;
}

function asGuildId(value: Snowflake): GuildId {
	return value as GuildId;
}

function asChannelId(value: Snowflake): ChannelId {
	return value as ChannelId;
}

export function resolveCli(argv: readonly string[], env: NodeJS.ProcessEnv): CliResolution {
	const parsed = parseArgv(argv);
	if (parsed.helpRequested) {
		return {
			kind: 'help',
			helpText: HELP_TEXT
		};
	}

	const tokenInput = resolveStringValue(parsed.values.token, env.DISCORD_TOKEN, undefined);
	const guildInput = resolveStringValue(parsed.values.guildId, env.DISCORD_GUILD_ID, undefined);
	const channelInput = resolveStringValue(
		parsed.values.channelId,
		env.DISCORD_CHANNEL_ID,
		undefined
	);
	const logLevelInput = resolveStringValue(parsed.values.logLevel, env.LOG_LEVEL, 'info');

	const issues = [...parsed.issues];

	const token = validateToken(tokenInput.value);
	if (token === undefined) {
		issues.push({
			code: tokenInput.value === undefined ? 'missing_value' : 'invalid_format',
			field: 'token',
			message:
				tokenInput.value === undefined
					? 'Token is required (--token or DISCORD_TOKEN).'
					: 'Token is invalid (must be a non-empty Discord user token).'
		});
	}

	const guildSnowflake = validateSnowflake(guildInput.value);
	if (guildSnowflake === undefined) {
		issues.push({
			code: guildInput.value === undefined ? 'missing_value' : 'invalid_format',
			field: 'guildId',
			message:
				guildInput.value === undefined
					? 'Guild ID is required (--guild-id or DISCORD_GUILD_ID).'
					: 'Guild ID is invalid (must be a Discord snowflake).'
		});
	}

	const channelSnowflake = validateSnowflake(channelInput.value);
	if (channelSnowflake === undefined) {
		issues.push({
			code: channelInput.value === undefined ? 'missing_value' : 'invalid_format',
			field: 'channelId',
			message:
				channelInput.value === undefined
					? 'Channel ID is required (--channel-id or DISCORD_CHANNEL_ID).'
					: 'Channel ID is invalid (must be a Discord snowflake).'
		});
	}

	const rawLogLevel = (logLevelInput.value ?? 'info').trim().toLowerCase();
	const logLevel = LOG_LEVELS.has(rawLogLevel as LogLevel)
		? (rawLogLevel as LogLevel)
		: undefined;
	if (logLevel === undefined) {
		issues.push({
			code: 'invalid_format',
			field: 'logLevel',
			message: 'Log level must be one of: debug, info, warn, error.'
		});
	}

	if (
		issues.length > 0 ||
		token === undefined ||
		guildSnowflake === undefined ||
		channelSnowflake === undefined ||
		logLevel === undefined
	) {
		return {
			kind: 'error',
			helpText: HELP_TEXT,
			issues
		};
	}

	const sources: ConfigSources = {
		token: tokenInput.source,
		guildId: guildInput.source,
		channelId: channelInput.source,
		logLevel: logLevelInput.source
	};

	const config: RuntimeConfig = {
		token,
		guildId: asGuildId(guildSnowflake),
		channelId: asChannelId(channelSnowflake),
		logLevel
	};

	return {
		kind: 'run',
		config,
		sources
	};
}

export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
	if (issues.length === 0) {
		return 'Unknown configuration error.';
	}
	return issues.map((issue) => `- [${issue.field}] ${issue.message}`).join('\n');
}

export function getHelpText(): string {
	return HELP_TEXT;
}
