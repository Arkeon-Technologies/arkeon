// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ArkeInstanceClient } from './arke-client'
import type { ArkeEntity, ArkeRelationship, ActivityItem, ArkeActor, ArkeComment } from './arke-types'

// ---------------------------------------------------------------------------
// Fixture data: a small but realistic knowledge graph
// ---------------------------------------------------------------------------

const ENTITY_TYPES = ['person', 'organization', 'concept', 'event', 'document', 'place'] as const
const PREDICATES = ['relates_to', 'references', 'created_by', 'contains', 'influenced', 'enables'] as const

function makeId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`
}

function makeEntity(id: string, type: string, label: string, spaceIds?: string[]): ArkeEntity {
  return {
    id,
    kind: 'entity',
    type,
    properties: { label, description: `Mock ${type}: ${label}` },
    ver: 1,
    created_at: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString(),
    updated_at: new Date().toISOString(),
    space_ids: spaceIds,
  }
}

let relCounter = 0
function makeRel(sourceId: string, targetId: string, predicate: string): ArkeRelationship {
  relCounter++
  return {
    id: makeId('rel', relCounter),
    predicate,
    source_id: sourceId,
    target_id: targetId,
    properties: {},
  }
}

// Build entities
const entities: ArkeEntity[] = []
const relationships: ArkeRelationship[] = []

// People
const people = [
  'Alan Turing', 'Ada Lovelace', 'Grace Hopper', 'John von Neumann',
  'Claude Shannon', 'Hedy Lamarr', 'Tim Berners-Lee', 'Vint Cerf',
  'Barbara Liskov', 'Donald Knuth', 'Linus Torvalds', 'Margaret Hamilton',
]
for (let i = 0; i < people.length; i++) {
  entities.push(makeEntity(makeId('person', i), 'person', people[i]))
}

// Organizations
const orgs = [
  'MIT', 'Bell Labs', 'DARPA', 'Bletchley Park', 'CERN', 'Stanford',
  'IBM', 'Google', 'Microsoft', 'Apple',
]
for (let i = 0; i < orgs.length; i++) {
  entities.push(makeEntity(makeId('org', i), 'organization', orgs[i], ['space-academia']))
}

// Concepts
const concepts = [
  'Computation', 'Cryptography', 'Networking', 'Programming Languages',
  'Operating Systems', 'Artificial Intelligence', 'Information Theory',
  'Software Engineering', 'Compilers', 'Algorithms', 'Distributed Systems',
  'Machine Learning', 'Computer Vision', 'Natural Language Processing',
]
for (let i = 0; i < concepts.length; i++) {
  entities.push(makeEntity(makeId('concept', i), 'concept', concepts[i]))
}

// Events
const events = [
  'Invention of the Transistor', 'First Moon Landing Computer', 'Creation of ARPANET',
  'Publication of TCP/IP', 'Launch of the World Wide Web', 'Release of Linux',
  'Deep Blue vs Kasparov', 'AlphaGo vs Lee Sedol',
]
for (let i = 0; i < events.length; i++) {
  entities.push(makeEntity(makeId('event', i), 'event', events[i]))
}

// Documents
const docs = [
  'On Computable Numbers (1936)', 'A Mathematical Theory of Communication (1948)',
  'The Art of Computer Programming', 'Design Patterns', 'The Mythical Man-Month',
  'Structure and Interpretation of Computer Programs',
]
for (let i = 0; i < docs.length; i++) {
  entities.push(makeEntity(makeId('doc', i), 'document', docs[i]))
}

// Places
const places = [
  'Cambridge, UK', 'Princeton, NJ', 'Silicon Valley', 'Geneva, Switzerland',
  'Seattle, WA', 'Cupertino, CA',
]
for (let i = 0; i < places.length; i++) {
  entities.push(makeEntity(makeId('place', i), 'place', places[i]))
}

// Build relationships — create a connected graph
// People → Organizations
relationships.push(makeRel(makeId('person', 0), makeId('org', 3), 'created_by'))  // Turing → Bletchley
relationships.push(makeRel(makeId('person', 1), makeId('org', 0), 'relates_to'))  // Lovelace → MIT (anachronistic but fine for demo)
relationships.push(makeRel(makeId('person', 2), makeId('org', 1), 'created_by'))  // Hopper → Bell Labs
relationships.push(makeRel(makeId('person', 3), makeId('org', 5), 'relates_to'))  // von Neumann → Stanford
relationships.push(makeRel(makeId('person', 4), makeId('org', 1), 'created_by'))  // Shannon → Bell Labs
relationships.push(makeRel(makeId('person', 6), makeId('org', 4), 'created_by'))  // Berners-Lee → CERN
relationships.push(makeRel(makeId('person', 7), makeId('org', 2), 'relates_to'))  // Cerf → DARPA
relationships.push(makeRel(makeId('person', 8), makeId('org', 0), 'created_by'))  // Liskov → MIT
relationships.push(makeRel(makeId('person', 9), makeId('org', 5), 'created_by'))  // Knuth → Stanford
relationships.push(makeRel(makeId('person', 10), makeId('org', 6), 'relates_to')) // Torvalds → IBM (loose)
relationships.push(makeRel(makeId('person', 11), makeId('org', 0), 'created_by')) // Hamilton → MIT

// People → Concepts
relationships.push(makeRel(makeId('person', 0), makeId('concept', 0), 'influenced'))  // Turing → Computation
relationships.push(makeRel(makeId('person', 0), makeId('concept', 1), 'influenced'))  // Turing → Cryptography
relationships.push(makeRel(makeId('person', 0), makeId('concept', 5), 'influenced'))  // Turing → AI
relationships.push(makeRel(makeId('person', 4), makeId('concept', 6), 'influenced'))  // Shannon → Information Theory
relationships.push(makeRel(makeId('person', 6), makeId('concept', 2), 'influenced'))  // Berners-Lee → Networking
relationships.push(makeRel(makeId('person', 7), makeId('concept', 2), 'influenced'))  // Cerf → Networking
relationships.push(makeRel(makeId('person', 8), makeId('concept', 3), 'influenced'))  // Liskov → PL
relationships.push(makeRel(makeId('person', 9), makeId('concept', 9), 'influenced'))  // Knuth → Algorithms
relationships.push(makeRel(makeId('person', 9), makeId('concept', 8), 'influenced'))  // Knuth → Compilers
relationships.push(makeRel(makeId('person', 10), makeId('concept', 4), 'influenced')) // Torvalds → OS
relationships.push(makeRel(makeId('person', 11), makeId('concept', 7), 'influenced')) // Hamilton → SW Engineering
relationships.push(makeRel(makeId('person', 2), makeId('concept', 3), 'influenced'))  // Hopper → PL
relationships.push(makeRel(makeId('person', 3), makeId('concept', 0), 'influenced'))  // von Neumann → Computation

// Concepts → Concepts
relationships.push(makeRel(makeId('concept', 5), makeId('concept', 11), 'enables'))   // AI → ML
relationships.push(makeRel(makeId('concept', 11), makeId('concept', 12), 'enables'))  // ML → Computer Vision
relationships.push(makeRel(makeId('concept', 11), makeId('concept', 13), 'enables'))  // ML → NLP
relationships.push(makeRel(makeId('concept', 0), makeId('concept', 9), 'relates_to')) // Computation → Algorithms
relationships.push(makeRel(makeId('concept', 3), makeId('concept', 8), 'relates_to')) // PL → Compilers
relationships.push(makeRel(makeId('concept', 2), makeId('concept', 10), 'enables'))   // Networking → Distributed Systems
relationships.push(makeRel(makeId('concept', 6), makeId('concept', 1), 'relates_to')) // Info Theory → Cryptography

// Events → People/Concepts
relationships.push(makeRel(makeId('event', 0), makeId('org', 1), 'relates_to'))       // Transistor → Bell Labs
relationships.push(makeRel(makeId('event', 1), makeId('person', 11), 'relates_to'))   // Moon Landing → Hamilton
relationships.push(makeRel(makeId('event', 2), makeId('person', 7), 'relates_to'))    // ARPANET → Cerf
relationships.push(makeRel(makeId('event', 2), makeId('concept', 2), 'relates_to'))   // ARPANET → Networking
relationships.push(makeRel(makeId('event', 3), makeId('person', 7), 'relates_to'))    // TCP/IP → Cerf
relationships.push(makeRel(makeId('event', 4), makeId('person', 6), 'relates_to'))    // WWW → Berners-Lee
relationships.push(makeRel(makeId('event', 4), makeId('org', 4), 'relates_to'))       // WWW → CERN
relationships.push(makeRel(makeId('event', 5), makeId('person', 10), 'relates_to'))   // Linux → Torvalds
relationships.push(makeRel(makeId('event', 6), makeId('concept', 5), 'relates_to'))   // Deep Blue → AI
relationships.push(makeRel(makeId('event', 7), makeId('concept', 11), 'relates_to'))  // AlphaGo → ML
relationships.push(makeRel(makeId('event', 7), makeId('org', 7), 'relates_to'))       // AlphaGo → Google

// Documents → People/Concepts
relationships.push(makeRel(makeId('doc', 0), makeId('person', 0), 'created_by'))  // On Computable Numbers → Turing
relationships.push(makeRel(makeId('doc', 0), makeId('concept', 0), 'references')) // → Computation
relationships.push(makeRel(makeId('doc', 1), makeId('person', 4), 'created_by'))  // Math Theory Comm → Shannon
relationships.push(makeRel(makeId('doc', 1), makeId('concept', 6), 'references')) // → Info Theory
relationships.push(makeRel(makeId('doc', 2), makeId('person', 9), 'created_by'))  // TAOCP → Knuth
relationships.push(makeRel(makeId('doc', 2), makeId('concept', 9), 'references')) // → Algorithms
relationships.push(makeRel(makeId('doc', 4), makeId('concept', 7), 'references')) // Mythical Man-Month → SW Eng
relationships.push(makeRel(makeId('doc', 5), makeId('concept', 3), 'references')) // SICP → PL

// Places
relationships.push(makeRel(makeId('place', 0), makeId('org', 3), 'contains'))     // Cambridge → Bletchley
relationships.push(makeRel(makeId('place', 1), makeId('org', 5), 'contains'))     // Princeton → Stanford (wrong but demo)
relationships.push(makeRel(makeId('place', 2), makeId('org', 7), 'contains'))     // Silicon Valley → Google
relationships.push(makeRel(makeId('place', 2), makeId('org', 9), 'contains'))     // Silicon Valley → Apple
relationships.push(makeRel(makeId('place', 3), makeId('org', 4), 'contains'))     // Geneva → CERN
relationships.push(makeRel(makeId('place', 4), makeId('org', 8), 'contains'))     // Seattle → Microsoft
relationships.push(makeRel(makeId('place', 5), makeId('org', 9), 'contains'))     // Cupertino → Apple

// ---------------------------------------------------------------------------
// Index for fast lookup
// ---------------------------------------------------------------------------

const entityMap = new Map<string, ArkeEntity>()
for (const e of entities) entityMap.set(e.id, e)

// Relationship entities — in the real API, relationships are also entities with kind='relationship'
const relMap = new Map<string, ArkeRelationship>()
for (const rel of relationships) {
  relMap.set(rel.id, rel)
  const source = entityMap.get(rel.source_id)
  const target = entityMap.get(rel.target_id)
  entityMap.set(rel.id, {
    id: rel.id,
    kind: 'relationship',
    type: rel.predicate,
    properties: {
      label: `${(source?.properties?.label as string) ?? rel.source_id} → ${(target?.properties?.label as string) ?? rel.target_id}`,
      predicate: rel.predicate,
    },
    ver: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
}

const relsByEntity = new Map<string, ArkeRelationship[]>()
for (const rel of relationships) {
  const srcRels = relsByEntity.get(rel.source_id) ?? []
  srcRels.push(rel)
  relsByEntity.set(rel.source_id, srcRels)

  const tgtRels = relsByEntity.get(rel.target_id) ?? []
  tgtRels.push(rel)
  relsByEntity.set(rel.target_id, tgtRels)
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function delay(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createMockClient(): ArkeInstanceClient {
  return {
    async listEntities(options) {
      await delay()
      const limit = options?.limit ?? 200
      const all = entities.filter(e => e.kind !== 'relationship')
      return { entities: all.slice(0, limit), cursor: null }
    },

    async getEntity(id: string) {
      await delay()
      const e = entityMap.get(id)
      if (!e) throw new Error(`Entity not found: ${id}`)
      return e
    },

    async getRelationships(id: string) {
      await delay()
      const rels = relsByEntity.get(id) ?? []
      return { relationships: rels, outCursor: null, inCursor: null, hasMore: false }
    },

    async getMoreRelationships() {
      return { relationships: [], outCursor: null, inCursor: null, hasMore: false }
    },

    async getEntityTip(id: string) {
      return { cid: `mock-cid-${id}` }
    },

    async getRelationship(relId: string) {
      await delay()
      const rel = relMap.get(relId)
      if (!rel) throw new Error(`Relationship not found: ${relId}`)
      const source = entityMap.get(rel.source_id)
      const target = entityMap.get(rel.target_id)
      return {
        ...rel,
        source: source ? { id: source.id, kind: source.kind, type: source.type, properties: source.properties } : undefined,
        target: target ? { id: target.id, kind: target.kind, type: target.type, properties: target.properties } : undefined,
      }
    },

    async getActor() {
      return { id: 'actor-mock', kind: 'user', properties: { label: 'Mock User' }, status: 'active' }
    },

    async getComments() {
      return { comments: [], cursor: null }
    },

    async getActivity() {
      return { activity: [], cursor: null }
    },

    async getActivitySince() {
      return { activity: [], cursor: null }
    },
  }
}
