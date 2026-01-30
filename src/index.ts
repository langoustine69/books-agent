import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const OPEN_LIBRARY_BASE = 'https://openlibrary.org';

const agent = await createAgent({
  name: 'books-agent',
  version: '1.0.0',
  description: 'Open Library book data API - search, lookup, authors, subjects, and covers. Real-time access to millions of books.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON from Open Library ===
async function fetchOL(path: string) {
  const url = `${OPEN_LIBRARY_BASE}${path}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'BooksAgent/1.0 (langoustine69.dev)' }
  });
  if (!response.ok) throw new Error(`Open Library error: ${response.status}`);
  return response.json();
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - API status and sample search. Try before you buy.',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const sample = await fetchOL('/search.json?q=artificial+intelligence&limit=3');
    return {
      output: {
        status: 'operational',
        dataSource: 'Open Library (openlibrary.org)',
        totalBooks: sample.numFound,
        sampleBooks: sample.docs.map((b: any) => ({
          title: b.title,
          author: b.author_name?.[0] || 'Unknown',
          firstPublished: b.first_publish_year,
          editions: b.edition_count
        })),
        endpoints: {
          free: ['overview'],
          paid: ['lookup', 'search', 'author', 'subjects', 'covers']
        },
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 1: Lookup by ISBN or OLID ($0.001) ===
addEntrypoint({
  key: 'lookup',
  description: 'Look up a book by ISBN-10, ISBN-13, or Open Library ID (e.g., OL7353617M)',
  input: z.object({
    identifier: z.string().describe('ISBN-10, ISBN-13, or Open Library ID'),
    type: z.enum(['isbn', 'olid']).optional().default('isbn')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const { identifier, type } = ctx.input;
    let data;
    
    if (type === 'olid') {
      data = await fetchOL(`/books/${identifier}.json`);
    } else {
      const bibkeys = `ISBN:${identifier}`;
      const response = await fetch(
        `${OPEN_LIBRARY_BASE}/api/books?bibkeys=${bibkeys}&format=json&jscmd=data`,
        { headers: { 'User-Agent': 'BooksAgent/1.0 (langoustine69.dev)' } }
      );
      const result = await response.json();
      data = result[bibkeys] || null;
    }
    
    if (!data) {
      return { output: { found: false, identifier, message: 'Book not found' } };
    }
    
    return {
      output: {
        found: true,
        identifier,
        title: data.title,
        authors: data.authors?.map((a: any) => a.name) || [],
        publishers: data.publishers?.map((p: any) => p.name) || [],
        publishDate: data.publish_date,
        subjects: data.subjects?.slice(0, 10).map((s: any) => s.name) || [],
        cover: data.cover?.medium || null,
        pages: data.number_of_pages,
        identifiers: data.identifiers || {},
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2: Search ($0.002) ===
addEntrypoint({
  key: 'search',
  description: 'Search books by title, author, subject, or general query',
  input: z.object({
    query: z.string().describe('Search query'),
    field: z.enum(['all', 'title', 'author', 'subject']).optional().default('all'),
    limit: z.number().min(1).max(50).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { query, field, limit } = ctx.input;
    const encodedQuery = encodeURIComponent(query);
    
    let searchPath: string;
    if (field === 'title') {
      searchPath = `/search.json?title=${encodedQuery}&limit=${limit}`;
    } else if (field === 'author') {
      searchPath = `/search.json?author=${encodedQuery}&limit=${limit}`;
    } else if (field === 'subject') {
      searchPath = `/search.json?subject=${encodedQuery}&limit=${limit}`;
    } else {
      searchPath = `/search.json?q=${encodedQuery}&limit=${limit}`;
    }
    
    const data = await fetchOL(searchPath);
    
    return {
      output: {
        query,
        field,
        totalResults: data.numFound,
        returned: data.docs.length,
        books: data.docs.map((b: any) => ({
          key: b.key,
          title: b.title,
          authors: b.author_name || [],
          firstPublished: b.first_publish_year,
          editions: b.edition_count,
          languages: b.language?.slice(0, 5) || [],
          coverId: b.cover_i || null,
          hasFulltext: b.has_fulltext || false
        })),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3: Author ($0.002) ===
addEntrypoint({
  key: 'author',
  description: 'Get author information and their works by Open Library author ID or search by name',
  input: z.object({
    query: z.string().describe('Author name to search, or Open Library author ID (e.g., OL26320A)'),
    includeWorks: z.boolean().optional().default(true),
    worksLimit: z.number().min(1).max(50).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { query, includeWorks, worksLimit } = ctx.input;
    
    let authorKey: string;
    let authorData: any;
    
    // Check if it's an author ID or a name search
    if (query.startsWith('OL') && query.endsWith('A')) {
      authorKey = query;
      authorData = await fetchOL(`/authors/${authorKey}.json`);
    } else {
      // Search for author
      const searchData = await fetchOL(`/search/authors.json?q=${encodeURIComponent(query)}&limit=1`);
      if (!searchData.docs || searchData.docs.length === 0) {
        return { output: { found: false, query, message: 'Author not found' } };
      }
      authorKey = searchData.docs[0].key;
      authorData = await fetchOL(`/authors/${authorKey}.json`);
    }
    
    let works: any[] = [];
    if (includeWorks) {
      const worksData = await fetchOL(`/authors/${authorKey}/works.json?limit=${worksLimit}`);
      works = worksData.entries?.map((w: any) => ({
        key: w.key,
        title: w.title,
        firstPublished: w.first_publish_date || null,
        coverId: w.covers?.[0] || null
      })) || [];
    }
    
    return {
      output: {
        found: true,
        key: authorKey,
        name: authorData.name,
        birthDate: authorData.birth_date || null,
        deathDate: authorData.death_date || null,
        bio: typeof authorData.bio === 'string' ? authorData.bio : authorData.bio?.value || null,
        photoIds: authorData.photos?.slice(0, 3) || [],
        works: works,
        worksCount: works.length,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4: Subjects ($0.002) ===
addEntrypoint({
  key: 'subjects',
  description: 'Get books by subject/topic (e.g., "machine_learning", "science_fiction")',
  input: z.object({
    subject: z.string().describe('Subject name (use underscores for spaces, e.g., "artificial_intelligence")'),
    limit: z.number().min(1).max(50).optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { subject, limit } = ctx.input;
    const normalizedSubject = subject.toLowerCase().replace(/ /g, '_');
    
    const data = await fetchOL(`/subjects/${normalizedSubject}.json?limit=${limit}`);
    
    if (!data.works || data.works.length === 0) {
      return { output: { found: false, subject, message: 'No books found for this subject' } };
    }
    
    return {
      output: {
        subject: data.name,
        totalWorks: data.work_count,
        returned: data.works.length,
        books: data.works.map((w: any) => ({
          key: w.key,
          title: w.title,
          authors: w.authors?.map((a: any) => a.name) || [],
          firstPublished: w.first_publish_year,
          coverId: w.cover_id || null,
          editionCount: w.edition_count
        })),
        relatedSubjects: data.subjects?.slice(0, 10) || [],
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5: Covers ($0.003) ===
addEntrypoint({
  key: 'covers',
  description: 'Get book cover URLs by ISBN, Open Library ID, or cover ID. Returns multiple sizes.',
  input: z.object({
    identifier: z.string().describe('ISBN, Open Library ID, or cover ID'),
    type: z.enum(['isbn', 'olid', 'id']).optional().default('isbn')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const { identifier, type } = ctx.input;
    
    const coverBase = 'https://covers.openlibrary.org/b';
    let keyType: string;
    
    if (type === 'isbn') {
      keyType = 'isbn';
    } else if (type === 'olid') {
      keyType = 'olid';
    } else {
      keyType = 'id';
    }
    
    // Generate URLs for all sizes
    const sizes = ['S', 'M', 'L'];
    const covers = sizes.reduce((acc, size) => {
      acc[size.toLowerCase()] = `${coverBase}/${keyType}/${identifier}-${size}.jpg`;
      return acc;
    }, {} as Record<string, string>);
    
    // Verify the cover exists by checking the medium size
    const checkResponse = await fetch(covers.m, { method: 'HEAD' });
    const exists = checkResponse.ok && checkResponse.headers.get('content-length') !== '43'; // 43 bytes = blank image
    
    return {
      output: {
        identifier,
        type,
        exists,
        covers: exists ? covers : null,
        message: exists ? 'Cover found' : 'No cover available for this identifier',
        usage: 'Use these URLs directly in img tags or download',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`📚 Books Agent running on port ${port}`);

export default { port, fetch: app.fetch };
