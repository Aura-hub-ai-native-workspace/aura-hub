/**
 * Differential driver — feeds cases to the REAL bundled TypeScript
 * implementations and returns their outputs.
 *
 * Input  (stdin): {"func":"fingerprint"|"graphHash"|"policy","cases":[...]}
 * Output (stdout): {"results":[...]}   (same order)
 *
 * The bundles are built ONCE by the pytest session fixture directly from the
 * genuine sources using the repo's own esbuild — no transcription, no
 * reimplementation on this side of the comparison.
 */

const fabric = await import(process.env.TSREF_FABRIC_INDEX);
const versions = await import(process.env.TSREF_VERSIONS);

let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { payload += chunk; });
process.stdin.on('end', () => {
  const { func, cases } = JSON.parse(payload);
  const results = cases.map((c) => {
    if (func === 'fingerprint') {
      return fabric.fingerprintInvocation(c.capabilityId, c.input, c.context);
    }
    if (func === 'graphHash') {
      return versions.hashGraph(c.nodes, c.edges);
    }
    if (func === 'policy') {
      const config = fabric.sanitizePolicy(c.raw);
      const evaluation = fabric.evaluatePolicy({
        capability: c.capability,
        config,
        granted: c.granted,
        nodeAvailable: c.nodeAvailable,
        subject: c.subject ?? undefined,
      });
      return { policy: config, evaluation };
    }
    throw new Error(`unknown func: ${func}`);
  });
  process.stdout.write(JSON.stringify({ results }));
});
