# ADR-0018: UI follows the Heimdall theme

**Context.** Students and staff already use Heimdall (the college's proctoring app). The college asked for the same look.

**Decision.** Dark UI on web and mobile. Near-black background (#0b0c0e) and cards (#101114) with 1px borders (#26282c) and 20px radius. White headings, grey secondary text (#a3a8ae), green accent (#34c77b) for primary and success states, green-on-dark-green icon tiles, orange gradient only on the logo mark. Font: self-hosted Figtree on the web (no third-party font requests; CSP stays `'self'`); platform default on mobile. The classroom QR stays black on white for scan reliability.

**Consequences.** Tokens live in `web/src/styles.css` and `app/lib/src/theme.dart`; keep them in sync.
