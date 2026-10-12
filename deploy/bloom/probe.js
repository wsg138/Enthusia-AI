// Bloom generic Node.js egg limits MAIN FILE to <=16 characters.
// This minimal wrapper uses the separately uploaded safe probe module.
(async () => {
  const { runProbe } = await import('./probe-node-generic.mjs');
  const report = await runProbe();
  console.log(JSON.stringify(report, null, 2));
})().catch(() => {
  console.error('Bloom capability probe could not finish safely.');
  process.exitCode = 1;
});
