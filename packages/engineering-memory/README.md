# Engineering Memory Platform

The Engineering Memory Platform provides persistent memory, pattern recognition, experience tracking, and decision history for AURA's engineering intelligence. It sits above Mission Control, Engineering Diagnosis, Knowledge Fabric, and AI Code Intelligence, providing a learning layer that accumulates engineering experience from real project history.

## Installation

This package is automatically included as a dependency of `@aura/ai-service`. No separate installation is required.

## Usage

```typescript
import { engineeringMemoryApi } from '@aura/engineering-memory';

// Create a memory
const memory = engineeringMemoryApi.createMemory({
  projectId: 'my-project',
  category: 'mission-created',
  summary: 'New mission created',
  detailedRecord: 'Full details...',
  relatedFiles: ['src/index.ts'],
  tags: ['mission'],
});

// Query memories
const memories = engineeringMemoryApi.queryMemories({
  projectIds: ['my-project'],
  categories: ['mission-created'],
  limit: 10,
});

// Search engineering memory
const results = engineeringMemoryApi.searchEngineeringMemory({
  query: 'authentication',
  projectIds: ['my-project'],
  limit: 5,
});
```

## Architecture

The Engineering Memory Platform is organized into 12 parts:

1. **Engineering Memory** - Persistent storage of engineering events
2. **Pattern Engine** - Detection and management of recurring patterns
3. **Experience Engine** - Tracking engineering experience by domain
4. **Decision Memory** - Storage of engineering decisions
5. **Bug Memory** - Storage of bug diagnoses and outcomes
6. **Mission Memory** - Storage of mission records
7. **Project Timeline** - Chronological record of engineering events
8. **Engineering Search** - Semantic search across all memories
9. **Prediction Foundation** - Infrastructure for future prediction
10. **Memory Graph** - Graph connecting all engineering entities
11. **Engineering Insights** - Automatic insight generation
12. **Public APIs** - Clean, modular APIs for integration

## Core Principles

- **Grounded in Reality:** Every memory comes from real engineering work
- **Queryable:** Everything is searchable, filterable, and retrievable
- **Persistent:** All knowledge survives restarts
- **Integrated:** Seamless integration with existing AURA systems
- **Non-Invasive:** Does not modify existing systems, only exposes APIs
- **Production Quality:** Built for professional engineering teams

## Data Storage

All data is stored in `~/.aura/engineering-memory/` with the following structure:

```
~/.aura/engineering-memory/
├── <projectId>/
│   ├── <memoryId>.json       # Memory records
│   ├── index.json            # Memory index
│   ├── patterns/             # Pattern records
│   │   └── <patternId>.json
│   ├── experience/           # Experience records
│   │   └── <domain>.json
│   ├── decisions/            # Decision records
│   │   └── <decisionId>.json
│   ├── bugs/                 # Bug records
│   │   └── <bugId>.json
│   ├── missions/             # Mission records
│   │   └── <missionId>.json
│   └── timeline/             # Timeline events
│       └── <eventId>.json
```

## API Reference

See [Engineering Memory Architecture Documentation](../../docs/architecture/ENGINEERING_MEMORY_ARCHITECTURE.md) for complete API reference.

## Integration

The Engineering Memory Platform integrates with existing AURA systems through event listeners:

- **Mission Control:** Records mission creation, completion, and failures
- **Diagnosis Engine:** Records diagnosis events and outcomes
- **Knowledge Fabric:** Records knowledge updates and connects to memory graph

## License

Part of AURA Hub - see main [LICENSE](../../LICENSE) for details.
