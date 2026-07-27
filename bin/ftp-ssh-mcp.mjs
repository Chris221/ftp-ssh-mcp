#!/usr/bin/env node
import { main } from "../src/server.mjs";

main().catch((e) => {
  console.error("Fatal error starting ftp-ssh-mcp:", e?.message || e);
  process.exit(1);
});
