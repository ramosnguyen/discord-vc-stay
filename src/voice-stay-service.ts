import { Client, type Guild, type GuildBasedChannel } from 'discord.js-selfbot-v13';
import {
	DiscordGatewayAdapterCreator,
	VoiceConnection,
	VoiceConnectionStatus,
	entersState,
	joinVoiceChannel
} from '@discordjs/voice';
import { ExponentialBackoff } from './backoff';
import { Logger } from './logger';
import type { RuntimeConfig } from './types';

type JoinTrigger =
	| 'client_ready'
	| 'scheduled_reconnect'
	| 'voice_state_mismatch'
	| 'voice_connection_disconnected';
type ReconnectReason =
	| 'join_failed'
	| 'voice_connection_disconnected'
	| 'voice_connection_error'
	| 'voice_state_mismatch'
	| 'guild_fetch_failed';

type ServiceState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'starting' }
	| { readonly phase: 'connected'; readonly connectedAt: Date }
	| {
			readonly phase: 'reconnecting';
			readonly reason: ReconnectReason;
			readonly scheduledFor: Date;
			readonly attempt: number;
	  }
	| { readonly phase: 'stopped'; readonly stoppedAt: Date };

function isJoinableVoiceChannel(channel: GuildBasedChannel | null): channel is GuildBasedChannel {
	if (channel === null) {
		return false;
	}
	return channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE';
}

