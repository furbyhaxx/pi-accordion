/**
 * What a missing privacy consent does to an attached conductor.
 *
 * A conductor whose deterministic work does not need a model call keeps running: its tools stay,
 * and only the model-backed operations wait. Everything else must come off with the consent,
 * because attaching it without consent would leave the session with no working function at all.
 */

/** The slice of a registry entry the policy reads. */
export interface PrivacyShape {
	privacy?: { deferred?: boolean } | undefined;
}

/** `attach-and-gate`: attach now, gate the model work. `consent-first`: do not attach. */
export function attachPolicy(entry: PrivacyShape | undefined): "attach-and-gate" | "consent-first" {
	return entry?.privacy?.deferred === true ? "attach-and-gate" : "consent-first";
}

/** `gate-models`: stay attached with model work gated. `detach`: release the conductor. */
export function revocationEffect(entry: PrivacyShape | undefined): "gate-models" | "detach" {
	return entry?.privacy?.deferred === true ? "gate-models" : "detach";
}
