## 10. Platform

The app is one TypeScript service with a Postgres database and a job queue.

### 10.1 Configuration

- **PLT-1** Every setting is read from the environment once at start-up, and the service refuses to start without a required one.
- **PLT-2** A missing optional setting falls back to a documented default.

### 10.5 Background jobs

- **PLT-3** A job that fails is retried three times with backoff before it is reported.
- **PLT-4** Jobs are idempotent: running one twice has the effect of running it once.
