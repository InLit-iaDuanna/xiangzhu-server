import { readFile } from 'node:fs/promises';
export type KnowledgeEntry = {
  id: string;
  title: string;
  source_title: string;
  source_path: string;
  locator: string;
  text: string;
  category: string;
  authority: string;
  verified: boolean;
};
export async function knowledgeEntries(): Promise<KnowledgeEntry[]> {
  try {
    return JSON.parse(
      await readFile(
        process.env.KNOWLEDGE_PATH ?? 'work/knowledge.json',
        'utf8',
      ),
    );
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
export async function searchKnowledge(query: string, limit = 6) {
  const entries = await knowledgeEntries();
  const terms = [
    ...new Set(
      query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/g) ?? [],
    ),
  ];
  return entries
    .map((e) => ({
      e,
      score: terms.reduce(
        (sum, t) =>
          sum +
          (e.title.includes(t) ? 3 : 0) +
          (e.text.toLowerCase().includes(t) ? 1 : 0),
        0,
      ),
    }))
    .filter((x) => !query.trim() || x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.e.id.localeCompare(b.e.id, undefined, { numeric: true }),
    )
    .slice(0, limit)
    .map(({ e }) => {
      const { source_path, ...publicEntry } = e;
      return publicEntry;
    });
}
