import { formatValidationIssues, resolveCli } from './config';
import { Logger } from './logger';
import { VoiceStayService } from './voice-stay-service';

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

async function main(): Promise<void> {
	const resolution = resolveCli(process.argv.slice(2), process.env);

	if (resolution.kind === 'help') {
		console.log(resolution.helpText);
		return;
	}

	if (resolution.kind === 'error') {
		console.error(formatValidationIssues(resolution.issues));
		console.error('');
		console.error(resolution.helpText);
		process.exitCode = 1;
		return;
	}

	const logger = new Logger(resolution.config.logLevel);
	logger.info('Starting discord-vc-stay (selfbot).');

	const service = new VoiceStayService(resolution.config, logger);

	let shutdownStarted = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shutdownStarted) {
			return;
		}
		shutdownStarted = true;
		logger.warn(`Received ${signal}; shutting down...`);
		await service.stop();
	};

	process.on('SIGINT', () => {
		void shutdown('SIGINT');
	});

	process.on('SIGTERM', () => {
		void shutdown('SIGTERM');
	});

	process.on('unhandledRejection', (reason) => {
		logger.error('Unhandled promise rejection. ' + stringifyUnknown(reason));
	});

	process.on('uncaughtException', (error) => {
		logger.error('Uncaught exception. ' + stringifyUnknown(error));
		void shutdown('uncaughtException').finally(() => {
			process.exit(1);
		});
	});

	process.on('warning', (warning) => {
		logger.warn('Node.js process warning. ' + stringifyUnknown(warning));
	});

	try {
		await service.start();
	} catch (error: unknown) {
		logger.error('Service failed to start. ' + stringifyUnknown(error));
		process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error(`Fatal startup failure: ${stringifyUnknown(error)}`);
	process.exit(1);
});
