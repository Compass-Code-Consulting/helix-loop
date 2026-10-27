import { fileURLToPath } from 'node:url';

// The project the tool's tests run against: Acme Notes, a small product shaped like a real one (a spec with
// numbered requirements, a config with three repos), in test/fixtures/project/.helix/.
export const FIXTURE = fileURLToPath(new URL('./fixtures/project', import.meta.url));
