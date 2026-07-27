// Shared test helper for exercising capability modules end to end.
//
// Builds the same `ctx` shape the real server hands to `capability.register`,
// runs `selectCapabilities` for a given config, and registers every selected
// capability's tools against it. Tests get back the tool names in
// registration order plus a `run(name, args)` that invokes a handler and
// resolves to `{ error }` instead of throwing, so assertions on error
// messages don't need try/catch.
//
// Task 9's integration tests import this same helper rather than building
// their own ctx, so the plumbing lives in exactly one place.

import { selectCapabilities } from "../../src/capabilities/index.mjs";

export function buildTools(config, { withClient } = {}) {
  const names = [];
  const handlers = new Map();

  const ctx = {
    config,
    register(name, _toolConfig, handler) {
      names.push(name);
      handlers.set(name, handler);
    },
    text(body) {
      return { content: [{ type: "text", text: body }] };
    },
    withClient(fn, override) {
      if (!withClient) {
        throw new Error(
          "buildTools: this test's ctx has no withClient stub, but a tool tried to use one. " +
            "Pass { withClient } to buildTools to stub it."
        );
      }
      return withClient(fn, override);
    },
  };

  for (const capability of selectCapabilities(config)) capability.register(ctx);

  async function run(name, args) {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No such tool registered: ${name}`);
    try {
      return await handler(args);
    } catch (err) {
      return { error: err.message };
    }
  }

  return { names, run };
}
