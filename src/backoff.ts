export interface ExponentialBackoffPolicy {
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly jitterRatio: number;
}

export interface BackoffStep {
	readonly attempt: number;
	readonly delayMs: number;
}

const DEFAULT_POLICY: ExponentialBackoffPolicy = {
	baseDelayMs: 2_000,
	maxDelayMs: 60_000,
	jitterRatio: 0.2
};

export class ExponentialBackoff {
	private attemptCount = 0;
	private readonly policy: ExponentialBackoffPolicy;

	public constructor(policy: Partial<ExponentialBackoffPolicy> = {}) {
		this.policy = {
			...DEFAULT_POLICY,
			...policy
		};
	}

	public next(): BackoffStep {
		const attempt = this.attemptCount + 1;
		const pureDelay = Math.min(
			this.policy.baseDelayMs * 2 ** this.attemptCount,
			this.policy.maxDelayMs
		);
		const jitterWindow = Math.floor(pureDelay * this.policy.jitterRatio);
		const jitter =
			jitterWindow === 0 ? 0 : Math.floor(Math.random() * jitterWindow * 2 - jitterWindow);
		const delayMs = Math.max(0, pureDelay + jitter);
		this.attemptCount += 1;
		return {
			attempt,
			delayMs
		};
	}

	public reset(): void {
		this.attemptCount = 0;
	}
}
