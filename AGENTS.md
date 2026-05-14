## Code Conventions

- Order functions from high-level to low-level within a file: exported (public) functions first, internal helpers last.
- In tests, mark phases with `// given:`, `// when:`, and `// then:` comments to separate setup, execution, and verification clearly.
- Use `console.log` for program output (results, summaries, UI elements). Use `console.error` for diagnostics (errors, warnings, status notices). Never use `console.warn`.

## Commands

- `npm run fix -- --unsafe` : Format, Fix lint errors
- `npm run check` : Run lint, tsc, test
- `npm run test -- <file>` : Run a specific test file