function stringifyUnknown(value: unknown): string {
	if (value instanceof Error) {
		return value.stack ?? value.message;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export class VoiceStayService {
	private readonly client: Client;
	private readonly backoff = new ExponentialBackoff();

	private state: ServiceState = { phase: 'idle' };
	private connection: VoiceConnection | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private stopping = false;
	private eventsBound = false;

	public constructor(
		private readonly config: RuntimeConfig,
		private readonly logger: Logger
	) {
		this.client = new Client({
			checkUpdate: false
		});
	}

	public async start(): Promise<void> {
		if (this.state.phase !== 'idle') {
			return;
		}

		this.state = { phase: 'starting' };
		this.bindEvents();
		this.startHeartbeat();

		this.logger.info('Logging into Discord gateway...');
		try {
			await this.client.login(this.config.token);
		} catch (error: unknown) {
			this.state = { phase: 'idle' };
			this.logger.error('Failed to login. Check your user token. ' + stringifyUnknown(error));
			throw error;
		}
	}

	public async stop(): Promise<void> {
		if (this.stopping) {
			return;
		}
		this.stopping = true;

		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		this.teardownConnection();
		try {
			this.client.removeAllListeners();
			this.client.destroy();
		} catch (error: unknown) {
			this.logger.debug('Swallowed error during client teardown. ' + stringifyUnknown(error));
		}

		this.state = {
			phase: 'stopped',
			stoppedAt: new Date()
		};
		this.logger.info('Service stopped.');
	}

	private bindEvents(): void {
		if (this.eventsBound) {
			return;
		}
		this.eventsBound = true;

		this.client.once('ready', () => {
			const userIdentity = this.client.user?.tag ?? this.client.user?.id ?? 'unknown';
			this.logger.info(`Client ready as ${userIdentity}`);
			void this.ensureVoiceConnection('client_ready');
		});

		this.client.on('voiceStateUpdate', (_oldState, newState) => {
			if (this.stopping || this.client.user === null) {
				return;
			}
			if (newState.id !== this.client.user.id) {
				return;
			}
			if (newState.guild.id !== this.config.guildId) {
				return;
			}

			if (newState.channelId !== this.config.channelId) {
				this.logger.warn(
					'Bot voice state no longer matches target channel; scheduling rejoin. ' +
						JSON.stringify({
							currentChannelId: newState.channelId,
							targetChannelId: this.config.channelId
						})
				);
				this.scheduleReconnect('voice_state_mismatch');
			}
		});

		this.client.on('error', (error) => {
			this.logger.error('Discord client error. ' + stringifyUnknown(error));
			this.scheduleReconnect('join_failed');
		});

		this.client.on('shardDisconnect', (closeEvent, shardId) => {
			this.logger.warn(
				'Gateway shard disconnected. ' +
					JSON.stringify({
						shardId,
						code: closeEvent.code,
						reason: closeEvent.reason
					})
			);
			this.scheduleReconnect('join_failed');
		});

		this.client.on('shardReconnecting', () => {
			this.logger.warn('Gateway shard reconnecting...');
		});

		this.client.on('shardResume', (_replayed: number) => {
			this.logger.info('Gateway shard resumed. ' + JSON.stringify({ replayed: _replayed }));
			void this.ensureVoiceConnection('scheduled_reconnect');
		});

		this.client.on('invalidated', () => {
			this.logger.error('Client session invalidated. Token may be revoked.');
			void this.stop();
		});
	}

	private async ensureVoiceConnection(trigger: JoinTrigger): Promise<void> {
		if (this.stopping) {
			return;
		}

		try {
			const guild = await this.fetchGuild();
			const channel = await guild.channels.fetch(this.config.channelId);

			if (channel === null) {
				throw new Error(
					`Channel ${this.config.channelId} not found. Verify the ID and your account's access.`
				);
			}

			if (!isJoinableVoiceChannel(channel)) {
				const chType = (channel as { type?: string }).type ?? 'unknown';
				throw new Error(
					`Channel ${this.config.channelId} is type "${chType}", not a voice/stage channel.`
				);
			}

			const sameChannelAlreadyConnected =
				this.connection !== null &&
				this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
				this.connection.joinConfig.channelId === channel.id;

			if (sameChannelAlreadyConnected && this.connection !== null) {
				this.logger.debug(
					'Already connected to target channel; nothing to do.' +
						JSON.stringify({
							trigger
						})
				);
				return;
			}

			this.teardownConnection();

			const newConnection = joinVoiceChannel({
				guildId: guild.id,
				channelId: channel.id,
				selfDeaf: true,
				selfMute: false,
				adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator
			});

			this.connection = newConnection;
			this.bindVoiceConnectionEvents(newConnection);

			await entersState(newConnection, VoiceConnectionStatus.Ready, 20_000);

			this.backoff.reset();
			this.state = {
				phase: 'connected',
				connectedAt: new Date()
			};

			this.logger.info(
				'Connected to voice channel. ' +
					JSON.stringify({
						trigger,
						guildId: guild.id,
						channelId: channel.id
					})
			);
		} catch (error: unknown) {
			this.logger.error('Failed to establish voice connection. ' + stringifyUnknown(error));
			this.scheduleReconnect('join_failed');
		}
	}

	private bindVoiceConnectionEvents(connection: VoiceConnection): void {
		connection.on(VoiceConnectionStatus.Ready, () => {
			this.backoff.reset();
			this.state = {
				phase: 'connected',
				connectedAt: new Date()
			};
			this.logger.info('Voice connection is ready.');
		});

		connection.on(VoiceConnectionStatus.Disconnected, async () => {
			if (this.stopping) {
				return;
			}

			try {
				await Promise.race([
					entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
					entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
				]);
				this.logger.warn('Voice connection dropped but is recovering.');
				return;
			} catch {
				this.logger.warn('Voice connection disconnected; rejoin required.');
				this.teardownConnection();
				this.scheduleReconnect('voice_connection_disconnected');
			}
		});

		connection.on(VoiceConnectionStatus.Destroyed, () => {
			if (this.stopping) {
				return;
			}
			this.logger.warn('Voice connection destroyed.');
			this.scheduleReconnect('voice_connection_disconnected');
		});

		connection.on('error', (error) => {
			if (this.stopping) {
				return;
			}
			this.logger.error('Voice connection error. ' + stringifyUnknown(error));
			this.scheduleReconnect('voice_connection_error');
		});
	}

	private scheduleReconnect(reason: ReconnectReason): void {
		if (this.stopping) {
			return;
		}
		if (this.reconnectTimer !== null) {
			return;
		}

		const step = this.backoff.next();
		const scheduledFor = new Date(Date.now() + step.delayMs);
		this.state = {
			phase: 'reconnecting',
			reason,
			scheduledFor,
			attempt: step.attempt
		};

		this.logger.warn(
			'Scheduling reconnect. ' +
				JSON.stringify({
					reason,
					attempt: step.attempt,
					delayMs: step.delayMs
				})
		);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.ensureVoiceConnection('scheduled_reconnect');
		}, step.delayMs);
	}

	private async fetchGuild(): Promise<Guild> {
		try {
			return await this.client.guilds.fetch(this.config.guildId);
		} catch (error) {
			this.logger.error(
				'Could not fetch guild. ' +
					JSON.stringify({
						guildId: this.config.guildId,
						error: stringifyUnknown(error)
					})
			);
			this.scheduleReconnect('guild_fetch_failed');
			throw error;
		}
	}

	private teardownConnection(): void {
		if (this.connection === null) {
			return;
		}
		try {
			this.connection.removeAllListeners();
			this.connection.destroy();
		} catch (error: unknown) {
			this.logger.debug(
				'Swallowed error during connection teardown. ' + stringifyUnknown(error)
			);
		}
		this.connection = null;
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			this.logger.debug(
				'Heartbeat ' +
					JSON.stringify({
						phase: this.state.phase
					})
			);
		}, 60_000);
	}
}
