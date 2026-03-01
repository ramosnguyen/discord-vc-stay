import { bold, cyan, dim, green, red, yellow } from 'colorette';
import type { LogLevel } from './types';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

const colorize: Record<LogLevel, (s: string) => string> = {
	debug: cyan,
	info: green,
	warn: yellow,
	error: red
};

const LABELS: Record<LogLevel, string> = {
	debug: 'DBG',
	info: 'INF',
	warn: 'WRN',
	error: 'ERR'
};

interface LogMetadata {
	readonly [key: string]: unknown;
}

function serializeMetadata(metadata: LogMetadata | undefined): string {
	if (metadata === undefined) {
		return '';
	}
	try {
		return ` ${dim(JSON.stringify(metadata))}`;
	} catch {
		return ` ${dim('[unserializable metadata]')}`;
	}
}

export class Logger {
	public constructor(private readonly minimumLevel: LogLevel) {}

	public debug(message: string): void {
		this.write('debug', message);
	}

	public info(message: string): void {
		this.write('info', message);
	}

	public warn(message: string): void {
		this.write('warn', message);
	}

	public error(message: string): void {
		this.write('error', message);
	}

	private write(level: LogLevel, message: string): void {
		if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minimumLevel]) {
			return;
		}

		const color = colorize[level];
		const label = LABELS[level];
		const timestamp = new Date().toISOString();
		const line = `${dim(timestamp)} ${bold(color(label))} ${color(message)}`;

		if (level === 'error') {
			console.error(line);
			return;
		}
		if (level === 'warn') {
			console.warn(line);
			return;
		}
		console.log(line);
	}
}
