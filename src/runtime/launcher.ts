/** Keep macOS CoreBluetooth callbacks away from Python's partially torn-down
 * module globals. HA's main() returns only after runner/core shutdown, final
 * writes, execution-lock release and fault-file cleanup have completed.
 * Preserve the actual HA return code (including its requested restart=100).
 */
export const HA_LAUNCHER = `import os
import sys
from homeassistant.__main__ import main

# HA 2026.10 migrated HTTP YAML to a five-minute storage trial. A cold
# onboarding can outlast that trial; retry only our unchanged loopback port.
# Use HA's validated store API, never edit its .storage files from the plugin.
managed_port = int(os.environ["CQAI_HOME_MANAGED_PORT"])
if not 1024 <= managed_port <= 65535:
    raise RuntimeError("Invalid managed HTTP port")
from homeassistant.components import http as http_component
from homeassistant.components.http import config as http_config
original_load_http = http_config.async_load_config

def same_managed_http(config):
    return (isinstance(config, dict)
            and config.get("server_port") == managed_port
            and config.get("server_host") == ["127.0.0.1"])

async def load_managed_http(hass, config):
    store = await http_config.async_get_and_load_store(hass)
    pending = store.pending
    if isinstance(pending, dict) and pending.get("error"):
        if (pending.get("error") != "not_promoted"
                or not same_managed_http(pending)
                or hass.config.recovery_mode):
            raise RuntimeError("Managed HTTP trial does not match the owned loopback configuration")
        clean = {key: value for key, value in pending.items()
                 if key not in ("created_at", "error", "error_message")}
        await store.async_set_pending(clean)
    loaded = await original_load_http(hass, config)
    if not same_managed_http(loaded):
        raise RuntimeError("Managed HTTP listener must remain on its owned loopback port")
    return loaded

# __init__.py imports the function directly; replace both references before setup.
http_config.async_load_config = load_managed_http
http_component.async_load_config = load_managed_http

code = main()
if sys.platform == "darwin" and code in (0, 100):
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
sys.exit(code)
`
