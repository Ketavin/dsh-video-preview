# DSH rc.2 adaptation

This candidate extends the existing Files viewer registry and introduces no rail entry.
Document Workbench, Office, Excel and Doc Reader retain their existing claims.

The route now resolves the working directory from attached or persisted Host session
data, rejects unknown sessions, canonicalizes both root and target, and streams an
opened file handle. Browser-provided cwd never grants access. The same private stream
supports downloads larger than the Sidebar media cap. HTTP range policy is explicit
in README. Trust remains DSH's Host/Origin/fetch-site fence, not account authentication.

The client removes media sources on teardown and presents an error/download fallback.
Native tests run the actual DSH rc.2 composition, candidate Sidebar and this bundle in
Chromium: play, seek, 206, dark/narrow, close/unload and unsupported codec fallback.
The external isolated verification directory retains logs, screenshots and loaded
bundle hashes. A polluted first test Profile selected Sidebar's older Core peer tree;
pinning all Core packages to the candidate source repaired the test environment.
This is why final installed and served hashes, not version labels, remain required.

Limitations: not an OS filesystem sandbox against hostile concurrent local writers;
no transcoding; no identity/session authorization claim beyond the existing DSH trust
model; final full-Profile regression and production approval remain pending.
