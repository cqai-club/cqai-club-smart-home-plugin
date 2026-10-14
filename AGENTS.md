# CQAI Club Smart Home

Independent DSH 0.2.0-rc.2 plugin. Use Node ^22.19 or >=24 and the pinned pnpm version.
Keep Home Assistant, Python, credentials, databases and logs outside the installed package.
Use only the plugin's managed environment for repair; never mutate system Python or existing HA instances.
Never expose refresh tokens, passwords or external credentials in client status, model tools or logs.
Tests use isolated temporary data and simulated devices. Real HA smoke uses a separate empty managed instance.
Do not control real devices or restart a user's running desktop application without explicit authorization.
Keep neighboring repositories unchanged unless an essential integration change is approved.
