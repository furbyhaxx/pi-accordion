/** One-shot completion signature shared by pi-ai's `complete` and the native-provider path. */
export type CompletionFunction = (
	model: any,
	context: { systemPrompt?: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
	options: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; maxTokens?: number },
) => Promise<any>;

interface NativeProvider {
	stream(model: any, context: { messages: unknown[] }, options: unknown): { result(): Promise<any> };
}

interface NativeProviderRegistry {
	getRegisteredNativeProvider?(providerId: string): NativeProvider | undefined;
}

/**
 * A completion that calls the extension-registered native Provider for `providerId` directly.
 * pig mirrors providers owned by Go extensions (pig-auth-plus antigravity) into the model registry
 * but not into the Node pi-ai API registry, so pi-ai's `complete` fails there with
 * "No API provider registered for api: ...". Undefined when no native provider is registered.
 */
export function nativeCompletion(registry: NativeProviderRegistry | undefined, providerId: string): CompletionFunction | undefined {
	const provider = registry?.getRegisteredNativeProvider?.(providerId);
	if (typeof provider?.stream !== "function") return undefined;
	return (model, context, options) => {
		// Provider-facing calls take a transcript: the system prompt is a leading system message (pi-ai normalizeContext).
		const messages = context.systemPrompt
			? [{ role: "system", content: context.systemPrompt, timestamp: 0 }, ...context.messages]
			: context.messages;
		return provider.stream(model, { messages }, options).result();
	};
}
