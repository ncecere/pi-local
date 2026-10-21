import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { registerChoice } from "./models.ts";
import type { UsageReporter } from "./usage.ts";

/**
 * Models the person chose for single conversations (in the composer), besides the agent's own. Each is fetched from
 * the platform the first time a conversation asks for it (`GET /models/env?id=`), registered as
 * `choice:<catalog provider>`, and fetched again after a few minutes (a provider's key may have changed).
 */
export const CHOICE_PREFIX = "choice:";
const REFRESH_MS = 5 * 60_000;

export type ChoiceOptions = {
	models: MutableModels;
	gatewayUrl: string;
	key: string;
	/** Counted usage goes to the platform with this key (the agent's MODEL_USAGE_KEY). */
	usageKey?: string;
	fetch?: typeof fetch;
};

export class ModelChoices {
	private readonly loaded = new Map<string, { at: number; ref: Promise<ModelRef> }>();
	private readonly reporters = new Map<string, UsageReporter>();
	private readonly doFetch: typeof fetch;

	constructor(private readonly options: ChoiceOptions) {
		this.doFetch = options.fetch ?? fetch;
	}

	/** The catalog id ("provider/modelId") a choice's ref stands for, or undefined for any other model. */
	static catalogIdOf(ref: ModelRef | undefined): string | undefined {
		if (!ref?.provider.startsWith(CHOICE_PREFIX)) return undefined;
		return `${ref.provider.slice(CHOICE_PREFIX.length)}/${ref.modelId}`;
	}

	/** The registered model for a catalog id; rejects when the platform won't give it (turned off, removed). */
	ref(catalogId: string): Promise<ModelRef> {
		const now = Date.now();
		const cached = this.loaded.get(catalogId);
		if (cached && now - cached.at < REFRESH_MS) return cached.ref;
		const ref = this.load(catalogId);
		this.loaded.set(catalogId, { at: now, ref });
		ref.catch(() => this.loaded.delete(catalogId));
		return ref;
	}

	private async load(catalogId: string): Promise<ModelRef> {
		const slash = catalogId.indexOf("/");
		if (slash <= 0 || slash === catalogId.length - 1) throw new Error(`not a model id: ${catalogId}`);
		const base = this.options.gatewayUrl.replace(/\/$/, "");
		const res = await this.doFetch(`${base}/models/env?id=${encodeURIComponent(catalogId)}`, {
			headers: { authorization: `Bearer ${this.options.key}` },
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await res.json().catch(() => undefined)) as { data?: { env?: Record<string, string> }; error?: { message?: string } } | undefined;
		const env = body?.data?.env;
		if (!res.ok || !env) throw new Error(body?.error?.message ?? `the platform refused the model (status ${res.status})`);
		const usageKey = this.options.usageKey;
		const { model, usage } = registerChoice(
			this.options.models,
			{ ...env, ...(usageKey && env.MODEL_USAGE_URL ? { MODEL_USAGE_KEY: usageKey } : {}) },
			CHOICE_PREFIX + catalogId.slice(0, slash),
		);
		// The model the provider knows may be named as in the catalog id; the ref is what the registry has.
		const previous = this.reporters.get(catalogId);
		if (usage) this.reporters.set(catalogId, usage);
		void previous?.flush();
		return model;
	}

	/** Sends the usage still pending (when the agent stops). */
	async flush(): Promise<void> {
		await Promise.all([...this.reporters.values()].map((r) => r.flush()));
	}
}
