/**
 * agent — governed agency.
 * ==================================================================
 * A bounded plan → act → observe loop whose only actuators are Capability
 * Fabric capabilities, and which ships behind a single switch that
 * defaults OFF and cannot be armed without a durable record.
 *
 * The pieces, and which question each answers:
 *
 *   flag.ts        may a run start at all?          (one switch, one answer)
 *   ladder.ts      how bold may AURA be?            (a PolicyConfig preset)
 *   limits.ts      how far may this run go?         (counters, not requests)
 *   killSwitch.ts  stop — and stay stopped.
 *   checkpoint.ts  what was here before I changed it?
 *   toolBroker.ts  a model named something. Is it real, and may it happen?
 *   journal.ts     what happened, reconstructible without this process.
 *   budget.ts      what may a sub-agent have? (strictly less. never equal.)
 *   loop.ts        the controller that enforces all of the above.
 *
 * Nothing here is a second authority. Policy is `capability-fabric/policy`,
 * execution is `fabric.invoke`, the record of what ran is the Fabric's
 * audit trail, and the node catalogue, DAG builder and approval store are
 * untouched. What this module adds is a control flow, and the bounds on it.
 */

export * from './types';
export * from './flag';
export * from './ladder';
export * from './limits';
export * from './killSwitch';
export * from './journal';
export * from './checkpoint';
export * from './toolBroker';
export * from './budget';
export * from './loop';
