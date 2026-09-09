"""Compatibility entry: v2 physical dispatch belongs to the external controller."""

ACTIVATION = "autoprompt activate prime --target <absolute-project> -- <request>"

def bind(*args, **kwargs):
    raise RuntimeError("PROVIDER_UNSUPPORTED: v1 bindings are retired; use " + ACTIVATION)

async def dispatch(*args, **kwargs):
    raise RuntimeError("PROVIDER_UNSUPPORTED: direct RLM dispatch is retired; use " + ACTIVATION)
