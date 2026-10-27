# Acme Notes — Technical Product Specification

A small fixture product for Helix Loop's own tests: a shared notes app with a public website and docs.
It is never built; its spec only has to be shaped the way a real Helix Spec is.

## 0. Building from this spec

Builders read only the sections their task cites, plus the glossary.
Requirements are numbered; a task's acceptance tests are named for the requirements they prove.

## 1. Overview

Acme Notes lets a small team write notes, share them in a workspace, and publish a note as a public page.

## 2. Glossary

- **Workspace:** a team's shared space; every note belongs to one.
- **Note:** a Markdown document with a title, owned by a member of its workspace.
- **Published page:** a note's read-only public copy at its own URL.

## 10. Platform

The app is one TypeScript service with a Postgres database and a job queue.

### 10.1 Configuration

- **PLT-1** Every setting is read from the environment once at start-up, and the service refuses to start without a required one.
- **PLT-2** A missing optional setting falls back to a documented default.

### 10.5 Background jobs

- **PLT-3** A job that fails is retried three times with backoff before it is reported.
- **PLT-4** Jobs are idempotent: running one twice has the effect of running it once.

## 11. Publishing

A member publishes a note as a public page and can unpublish it at any time.

### Requirements

- **PB-1** A member can publish a note they own; the page shows its title and body.
- **PB-2** Unpublishing removes the page within one minute.
- **PB-14** Publishing a note twice keeps one page at the same URL.
  The page's URL never changes while the note exists.
- **PB-15** A published page has no editing controls and no workspace data beyond the note.

### Sharing

- **PB-20** A member can copy a published page's link from the note.

## 15. Stack

TypeScript, Node, Postgres, a React front end, and Playwright for end-to-end tests.

## 19. Navigation

- **NAV-1** The workspace's notes are listed newest first, with a search box.
- **NAV-2** Every screen has a URL that opens it directly.

## 24. Operations

- **OPS-1** Every service exposes a health check that reports its version and its database's reachability.
- **OPS-2** Logs are structured and never contain a note's body.

## Appendix A. Definitions of done

A task is done when its acceptance tests pass in the full check and its code is reachable from an entry point.

## Appendix B. Changelog

| Version | Date | Change |
| --- | --- | --- |
| v1.0 | 2026-10-27 | First version, for Helix Loop's tests. |
