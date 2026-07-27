// Vitest global setup.
//
// ftp-srv (used by test/fixtures/ftp-server.mjs) registers a SIGTERM/SIGINT/
// SIGQUIT handler on `process` per server instance and never removes them on
// `close()`. Each integration test in this file starts and stops its own
// server, so a full run accumulates listeners well past Node's default cap
// of 10 and prints `MaxListenersExceededWarning`.
//
// This raises the ceiling — it does NOT fix the leak, which is upstream in
// ftp-srv and out of this package's control. The limit is bounded rather
// than 0/unlimited on purpose: unlimited would silently swallow a genuine
// listener leak introduced by our own code later, which is the opposite of
// what this warning is for. 50 is comfortably above what test/integration/
// ftp.test.mjs needs today (13 servers in one process) and leaves headroom
// for Task 10's SFTP suite running in the same process, while still being
// low enough to fire if something starts leaking far beyond what a test
// run's own server count would explain.
process.setMaxListeners(50);
