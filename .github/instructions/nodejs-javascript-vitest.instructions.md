---
description: 'Guidelines for writing Node.js and JavaScript code with Vitest testing'
applyTo: '**/*.js, **/*.mjs, **/*.cjs'
---

# Node.js / JavaScript Code Generation Guidelines

## Language & Runtime

- Target **ES2022+** with **Node.js 20+** unless the project specifies otherwise
- Use **ESM** (`import`/`export`) by default; use `require`/`module.exports` only when the project is explicitly CommonJS
- Prefer `async`/`await` over raw Promises or callbacks
- Use `undefined` instead of `null` when representing the absence of a value
- Prefer named exports over default exports for better IDE support and refactoring
- Prefer functions over classes except when encapsulating state that benefits from OOP
- Use `const` by default; `let` when reassignment is required; never `var`

## Code Style

- Keep functions small, focused, and pure where possible
- Use descriptive variable and function names
- Destructure objects and arrays when it improves clarity
- Use template literals over string concatenation
- Prefer early returns over deeply nested conditionals

## Error Handling

- Always handle errors from async operations
- Use typed error classes or error codes for distinguishable failure modes
- Propagate errors to callers rather than swallowing them silently
- Ensure resources (streams, handles, connections) are released in `finally` blocks or equivalent

## File I/O & System

- Use the `node:fs/promises` API for file operations; avoid synchronous variants (`readFileSync`, etc.) in production code paths
- Prefer `node:path` utilities over manual string concatenation for paths
- Validate user-supplied paths before using them in file system operations

## Testing (Vitest)

> **Project note:** This project uses Node.js's built-in `node:test` runner, not Vitest. Apply the structural principles below; substitute `node:test` / `node:assert` APIs for Vitest APIs.

- Write tests in separate files co-located with or alongside the source they test
- Name test files `*.test.js` (or `*.test.ts` for TypeScript)
- Structure tests with `describe` blocks grouping related behaviour
- Use `it`/`test` for individual cases with descriptive names
- Favour **unit tests** for pure functions; use integration tests sparingly at system boundaries
- Mock external I/O (file system, network) rather than calling them from unit tests
- Assert the most specific property that verifies the behaviour

## Documentation

- Update **README.md** when:
  - Adding new features or changing existing ones
  - Changing configuration options or environment variables
  - Modifying installation or setup procedures
  - Adding or removing CLI commands
- Update **CHANGELOG.md** with a concise entry for every user-visible change
- Include JSDoc comments on exported functions when the signature is non-obvious
