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
	| 'health_check'
	| 'scheduled_reconnect'
	| 'voice_state_mismatch'
	| 'voice_connection_disconnected';
type ReconnectReason =
	| 'join_failed'
	| 'member_fetch_failed'
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
	private ensureVoiceConnectionTask: Promise<void> | null = null;
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
			if (this.ensureVoiceConnectionTask !== null) {
				this.logger.debug(
					'Ignoring voice state mismatch while a rejoin is already in progress.' +
						JSON.stringify({
							currentChannelId: newState.channelId,
							targetChannelId: this.config.channelId
						})
				);
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
		if (this.ensureVoiceConnectionTask !== null) {
			this.logger.debug(
				'Voice connection ensure already running; skipping duplicate trigger.' +
					JSON.stringify({
						trigger
					})
			);
			return this.ensureVoiceConnectionTask;
		}

		const task = this.performEnsureVoiceConnection(trigger).finally(() => {
			this.ensureVoiceConnectionTask = null;
		});
		this.ensureVoiceConnectionTask = task;
		return task;
	}

	private async performEnsureVoiceConnection(trigger: JoinTrigger): Promise<void> {
		this.clearReconnectTimer();

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

			const currentVoiceChannelId = await this.fetchSelfVoiceChannelId(guild);
			const connectionStatus = this.connection?.state.status ?? 'none';
			const connectionChannelId = this.connection?.joinConfig.channelId ?? null;
			const readyConnectionToTarget = this.hasHealthyConnection(channel.id);

			if (readyConnectionToTarget && currentVoiceChannelId === channel.id) {
				this.logger.debug(
					'Voice session already healthy; nothing to do.' +
						JSON.stringify({
							trigger,
							connectionStatus,
							connectionChannelId,
							currentVoiceChannelId,
							targetChannelId: channel.id
						})
				);
				return;
			}

			if (this.connection !== null || currentVoiceChannelId !== channel.id) {
				this.logger.warn(
					'Refreshing voice session.' +
						JSON.stringify({
							trigger,
							connectionStatus,
							connectionChannelId,
							currentVoiceChannelId,
							targetChannelId: channel.id
						})
				);
			}

			this.teardownConnection();

			const newConnection = joinVoiceChannel({
				guildId: guild.id,
				channelId: channel.id,
				selfDeaf: false,
				selfMute: true,
				adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator
			});

			this.connection = newConnection;
			this.bindVoiceConnectionEvents(newConnection);

			await entersState(newConnection, VoiceConnectionStatus.Ready, 20_000);

			const joinedVoiceChannelId = await this.fetchSelfVoiceChannelId(guild);
			if (joinedVoiceChannelId !== channel.id) {
				throw new Error(
					`Voice connection became ready but current voice state is ${joinedVoiceChannelId ?? 'null'} instead of ${channel.id}.`
				);
			}

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
			this.teardownConnection();
			this.logger.error('Failed to establish voice connection. ' + stringifyUnknown(error));
			this.scheduleReconnect('join_failed');
		}
	}

	private bindVoiceConnectionEvents(connection: VoiceConnection): void {
		connection.on('stateChange', (oldState, newState) => {
			this.logger.debug(
				'Voice connection state changed. ' +
					JSON.stringify({
						from: oldState.status,
						to: newState.status
					})
			);
		});

		connection.on(VoiceConnectionStatus.Ready, () => {
			if (this.stopping || this.connection !== connection) {
				return;
			}
			this.backoff.reset();
			this.state = {
				phase: 'connected',
				connectedAt: new Date()
			};
			this.logger.info('Voice connection is ready.');
		});

		connection.on(VoiceConnectionStatus.Disconnected, async () => {
			if (this.stopping || this.connection !== connection) {
				return;
			}

			try {
				await Promise.race([
					entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
					entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
				]);
				if (this.stopping || this.connection !== connection) {
					return;
				}
				this.logger.warn('Voice connection dropped but is recovering.');
				return;
			} catch {
				if (this.stopping || this.connection !== connection) {
					return;
				}
				this.logger.warn('Voice connection disconnected; rejoin required.');
				this.teardownConnection();
				this.scheduleReconnect('voice_connection_disconnected');
			}
		});

		connection.on(VoiceConnectionStatus.Destroyed, () => {
			if (this.stopping || this.connection !== connection) {
				return;
			}
			this.logger.warn('Voice connection destroyed.');
			this.scheduleReconnect('voice_connection_disconnected');
		});

		connection.on('error', (error) => {
			if (this.stopping || this.connection !== connection) {
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

	private clearReconnectTimer(): void {
		if (this.reconnectTimer === null) {
			return;
		}
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
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

	private async fetchSelfVoiceChannelId(guild: Guild): Promise<string | null> {
		try {
			const member = await guild.members.fetchMe({
				force: true
			});
			return member.voice.channelId ?? null;
		} catch (error) {
			this.logger.error(
				'Could not fetch current member voice state. ' +
					JSON.stringify({
						guildId: guild.id,
						error: stringifyUnknown(error)
					})
			);
			throw error;
		}
	}

	private hasHealthyConnection(channelId: string): boolean {
		return (
			this.connection !== null &&
			this.connection.state.status === VoiceConnectionStatus.Ready &&
			this.connection.joinConfig.channelId === channelId
		);
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
			const connectionStatus = this.connection?.state.status ?? 'none';
			this.logger.debug(
				'Heartbeat ' +
					JSON.stringify({
						phase: this.state.phase,
						connectionStatus,
						reconnectScheduled: this.reconnectTimer !== null,
						ensureInFlight: this.ensureVoiceConnectionTask !== null
					})
			);
			void this.runHealthCheck();
		}, 60_000);
	}

	private async runHealthCheck(): Promise<void> {
		if (
			this.stopping ||
			this.client.user === null ||
			this.ensureVoiceConnectionTask !== null ||
			this.reconnectTimer !== null
		) {
			return;
		}

		try {
			const guild = await this.fetchGuild();
			const currentVoiceChannelId = await this.fetchSelfVoiceChannelId(guild);
			if (
				this.hasHealthyConnection(this.config.channelId) &&
				currentVoiceChannelId === this.config.channelId
			) {
				return;
			}

			this.logger.warn(
				'Health check detected a stale voice session; forcing rejoin.' +
					JSON.stringify({
						connectionStatus: this.connection?.state.status ?? 'none',
						connectionChannelId: this.connection?.joinConfig.channelId ?? null,
						currentVoiceChannelId,
						targetChannelId: this.config.channelId
					})
			);
			await this.ensureVoiceConnection('health_check');
		} catch (error) {
			if (this.stopping) {
				return;
			}
			this.logger.error('Voice health check failed. ' + stringifyUnknown(error));
			this.scheduleReconnect('member_fetch_failed');
		}
	}
}
