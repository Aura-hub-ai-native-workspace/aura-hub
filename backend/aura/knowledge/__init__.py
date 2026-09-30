"""Organizational Knowledge Base — local document ingestion and retrieval (S8–S9).

Design principles:
- Local only: no content is sent to cloud search or embedding services
- Two-tier retrieval: BM25 keyword search (zero dependencies) + optional
  vector embedding search (requires a local embedding model via Ollama)
- Persistent: the index survives process restart via a JSON+flat-file store
- Honest attribution: every retrieved chunk carries its source document path
  and position so citations are verifiable

Usage:
    from aura.knowledge import KnowledgeBase
    kb = KnowledgeBase(store_dir='~/.aura/knowledge')
    kb.add_document('doc.pdf', ingestor.ingest('doc.pdf'))
    results = kb.search('invoice approval process')
"""

from .store import KnowledgeBase, SearchResult, DocumentRecord

__all__ = ["KnowledgeBase", "SearchResult", "DocumentRecord"]
