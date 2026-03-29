declare module 'discord.js-selfbot-v13' {
	import type { EventEmitter } from 'events';

	interface ClientOptions {
		checkUpdate?: boolean;
	}

	interface ClientUser {
		readonly id: string;
		readonly tag: string;
		readonly username: string;
	}

	interface Guild {
		readonly id: string;
		readonly voiceAdapterCreator: unknown;
		readonly channels: GuildChannelManager;
		readonly members: GuildMemberManager;
	}

	interface GuildChannelManager {
		fetch(id: string): Promise<GuildBasedChannel | null>;
	}

	interface BaseFetchOptions {
		cache?: boolean;
		force?: boolean;
	}

	interface GuildMemberVoiceState {
		readonly channelId: string | null;
	}

	interface GuildMember {
		readonly voice: GuildMemberVoiceState;
	}

	interface GuildMemberManager {
		fetchMe(options?: BaseFetchOptions): Promise<GuildMember>;
	}

	interface GuildBasedChannel {
		readonly id: string;
		readonly name: string;
		readonly type: string;
		readonly guild: Guild;
	}

	interface VoiceState {
		readonly id: string;
		readonly channelId: string | null;
		readonly guild: Guild;
	}

	interface GuildManager {
		fetch(id: string): Promise<Guild>;
	}

	interface CloseEvent {
		readonly code: number;
		readonly reason: string;
	}

	class Client extends EventEmitter {
		constructor(options?: ClientOptions);
		user: ClientUser | null;
		guilds: GuildManager;
		login(token: string): Promise<string>;
		destroy(): void;

		on(event: 'ready', listener: () => void): this;
		once(event: 'ready', listener: () => void): this;
		on(
			event: 'voiceStateUpdate',
			listener: (oldState: VoiceState, newState: VoiceState) => void
		): this;
		on(event: 'error', listener: (error: Error) => void): this;
		on(
			event: 'shardDisconnect',
			listener: (closeEvent: CloseEvent, shardId: number) => void
		): this;
		on(event: 'shardReconnecting', listener: () => void): this;
		on(event: 'shardResume', listener: (replayed: number) => void): this;
		on(event: 'invalidated', listener: () => void): this;
	}

	export {
		Client,
		ClientOptions,
		ClientUser,
		Guild,
		GuildBasedChannel,
		GuildChannelManager,
		GuildMember,
		GuildMemberManager,
		GuildMemberVoiceState,
		GuildManager,
		VoiceState,
		CloseEvent
	};
}
