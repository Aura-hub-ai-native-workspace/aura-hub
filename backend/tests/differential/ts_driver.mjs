/**
 * Differential driver — feeds cases to the REAL bundled TypeScript
 * implementations and returns their digests.
 *
 * Input  (stdin): {"func":"fingerprint"|"graphHash","cases":[...]}
 * Output (stdout): {"digests":["…", ...]}   (same order)
 *
 * The bundles are built ONCE by the pytest session fixture directly from
 * packages/capability-fabric/src/fabric.ts and
 * packages/ai-service/src/workflow/versions.ts using the repo's own esbuild —
 * no transcription, no reimplementation on this side of the comparison.
 */

const fabric = await import(process.env.TSREF_FABRIC);
const versions = await import(process.env.TSREF_VERSIONS);

let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { payload += chunk; });
process.stdin.on('end', () => {
  const { func, cases } = JSON.parse(payload);
  const digests = cases.map((c) => {
    if (func === 'fingerprint') {
      return fabric.fingerprintInvocation(c.capabilityId, c.input, c.context);
    }
    if (func === 'graphHash') {
      return versions.hashGraph(c.nodes, c.edges);
    }
    throw new Error(`unknown func: ${func}`);
  });
  process.stdout.write(JSON.stringify({ digests }));
});
