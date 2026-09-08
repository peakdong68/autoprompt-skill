import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Private v2 source resource. The external controller binds role prompts.
// Do not register automatic activation, commands, or unverified RLM dispatch.
export default function autoprompt(_pi: ExtensionAPI): void {}
