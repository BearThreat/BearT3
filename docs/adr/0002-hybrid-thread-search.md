# ADR 0002: Hybrid thread search

Status: accepted

## Objective and constraints

BearT3 thread search must retrieve exact text and meaning-based matches through the existing web,
desktop, and mobile flow. Conversation text stays on the environment that owns it. Search must keep
working when the optional search process is absent, slow, or incompatible with a future T3 core.

## Decision

Keep BearT3's exact substring query authoritative. A thin adapter sends a bounded snapshot of active
thread documents to a loopback-only `thread-search-service`. The sidecar maintains a disposable
SQLite FTS5 and embedding index, runs exact, BM25, and semantic retrieval, and combines those lists
with reciprocal-rank fusion. BearT3 fuses that response with its exact list, weighting core results
twice as strongly.

The sidecar does not read BearT3's database, consume its events, own startup, or change the client
contract. The adapter has a 900 ms deadline and rejects unknown thread IDs and incompatible contract
versions. Any failure returns the exact list unchanged. A future core rebase can therefore lose
enhanced ranking without losing search or server startup.

## Systems considered

- **LanceDB** is the closest plug-and-play embedded option. Its JavaScript SDK supports local tables,
  vector search, BM25 full-text indexes, hybrid queries, and RRF. We kept SQLite FTS5 plus Ollama to
  minimize dependencies and make the disposable index easy to inspect and rebuild.
- **SQLite FTS5 plus sqlite-vec** keeps both indexes beside the projection. FTS5 is built into the
  SQLite amalgamation and supplies BM25. `sqlite-vec` has Node packages and broad platform builds,
  but its current releases are still alpha and fusion remains application code.
- **Typesense** has built-in keyword/vector fusion and adjustable weighting. It requires another
  long-running service and replicated thread documents.
- **Meilisearch** generates and caches embeddings and supports hybrid search. It also requires a
  separate service and index lifecycle.
- **Qdrant** has dense/sparse hybrid queries and server-side RRF. Its operational footprint is aimed
  at larger vector collections than BearT3 thread search needs.

## Verification

Focused tests cover index persistence, exact and BM25 retrieval without embeddings, adapter contract
validation, unknown-result filtering, hybrid fusion, active-thread filtering, and exact fallback.
A live probe covers the HTTP contract and semantic retrieval when Ollama is available.

## Research record

Queries run on 2026-08-20:

1. `official SQLite vector search extension sqlite-vec hybrid search full text documentation`
2. `official LanceDB JavaScript hybrid search BM25 vector documentation embedded database`
3. `official Typesense hybrid search vector keyword search documentation self hosted`
4. `official Meilisearch hybrid search embedder documentation self hosted`
5. `site:github.com/asg017/sqlite-vec official npm node sqlite vec extension`
6. `site:sqlite.org/fts5.html FTS5 bm25 official documentation`
7. `site:qdrant.tech/documentation hybrid search reciprocal rank fusion official`

Primary references:

- [LanceDB hybrid search](https://docs.lancedb.com/search/hybrid-search)
- [LanceDB JavaScript SDK](https://lancedb.github.io/lancedb/js/)
- [SQLite FTS5 and BM25](https://www.sqlite.org/fts5.html)
- [sqlite-vec repository and Node package](https://github.com/asg017/sqlite-vec)
- [Typesense vector and hybrid search](https://typesense.org/docs/latest/api/vector-search.html)
- [Meilisearch hybrid search](https://www.meilisearch.com/docs/learn/ai_powered_search/getting_started_with_ai_search)
- [Qdrant hybrid queries and RRF](https://qdrant.tech/documentation/search/hybrid-queries/)

## Revisit conditions

Reconsider LanceDB, sqlite-vec, Typesense, or Qdrant when the corpus outgrows the bounded snapshot,
embedding cold-start latency becomes visible, or labeled evaluation shows better quality per unit
of operational cost. Any replacement remains behind the same versioned, fail-open adapter.
