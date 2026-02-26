# Ageless Literature

Full-stack multi-vendor marketplace for rare books and collectibles — featuring live auctions, real-time messaging, Stripe Connect payouts, and role-based access for admins, vendors, and collectors.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS |
| Backend | Node.js, Express, PostgreSQL, Sequelize, Redis |
| Payments | Stripe Connect (vendor payouts), PayPal |
| Real-time | Socket.IO with Redis adapter |
| Search | MeiliSearch |
| Email / SMS | SendGrid, Twilio (TCPA-compliant) |
| DevOps | Docker, Bitbucket Pipelines CI/CD |

## Code Tour

| Path | What to look at |
|------|----------------|
| `apps/api/src/controllers/` | Express route handlers — auctions, orders, payouts, auth |
| `apps/api/src/services/` | Business logic — payout engine, auction lifecycle, email/SMS |
| `apps/api/src/models/` | 27 Sequelize models with associations |
| `apps/api/src/sockets/` | Socket.IO chat and notification handlers |
| `apps/web/src/app/` | Next.js App Router pages (buyer, vendor, admin dashboards) |
| `apps/web/src/components/` | Reusable React components (product cards, modals, forms) |
| `tests/` | Unit, integration (API + Socket.IO), and Playwright E2E tests |
| `docker-compose*.yml` | Multi-environment Docker setup (local, remote, prod) |

## Project Structure

```
apps/
├── api/          # Express API server
│   └── src/
│       ├── controllers/   # Route handlers
│       ├── models/        # Sequelize models
│       ├── routes/        # Route definitions + webhooks
│       ├── services/      # Business logic
│       ├── sockets/       # Real-time messaging
│       └── middleware/    # Auth, rate limiting, validation
└── web/          # Next.js frontend
    └── src/
        ├── app/           # Pages (App Router)
        ├── components/    # UI components
        └── lib/           # API client, hooks, utilities
tests/
├── unit/         # Pure logic tests
├── integration/  # API endpoint + Socket tests
├── e2e/          # Playwright browser tests
└── mocks/        # SendGrid, Stripe, Twilio mocks
```

## Notes

This repo is sanitized for public viewing. Secrets have been removed and replaced with placeholders — see `.env.example` for the full configuration schema. The app is not intended to be run from this repo; it's here to demonstrate code quality and architecture.

