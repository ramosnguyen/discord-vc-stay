export type Brand<TValue, TTag extends string> = TValue & {
	readonly __brand: TTag;
};

export type Snowflake = Brand<string, 'Snowflake'>;
export type GuildId = Brand<Snowflake, 'GuildId'>;
export type ChannelId = Brand<Snowflake, 'ChannelId'>;
export type DiscordToken = Brand<string, 'DiscordToken'>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ValidationIssueCode =
	| 'missing_value'
	| 'invalid_format'
	| 'unknown_option'
	| 'duplicate_option';

export type ValidationField = 'argv' | 'token' | 'guildId' | 'channelId' | 'logLevel';

export interface ValidationIssue {
	readonly code: ValidationIssueCode;
	readonly field: ValidationField;
	readonly message: string;
}

export type ValidationResult<TValue> =
	| {
			readonly ok: true;
			readonly value: TValue;
	  }
	| {
			readonly ok: false;
			readonly issues: readonly ValidationIssue[];
	  };

export type OptionSource = 'argv' | 'env' | 'default';

export interface OptionValue<TValue> {
	readonly value: TValue;
	readonly source: OptionSource;
}

export interface RuntimeConfig {
	readonly token: DiscordToken;
	readonly guildId: GuildId;
	readonly channelId: ChannelId;
	readonly logLevel: LogLevel;
}

export interface ConfigSources {
	readonly token: OptionSource;
	readonly guildId: OptionSource;
	readonly channelId: OptionSource;
	readonly logLevel: OptionSource;
}

export type CliResolution =
	| {
			readonly kind: 'help';
			readonly helpText: string;
	  }
	| {
			readonly kind: 'error';
			readonly helpText: string;
			readonly issues: readonly ValidationIssue[];
	  }
	| {
			readonly kind: 'run';
			readonly config: RuntimeConfig;
			readonly sources: ConfigSources;
	  };
